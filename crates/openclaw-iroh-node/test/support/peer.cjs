#!/usr/bin/env node
// Bench peer process: binds an endpoint with this binding (so the peer is never the bottleneck),
// prints { id, directAddrs } as one JSON line, then serves the test protocol until SIGTERM.
//   node peer.cjs [--relay <url>] [--relay-only]
"use strict";
const crypto = require("node:crypto");
const { setTimeout: delay } = require("node:timers/promises");
const { load } = require("./adapters.cjs");
const { ALPN, serveEndpoint } = require("./proto.cjs");

const args = process.argv.slice(2);
const relayUrl = args.includes("--relay") ? args[args.indexOf("--relay") + 1] : undefined;

(async () => {
  const ep = await load("own").bind({
    secretKey: crypto.randomBytes(32),
    relayUrl,
    alpns: [ALPN],
    ipTransports: args.includes("--relay-only") ? false : undefined,
  });
  if (relayUrl) {
    await ep.online();
  }
  process.stdout.write(JSON.stringify({ id: ep.id(), directAddrs: ep.directAddrs() }) + "\n");
  process.on("SIGTERM", async () => {
    await Promise.race([ep.close(), delay(1000)]);
    process.exit(0);
  });
  await serveEndpoint(ep);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
