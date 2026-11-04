// Wire compatibility through a local dev iroh-relay 1.4.1 (own port, own tmp dir):
//   - this binding <-> @number0/iroh, both directions, relay and direct paths, close codes;
//   - this binding -> the tailcat spike's Rust tunnel-testserver (openclaw/tunnel/0, relay-only).
// Each group skips when its dependency is missing: IROH_RELAY_BIN (or ~/.cargo/bin/iroh-relay),
// @number0/iroh (resolvable or under IROH_NUMBER0_DIR), TUNNEL_TESTSERVER_BIN.
"use strict";
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { after, before, describe, test } = require("node:test");
const { setTimeout: delay } = require("node:timers/promises");
const { load, hasNumber0 } = require("./support/adapters.cjs");
const { relayBin, startRelay, stopChild } = require("./support/procs.cjs");
const { ALPN, serveEndpoint, echo, sha256 } = require("./support/proto.cjs");

const TESTSERVER = process.env.TUNNEL_TESTSERVER_BIN;
const TUNNEL_ALPN = Buffer.from("openclaw/tunnel/0");
const noRelay = relayBin() ? false : "iroh-relay not found (set IROH_RELAY_BIN)";

describe("compat via a local iroh-relay", { skip: noRelay }, () => {
  let relay;
  before(async () => {
    relay = await startRelay();
  });
  after(async () => {
    await relay?.stop();
  });

  test("own <-> own via relay only", () => pairing(relay.url, "own", "own", "relay"));

  const noNumber0 = hasNumber0() ? false : "@number0/iroh not installed";
  for (const [sb, cb] of [
    ["number0", "own"],
    ["own", "number0"],
  ]) {
    for (const p of ["relay", "direct"]) {
      test(`${cb} client -> ${sb} server via ${p}: 4 MiB echo`, { skip: noNumber0 }, () =>
        pairing(relay.url, sb, cb, p),
      );
    }
    test(`${sb} server close (1, "not a member") reaches ${cb} client`, { skip: noNumber0 }, () =>
      closeCode(relay.url, sb, cb),
    );
  }

  describe(
    "tunnel-testserver",
    { skip: TESTSERVER ? false : "TUNNEL_TESTSERVER_BIN unset" },
    () => {
      let ts;
      let ep;
      let conn;
      before(async () => {
        ts = await startTestserver(relay.url);
        ep = await load("own").bind({
          secretKey: crypto.randomBytes(32),
          relayUrl: relay.url,
          ipTransports: false,
        });
        fs.writeFileSync(path.join(ts.dir, "allow.txt"), ep.id() + "\n");
        conn = (await ep.connect(ts.desc.endpointId, TUNNEL_ALPN, { relayUrl: ts.desc.relayUrl }))
          .raw;
      });
      after(async () => {
        conn?.close(0, "done");
        await ep?.close();
        await ts?.stop();
      });

      test("GET /claw/hello -> 200 JSON", async () => {
        const r = await tunnelFetch(conn, { path: "/claw/hello" });
        assert.equal(r.head.status, 200);
        assert.equal(JSON.parse(r.body).ok, true);
        assert.equal(conn.pathKind(), "relay");
      });

      test("GET /claw/blob 5 MiB, every byte = i % 251", async () => {
        const n = 5 << 20;
        const r = await tunnelFetch(conn, { path: "/claw/blob?n=" + n });
        assert.equal(r.body.length, n);
        for (let i = 0; i < n; i++) {
          if (r.body[i] !== i % 251) {
            throw new Error("byte " + i);
          }
        }
      });

      test("POST /claw/echo 3 MiB intact", async () => {
        const data = crypto.randomBytes(3 << 20);
        const r = await tunnelFetch(conn, { method: "POST", path: "/claw/echo" }, data);
        assert.equal(sha256(r.body), sha256(data));
      });

      test("/claw/fail -> stream reset code 3", async () => {
        await assert.rejects(tunnelFetch(conn, { path: "/claw/fail" }), /3/);
      });

      test("WS echo: text, binary, close", async () => {
        const { send, recv } = await conn.openBi();
        await send.write(
          frame(Buffer.from(JSON.stringify({ kind: "ws", path: "/claw", headers: [] }))),
        );
        const fr = new Frames(recv);
        assert.equal(JSON.parse((await fr.next()).toString()).status, 101);
        await send.write(frame(Buffer.concat([Buffer.from([1]), Buffer.from("hello")])));
        assert.equal((await fr.next()).toString("utf8", 1), "hello");
        const bin = crypto.randomBytes(100000);
        await send.write(frame(Buffer.concat([Buffer.from([2]), bin])));
        assert.equal(sha256((await fr.next()).subarray(1)), sha256(bin));
        await send.write(frame(Buffer.from([8, 3, 232])));
        assert.equal((await fr.next())[0], 8);
        await send.finish();
      });

      test('nonmember is closed with code 1 "not a member"', async () => {
        const other = await load("own").bind({
          secretKey: crypto.randomBytes(32),
          relayUrl: relay.url,
          ipTransports: false,
        });
        try {
          const c = await other.connect(ts.desc.endpointId, TUNNEL_ALPN, {
            relayUrl: ts.desc.relayUrl,
          });
          const info = await c.closed();
          assert.equal(info.code, 1);
          assert.equal(info.reason, "not a member");
        } finally {
          await other.close();
        }
      });

      test("wrong server key (decoy descriptor) fails the dial", async () => {
        const decoy = JSON.parse(
          fs.readFileSync(path.join(ts.dir, "decoy-descriptor.json"), "utf8"),
        );
        const dial = ep.connect(decoy.endpointId, TUNNEL_ALPN, { relayUrl: relay.url });
        const timeout = delay(8000).then(() => {
          throw new Error("timeout (no such endpoint)");
        });
        await assert.rejects(Promise.race([dial, timeout]));
      });
    },
  );
});

