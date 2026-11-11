// Binding contract without network services: exported API shape (identical to the tailcat spike
// binding the Gateway tunnel worker consumes), direct own <-> own data integrity, admission
// identity, numeric close codes and stream reset codes. Runs on every CI platform.
"use strict";
const assert = require("node:assert/strict");
const { execFile } = require("node:child_process");
const crypto = require("node:crypto");
const { test } = require("node:test");
const { promisify } = require("node:util");
const binding = require("../index.js");
const { load, loopbackAddrs } = require("./support/adapters.cjs");
const { ALPN, serveEndpoint, echo } = require("./support/proto.cjs");

// Public JS API; any change here is a contract change for the Gateway tunnel worker.
const API = {
  Endpoint: [
    "accept",
    "boundSockets",
    "close",
    "connect",
    "homeRelayStatus",
    "id",
    "online",
    "watchHomeRelay",
  ],
  HomeRelayWatcher: ["next"],
  Connection: [
    "acceptBi",
    "close",
    "closed",
    "openBi",
    "pathKind",
    "remoteId",
    "rttMs",
    "setMaxConcurrentBiStreams",
  ],
  SendStream: ["finish", "reset", "write"],
  RecvStream: ["read", "stop"],
};

// Binds a server (accepting ALPN) and a client, both with relays disabled, and dials directly.
async function directPair() {
  const server = await binding.bind({ secretKey: crypto.randomBytes(32), alpns: [ALPN] });
  const client = await binding.bind({ secretKey: crypto.randomBytes(32) });
  const accepted = server.accept();
  const conn = await client.connect(server.id(), ALPN, {
    directAddrs: loopbackAddrs(server.boundSockets()),
  });
  return { server, client, conn, sconn: await accepted };
}

test("exports the spike binding API", () => {
  assert.equal(typeof binding.bind, "function");
  for (const [cls, methods] of Object.entries(API)) {
    const own = Object.getOwnPropertyNames(binding[cls].prototype).filter(
      (n) => n !== "constructor",
    );
    assert.deepEqual(own.toSorted(), methods, cls);
  }
});

test("rejects a secret key that is not 32 bytes", async () => {
  await assert.rejects(binding.bind({ secretKey: new Uint8Array(31) }), /32 bytes/);
});

for (const pending of [true, false]) {
  test(`home relay watcher ends and Node exits with a ${pending ? "pending" : "later"} next`, async () => {
    // A stuck native promise keeps Node alive even after JS finishes. Isolate it so the
    // parent can bound the regression without forcing a successful child's exit.
    const { stdout } = await promisify(execFile)(
      process.execPath,
      [
        "-e",
        `
        const assert = require("node:assert/strict");
        const { bind } = require(${JSON.stringify(require.resolve("../index.js"))});
        (async () => {
          const endpoint = await bind({ secretKey: require("node:crypto").randomBytes(32) });
          const watcher = await endpoint.watchHomeRelay();
          assert.deepEqual(await watcher.next(), []);
          const next = ${pending} ? watcher.next() : undefined;
          await endpoint.close();
          console.log("endpoint closed");
          assert.equal(await (next ?? watcher.next()), null);
          assert.equal(await watcher.next(), null);
          console.log("watcher ended");
        })().catch((error) => {
          console.error(error);
          process.exitCode = 1;
        });
      `,
      ],
      { timeout: 10000 },
    );
    assert.equal(stdout.replaceAll("\r\n", "\n"), "endpoint closed\nwatcher ended\n");
  });
}

test("direct echo keeps every byte and reports the authenticated peer", async () => {
  const own = load("own");
  const server = await own.bind({ secretKey: crypto.randomBytes(32), alpns: [ALPN] });
  const serving = serveEndpoint(server);
  const client = await own.bind({ secretKey: crypto.randomBytes(32) });
  try {
    const conn = await client.connect(server.id(), ALPN, { directAddrs: server.directAddrs() });
    assert.equal(conn.remoteId(), server.id());
    assert.match(server.id(), /^[0-9a-f]{64}$/);
    const r = await echo(conn, 4 << 20);
    assert.equal(r.received, r.sent);
    assert.equal(conn.pathKind(), "direct");
    assert.equal(typeof conn.raw.rttMs(), "number");
  } finally {
    await client.close();
    await server.close();
    await serving;
  }
});

