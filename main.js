const subtle = crypto.subtle;

// Fun fact: Because Nakamoto decided to make the very exotic decision of
// interpreting the hash as a little-endian number, the zeros are actually at
// the *end* of the SHA2 output. Because of this, most bitcoin software displays
// the same number but in big-endian, since that's how humans write numbers. As
// a result, the displayed value ends up being the inverse of the hash output.
const SALT = bytes("00000000000000000004bac129769598d1fad2b42859e625729661a32b9c3e71");
const SHORTCUT_FACTOR = 1000;
const API_URL = "wss://bustakrist.its-em.ma/api/sock?v=2";
const GAMES_SIZE = 64;
let lastVerifiedGame = {
    id: 0,
    hash: "c785b196c489201dbf43eb3ef0aa8bd9d708864cc5524d68fec220486a39b2d8",
};
let shortcutObj = {};
let socket;

function bytes(str) {
    const encoder = new TextEncoder;
    return encoder.encode(str);
}

function hex(buf) {
    let arr = new Uint8Array(buf);
    let result = [];
    for (let i = 0; i < arr.length; i++) {
        const long = "00" + arr[i].toString(16);
        result.push(long.slice(-2));
    }

    return result.join("")
}

function fromHex(hex) {
    let arr = [];
    for (let i = 0; i < hex.length; i += 2) {
        arr.push(parseInt(hex.slice(i, i + 2), 16));
    }

    return new Uint8Array(arr);
}

async function hash(seed) {
    return await subtle.digest("SHA-256", seed);
}

async function gameResult(seed) {
    const nBits = 52;
    const params = {name: "HMAC", hash: "SHA-256", length: 512};
    const saltKey = await subtle.importKey("raw", SALT, params, true, ["sign"]);
    const seedDigest = hex(await subtle.sign("HMAC", saltKey, seed));

    const seedBits = seedDigest.slice(0, nBits / 4);
    const r = parseInt(seedBits, 16);

    const xr = r / Math.pow(2, nBits);
    const xh = 99 / (1 - xr);

    return Math.max(Math.floor(xh), 100);
}

function formObj(arr) {
    let result = {};
    for (i in arr) {
        result[arr[i].name] = arr[i].value;
    }

    return result;
}

function isCheckpoint(id) {
    return id % SHORTCUT_FACTOR == SHORTCUT_FACTOR - 1;
}

async function verify(game, statusFunction) {
    let lastHash = fromHex(game.hash);

    // Verify current game
    if (await gameResult(lastHash) != game.bust) {
        return false;
    }

    // Verify game chain until last verified, adding checkpoints as needed
    for (let id = game.id; id > lastVerifiedGame.id; id--) {
        if (isCheckpoint(id)) {
            shortcutObj[id] = lastHash;
        }

        if (id % 1000 == 999) {
            const pct = Math.floor(10000 * (game.id - id) / game.id) / 100;
            statusFunction(pct);
        }

        lastHash = await hash(lastHash);
    }
    if (hex(lastHash) != lastVerifiedGame.hash) {
        return false;
    }

    // Remove checkpoint from last verified if misaligned
    if (!isCheckpoint(lastVerifiedGame.id)) {
        delete shortcutObj[lastVerifiedGame.id];
    }

    // Add misaligned checkpoint for new, set new as last verified
    shortcutObj[game.id] = fromHex(game.hash);
    lastVerifiedGame = game;

    return true;
}

async function buildGames(start, length) {
    const end = Math.max(start - length, 0);
    let lastId = start;

    while (!shortcutObj[lastId]) {
        lastId++;
    }

    let lastHash = shortcutObj[lastId];
    let result = [];

    for (let id = lastId; id > start; id--) {
        lastHash = await hash(lastHash);
    }

    for (let id = start; id > end; id--) {
        result.push({
            id: id,
            hash: hex(lastHash),
            bust: await gameResult(lastHash),
        });
        lastHash = await hash(lastHash);
    }

    return result;
}

function reportError(errorMsg) {
    $("#jump").hide();
    $("#status")
        .show()
        .text(errorMsg)
        .css("color", "#f44");
}

function wrapMessageHandler(handler) {
    return function(message) {
        const data = JSON.parse(message.data);
        if (!data.ok) {
            reportError(`BustAKrist returned an error: "${data.error}".`);
            socket.close();
        } else {
            handler(data);
        }
    }
}

function row(game) {
    return `<tr>
                <td>${game.id}</td>
                <td class="hash">${game.hash}</td>
                <td>${(game.bust / 100).toFixed(2)}×</td>
            </tr>`;
}

async function onHashChange() {
    let start = parseInt(location.hash.slice(1)) || lastVerifiedGame.id;
    start = Math.max(start, 0);
    start = Math.min(start, lastVerifiedGame.id);
    const games = await buildGames(start, GAMES_SIZE);

    $("#games table tr:gt(0)").remove();
    for (i = 0; i < games.length; i++) {
        $("#games table").append(row(games[i]));
    }
}

let receivedGameId = null;
async function messageHandler(data) {
    if (data.type == "GAME_STARTING") {
        receivedGameId = data.data.gameid;
    } else if (data.type == "BUSTED") {
        const game = {
            hash: data.data.hash,
            bust: data.data.bust,
            id: receivedGameId || lastVerifiedGame.id + 1,
        };
        const nextGameAssumed = !receivedGameId;
        const isNextGame = game.id == lastVerifiedGame.id + 1;

        const valid = await verify(game, () => {});
        if (!valid && !nextGameAssumed) {
            reportError(`Server published an invalid game! (${game.id})`);
            socket.close();
            return;
        }

        if (location.hash.slice(1) != "") {
            return;
        }

        if (isNextGame) {
            $("#games table tr:last").remove();
            $("#games table tr:first").after(row(game));
        } else {
            await onHashChange();
        }
    }
}

async function waitForHistory(data) {
    if (data.type == "HISTORY") {
        const game = {
            hash: data.data.history[0].hash,
            bust: data.data.history[0].bust,
            id: data.data.history[0].id,
        };

        const valid = await verify(game, function(pct) {
            $("#status").text(`Verifying... (${pct}%)`);
        });
        if (!valid) {
            reportError("The game chain is not valid!");
            socket.close();
            return;
        }

        await onHashChange();        

        $("#status").hide();
        $("#jump").show();

        window.addEventListener("hashchange", onHashChange);
        socket.onmessage = wrapMessageHandler(messageHandler);
    }
}

$(function() {
    socket = new WebSocket(API_URL);
    socket.onmessage = wrapMessageHandler(waitForHistory);

    $("#jump").submit(function(event) {
        event.preventDefault();
        const data = formObj($("#jump").serializeArray());
        location.hash = data.game;
    });
})
