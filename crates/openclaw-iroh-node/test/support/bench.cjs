#!/usr/bin/env node
// One measured transfer in a fresh process, so CPU and peak RSS belong to this run only.
//   node bench.cjs --binding own|number0 --peer '<json>' [--relay <url>] --path direct|relay
//                  --test up|down|streams8|conns8 [--mb N]
// streams8 and conns8 split --mb across 8 parallel downloads. Prints one JSON line; rssBeforeMB is
// the RSS after dialing, just before the transfer, so maxRssMB - rssBeforeMB is the transfer's growth.
"use strict";
const crypto = require("node:crypto");
const { setTimeout: delay } = require("node:timers/promises");
const { load } = require("./adapters.cjs");
const { ALPN, download, upload } = require("./proto.cjs");

const args = process.argv.slice(2);
const opt = (k, d) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
const MB = 1 << 20;

// Dials the peer and waits until the requested path is selected.
async function dial(ep, peer, relayUrl, path) {
  const opts = path === "direct" ? { relayUrl, directAddrs: peer.directAddrs } : { relayUrl };
  const conn = await ep.connect(peer.id, ALPN, opts);
  const deadline = Date.now() + 10000;
  await download(conn, MB);
  while (conn.pathKind() !== path) {
    if (Date.now() > deadline) {
      throw new Error(`path never became ${path} (is ${conn.pathKind()})`);
    }
    await download(conn, 64 * 1024);
  }
  return conn;
}

// Runs the selected transfer over the dialed connections.
function transfer(test, conns, bytes) {
  if (test === "up") {
    return upload(conns[0], bytes);
  }
  if (test === "down") {
    return download(conns[0], bytes);
  }
  if (test === "streams8") {
    return Promise.all(Array.from({ length: 8 }, () => download(conns[0], bytes / 8)));
  }
  if (test === "conns8") {
    return Promise.all(conns.map((c) => download(c, bytes / 8)));
  }
  throw new Error("unknown test " + test);
}

(async () => {
  const binding = load(opt("--binding", "own"));
  const peer = JSON.parse(opt("--peer"));
  const relayUrl = opt("--relay");
  const path = opt("--path", "direct");
  const test = opt("--test");
  const bytes = Number(opt("--mb", "64")) * MB;
  const ep = await binding.bind({ secretKey: crypto.randomBytes(32), relayUrl });
  const conns = await Promise.all(
    Array.from({ length: test === "conns8" ? 8 : 1 }, () => dial(ep, peer, relayUrl, path)),
  );
  const rssBeforeMB = process.memoryUsage().rss / MB;
  const cpu0 = process.cpuUsage();
  const t0 = performance.now();
  await transfer(test, conns, bytes);
  const secs = (performance.now() - t0) / 1000;
  const cpu = process.cpuUsage(cpu0);
  const cpuS = (cpu.user + cpu.system) / 1e6;
  const res = {
    binding: binding.name,
    path,
    test,
    mb: bytes / MB,
    secs,
    mbps: bytes / MB / secs,
    cpuSPerMB: cpuS / (bytes / MB),
    maxRssMB: process.resourceUsage().maxRSS / 1024,
    rssBeforeMB,
    rssEndMB: process.memoryUsage().rss / MB,
    pathAfter: conns[0].pathKind(),
  };
  process.stdout.write(JSON.stringify(res) + "\n");
  for (const c of conns) {
    c.close(0, "done");
  }
  await Promise.race([ep.close(), delay(1000)]);
  process.exit(0);
})().catch((e) => {
  console.error(String(e.stack || e));
  process.exit(1);
});
