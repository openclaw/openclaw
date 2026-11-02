// Binding contract without network services: exported API shape (identical to the tailcat spike
// binding the Gateway tunnel worker consumes), direct own <-> own data integrity, admission
// identity, numeric close codes and stream reset codes. Runs on every CI platform.
"use strict";
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { test } = require("node:test");
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
