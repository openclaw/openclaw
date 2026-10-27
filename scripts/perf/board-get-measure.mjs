/**
 * board.get handler benchmark, including real validation, tickets and sandbox URLs.
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/board-get-measure.mjs \
 *   [owner=src/gateway/server-methods/board.ts] [iterations=3000]
 * Run pristine/candidate owners in counterbalanced order. A pristine source copy
 * must live beside board.ts so its relative imports resolve to the same dependencies.
 * 2,000 prepared session boards (500 subagent keys), 4 tabs, 24 HTML widgets, and
 * 10 synthetic caller identities. The store returns fresh snapshots; no database,
 * sockets, model turns, or live Gateway are measured. CPU/wall and allocation use
 * separate passes; allocation includes collected objects. Stable response bytes
 * are hashed after verifying tickets and omitting their nonce/expiry/generation.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { verifyBoardViewTicket } from "../../src/gateway/board-view-ticket.ts";

const owner = resolve(process.argv[2] || "src/gateway/server-methods/board.ts");
const iterations = Number(process.argv[3] || 3000);
assert(Number.isSafeInteger(iterations) && iterations > 0);
assert(globalThis.gc, "run with --expose-gc");
const { createBoardHandlers } = await import(pathToFileURL(owner).href);
const widgets = Array.from({ length: 24 }, (_, index) => ({
  name: `widget-${index}`,
  tabId: `tab-${index % 4}`,
  title: `Synthetic widget ${index}`,
  contentKind: "html",
  contentOwner: "html",
  sizeW: 6,
  sizeH: 4,
  position: Math.floor(index / 4),
  grantState: "none",
  revision: 1,
}));
const tabs = Array.from({ length: 4 }, (_, index) => ({
  tabId: `tab-${index}`,
  title: `Group ${index}`,
  position: index,
  chatDock: "right",
}));
const boards = new Map(
  Array.from({ length: 2000 }, (_, index) => {
    const sessionKey = `agent:main:${index < 500 ? "subagent:" : "session:"}${index}`;
    return [sessionKey, { sessionKey, revision: 1, tabs, widgets }];
  }),
);
const keys = [...boards.keys()];
const htmlViewMetadata = new Map(
  widgets.map((widget) => [
    widget.name,
    {
      revision: 1,
      sha256: "a".repeat(64),
      viewGeneration: "b".repeat(32),
      grantState: "none",
    },
  ]),
);
const handler = createBoardHandlers({
  async getSnapshotWithHtmlViewMetadata({ sessionKey }) {
    const snapshot = boards.get(sessionKey);
    assert(snapshot);
    return { snapshot: structuredClone(snapshot), htmlViewMetadata };
  },
})["board.get"];
const config = { agents: { entries: { main: {} } } };
const context = {
  getRuntimeConfig: () => config,
  getMcpAppSandboxPort: () => 40001,
  resolveGatewayContext: () => context,
};
const clients = Array.from({ length: 10 }, (_, index) => ({ connId: `synthetic-${index}` }));
let response;
let sink = 0;
async function call(index) {
  const params = { sessionKey: keys[index % keys.length], agentId: "main" };
  await handler({
    req: { type: "req", id: "measure", method: "board.get", params },
    params,
    context,
    client: clients[index % clients.length],
    isWebchatConnect: () => false,
    respond(ok, payload, error) {
      assert(ok, JSON.stringify(error));
      response = payload;
      sink += payload.widgets.length;
    },
  });
}
await call(0);
const stable = structuredClone(response);
for (const widget of stable.widgets) {
  const claims = verifyBoardViewTicket(widget.viewTicket);
  assert(claims);
  assert.equal(claims.sessionKey, keys[0]);
  assert.equal(claims.name, widget.name);
  const {
    nonce: _nonce,
    expiresAtMs: _expiresAtMs,
    authorityGeneration: _generation,
    ...binding
  } = claims;
  widget.viewTicket = binding;
  widget.frameUrl = widget.frameUrl.split("?")[0];
}
const digest = createHash("sha256").update(JSON.stringify(stable)).digest("hex");
for (let index = 0; index < 100; index++) {
  await call(index);
}
globalThis.gc();
const hostLoad = loadavg();
const cpuBefore = process.threadCpuUsage();
const start = performance.now();
for (let index = 0; index < iterations; index++) {
  await call(index);
}
const elapsedMs = performance.now() - start;
const cpu = process.threadCpuUsage(cpuBefore);
globalThis.gc();
const inspector = new Session();
inspector.connect();
await inspector.post("HeapProfiler.startSampling", {
  samplingInterval: 4096,
  includeObjectsCollectedByMajorGC: true,
  includeObjectsCollectedByMinorGC: true,
});
for (let index = 0; index < iterations; index++) {
  await call(index);
}
const { profile } = await inspector.post("HeapProfiler.stopSampling");
inspector.disconnect();
console.log(
  JSON.stringify({
    ownerSha256: createHash("sha256").update(readFileSync(owner)).digest("hex"),
    iterations,
    sessions: boards.size,
    clients: clients.length,
    widgets: widgets.length,
    hostLoad,
    loadAfter: loadavg(),
    wallUsPerCall: (elapsedMs * 1000) / iterations,
    cpuUsPerCall: (cpu.user + cpu.system) / iterations,
    allocatedBytesPerCall:
      profile.samples.reduce((total, sample) => total + sample.size, 0) / iterations,
    memory: process.memoryUsage(),
    digest,
    sink,
  }),
);