test("server sees the client's authenticated id", async () => {
  const { server, client, sconn } = await directPair();
  try {
    assert.equal(sconn.remoteId(), client.id());
  } finally {
    await client.close();
    await server.close();
  }
});

test("application close code and reason reach the peer", async () => {
  const { server, client, conn, sconn } = await directPair();
  try {
    sconn.close(1, "not a member");
    assert.deepEqual(
      { ...(await conn.closed()) },
      {
        code: 1,
        reason: "not a member",
        kind: "application",
      },
    );
  } finally {
    await client.close();
    await server.close();
  }
});

test("stream reset code is visible to the reader", async () => {
  const { server, client, conn, sconn } = await directPair();
  try {
    const peerStream = sconn.acceptBi();
    const { send } = await conn.openBi();
    await send.write(Buffer.from("x"));
    const { recv } = await peerStream;
    assert.equal((await recv.read(1)).toString(), "x");
    await send.reset(3);
    await assert.rejects(recv.read(16), /3/);
  } finally {
    await client.close();
    await server.close();
  }
});

// Fails instead of hanging when an operation that must not wait on the peer does wait.
function within(promise, ms, what) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} still pending after ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// Opens a stream from the client and returns both ends once the server has accepted it.
async function openedStream(conn, sconn) {
  const peerStream = sconn.acceptBi();
  const local = await conn.openBi();
  await local.send.write(Buffer.from("x"));
  const peer = await peerStream;
  assert.equal((await peer.recv.read(1)).toString(), "x");
  return { local, peer };
}

// Proves the connection still carries a fresh stream end to end.
async function assertConnectionUsable(conn, sconn) {
  const { local, peer } = await openedStream(conn, sconn);
  await peer.send.write(Buffer.from("ok"));
  await peer.send.finish();
  assert.equal((await within(local.recv.read(16), 2000, "read")).toString(), "ok");
}

test("stop interrupts a read the peer never answers", async () => {
  const { server, client, conn, sconn } = await directPair();
  try {
    const { local, peer } = await openedStream(conn, sconn);
    // The server keeps its sending half open and silent, so this read cannot complete.
    const pending = assert.rejects(local.recv.read(16), /stopped/);
    await within(local.recv.stop(7), 2000, "stop");
    await pending;
    // STOP_SENDING reaches the peer asynchronously; its writes start failing once it arrives.
    await within(writeUntilStopped(peer.send), 2000, "peer observing stop");
    await assertConnectionUsable(conn, sconn);
  } finally {
    await client.close();
    await server.close();
  }
});

test("reset abandons a write the peer never reads", async () => {
  const { server, client, conn, sconn } = await directPair();
  try {
    const { local, peer } = await openedStream(conn, sconn);
    // Far beyond the stream's flow-control window while the server reads nothing.
    const pending = assert.rejects(local.send.write(Buffer.alloc(64 << 20)), /reset/);
    await within(local.send.reset(5), 2000, "reset");
    await pending;
    await assert.rejects(within(drain(peer.recv), 2000, "peer read"), /5/);
    await assertConnectionUsable(conn, sconn);
  } finally {
    await client.close();
    await server.close();
  }
});

// Reads until end of stream or error.
async function drain(recv) {
  while ((await recv.read(1 << 20)) !== null) {}
}

// Keeps writing small chunks until the peer's STOP_SENDING arrives and a write rejects with code 7.
async function writeUntilStopped(send) {
  for (;;) {
    try {
      await send.write(Buffer.from("late"));
    } catch (error) {
      assert.match(String(error), /7/);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