// One echo pairing: server binding sb, client binding cb, path "relay" | "direct". Relay-only is
// enforced on whichever side is this binding (@number0/iroh cannot clear IP transports).
async function pairing(relayUrl, sb, cb, p) {
  const server = await load(sb).bind({
    secretKey: crypto.randomBytes(32),
    relayUrl,
    alpns: [ALPN],
    ipTransports: p === "relay" && sb === "own" ? false : undefined,
  });
  await server.online();
  const serving = serveEndpoint(server);
  const client = await load(cb).bind({
    secretKey: crypto.randomBytes(32),
    relayUrl,
    ipTransports: p === "relay" && cb === "own" ? false : undefined,
  });
  try {
    const opts = p === "direct" ? { relayUrl, directAddrs: server.directAddrs() } : { relayUrl };
    const conn = await client.connect(server.id(), ALPN, opts);
    const r = await echo(conn, 4 << 20);
    assert.equal(r.received, r.sent);
    // Direct paths may start on the relay and upgrade after holepunching.
    if (p === "direct") {
      for (let i = 0; i < 40 && conn.pathKind() !== "direct"; i++) {
        await echo(conn, 65536);
      }
    }
    assert.equal(conn.pathKind(), p);
    conn.close(0, "done");
  } finally {
    await client.close();
    await server.close();
    await serving;
  }
}

// Server closes with (1, "not a member"); the client must observe the code and reason.
async function closeCode(relayUrl, sb, cb) {
  const server = await load(sb).bind({
    secretKey: crypto.randomBytes(32),
    relayUrl,
    alpns: [ALPN],
  });
  const client = await load(cb).bind({ secretKey: crypto.randomBytes(32), relayUrl });
  try {
    const accepted = server.accept();
    const conn = await client.connect(server.id(), ALPN, {
      relayUrl,
      directAddrs: server.directAddrs(),
    });
    const sconn = await accepted;
    assert.equal(sconn.remoteId(), client.id());
    sconn.close(1, "not a member");
    const info = await conn.closed();
    if (cb === "own") {
      assert.equal(info.code, 1);
      assert.equal(info.reason, "not a member");
    } else {
      assert.match(info.reason, /not a member/);
    }
  } finally {
    await client.close();
    await server.close();
  }
}

// Runs the Rust tunnel-testserver against our relay; resolves { desc, dir, stop() }.
async function startTestserver(relayUrl) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-iroh-ts-"));
  const child = spawn(TESTSERVER, [relayUrl, dir], { stdio: "ignore" });
  const descPath = path.join(dir, "descriptor.json");
  for (let i = 0; i < 100 && !fs.existsSync(descPath); i++) {
    await delay(100);
  }
  const stop = async () => {
    await stopChild(child);
    fs.rmSync(dir, { recursive: true, force: true });
  };
  if (!fs.existsSync(descPath)) {
    await stop();
    throw new Error("tunnel-testserver wrote no descriptor");
  }
  return { desc: JSON.parse(fs.readFileSync(descPath, "utf8")), dir, stop };
}

// tunnel/0 framing: u32 BE length prefix.
function frame(payload) {
  const h = Buffer.alloc(4);
  h.writeUInt32BE(payload.length);
  return Buffer.concat([h, payload]);
}

// Reads length-prefixed tunnel/0 frames from a RecvStream.
class Frames {
  constructor(recv) {
    this.recv = recv;
    this.buf = Buffer.alloc(0);
  }

  async need(n) {
    while (this.buf.length < n) {
      const b = await this.recv.read(1 << 20);
      if (!b) {
        return false;
      }
      this.buf = Buffer.concat([this.buf, b]);
    }
    return true;
  }

  async next() {
    if (!(await this.need(4))) {
      return null;
    }
    const len = this.buf.readUInt32BE(0);
    if (!(await this.need(4 + len))) {
      throw new Error("truncated");
    }
    const f = this.buf.subarray(4, 4 + len);
    this.buf = this.buf.subarray(4 + len);
    return Buffer.from(f);
  }
}

// Sends one tunnel HTTP request with an optional body; resolves { head, body }.
async function tunnelFetch(conn, head, body) {
  const { send, recv } = await conn.openBi();
  await send.write(
    frame(Buffer.from(JSON.stringify({ kind: "http", method: "GET", headers: [], ...head }))),
  );
  for (let o = 0; o < (body?.length ?? 0); o += 1 << 20) {
    await send.write(frame(body.subarray(o, o + (1 << 20))));
  }
  await send.finish();
  const fr = new Frames(recv);
  const h = JSON.parse((await fr.next()).toString());
  const parts = [];
  for (let f; (f = await fr.next());) {
    parts.push(f);
  }
  return { head: h, body: Buffer.concat(parts) };
}
