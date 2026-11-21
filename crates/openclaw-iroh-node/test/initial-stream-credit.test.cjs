"use strict";
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { test } = require("node:test");
const { setTimeout: delay } = require("node:timers/promises");
const binding = require("../index.js");
const { loopbackAddrs } = require("./support/adapters.cjs");

test(
  "initial stream credit queues the next open and survives stream release",
  { timeout: 10_000 },
  async () => {
    const alpn = Buffer.from("initial-credit-test");
    const server = await binding.bind({
      secretKey: crypto.randomBytes(32),
      alpns: [alpn],
      maxConcurrentBiStreams: 1,
      keepAliveMs: 1_000,
    });
    const client = await binding.bind({ secretKey: crypto.randomBytes(32) });
    try {
      const accepting = server.accept();
      const outgoing = await client.connect(server.id(), alpn, {
        directAddrs: loopbackAddrs(server.boundSockets()),
      });
      const incoming = await accepting;
      const first = await outgoing.openBi();
      await first.send.write(Buffer.from("first"));
      const received = await incoming.acceptBi();
      assert.equal((await received.recv.read(5)).toString(), "first");
      let opened = false;
      const next = outgoing.openBi().then((stream) => {
        opened = true;
        return stream;
      });
      await delay(100);
      assert.equal(opened, false, "peer must not receive the default 100-stream initial grant");
      await received.recv.stop(77);
      await received.send.reset(77);
      await first.send.reset(77);
      await first.recv.stop(77);
      const second = await next;
      await second.send.write(Buffer.from("after-release"));
      await second.send.finish();
      const resumed = await incoming.acceptBi();
      assert.equal((await resumed.recv.read(64)).toString(), "after-release");
      assert.equal(await resumed.recv.read(64), null);
      await resumed.send.write(Buffer.from("reply"));
      await resumed.send.finish();
      assert.equal((await second.recv.read(64)).toString(), "reply");
      assert.equal(await second.recv.read(64), null);
    } finally {
      await Promise.all([client.close(), server.close()]);
    }
  },
);
