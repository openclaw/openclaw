// Owner microbenchmark: 64 recipients, 64 projected rows, one watch change per publication.
// Run on each revision: node --import ./scripts/tsx.mjs scripts/perf/presence-delivery-measure.ts
// Append --allocations for a separate allocation pass; timing in that pass is diagnostic only.
// --owner <saved-presence-delivery.ts> compares an exact saved owner with the same fixture.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { HeapProfiler } from "node:inspector";
import { Session } from "node:inspector/promises";
import { registerHooks, stripTypeScriptTypes } from "node:module";
import { loadavg } from "node:os";
import { setImmediate as nextTurn } from "node:timers/promises";
import { parseArgs } from "node:util";
import type { GatewayWsClient } from "../../src/gateway/server/ws-types.js";
import { listSystemPresence, upsertPresence } from "../../src/infra/system-presence.js";
import { startGatewayBenchDiagnostics } from "../lib/gateway-bench-diagnostics.ts";

const { values } = parseArgs({
  options: { allocations: { type: "boolean", default: false }, owner: { type: "string" } },
});
const ownerUrl = new URL("../../src/gateway/presence-delivery.ts", import.meta.url);
const ownerSource = readFileSync(values.owner ?? ownerUrl, "utf8");
let ownerLoaded = false;
const hooks = registerHooks({
  load(url, context, nextLoad) {
    if (url !== ownerUrl.href) {
      return nextLoad(url, context);
    }
    ownerLoaded = true;
    return { format: "module", source: stripTypeScriptTypes(ownerSource), shortCircuit: true };
  },
});
const { preparePresenceDelivery } = await import("../../src/gateway/presence-delivery.js");
hooks.deregister();
assert(ownerLoaded, "The selected presence owner must be loaded");
const clients = Array.from({ length: 64 }, () => ({}) as GatewayWsClient);
for (let index = 0; index < clients.length; index++) {
  upsertPresence(`delivery-measure-${index}`, {
    connectionId: `delivery-measure-${index}`,
    host: `synthetic-workstation-${index}`,
    text: "Synthetic operator presence",
    platform: "macos",
    version: "dev",
    roles: ["operator"],
    scopes: ["operator.read", "operator.write"],
    user: {
      id: `synthetic-${index}`,
      identity: { type: "profile", id: `synthetic-${index}` },
      name: `Synthetic Operator ${index}`,
      avatarUrl: `https://example.com/${"x".repeat(140)}-${index}.png`,
    },
    watchedSessions: ["agent:main:visible"],
  });
}
const source = listSystemPresence()
  .filter((row) => row.connectionId?.startsWith("delivery-measure-"))
  .toSorted((left, right) => left.connectionId!.localeCompare(right.connectionId!));
assert.equal(source.length, 64);
let version = 0;
let wireBytes = 0;
const digest = createHash("sha256");
async function run(publications: number) {
  for (let iteration = 0; iteration < publications; iteration++) {
    version++;
    // Presence projection creates a new roster while retaining immutable metadata.
    const view = source.map((row, index) => ({
      ...row,
      ts: 1_700_000_000_000,
      watchedSessions: [
        index === version % source.length ? "agent:main:other" : "agent:main:visible",
      ],
    }));
    for (const client of clients) {
      const delivery = preparePresenceDelivery(client, source, view, version);
      client.presenceSnapshot = delivery.snapshot;
      wireBytes += delivery.fragment.length;
      if (client === clients[0]) {
        digest.update(delivery.fragment);
      }
    }
    if (iteration % 100 === 0) {
      await nextTurn();
    }
  }
}
await run(300);
wireBytes = 0;
const inspector = new Session();
if (values.allocations) {
  inspector.connect();
  await inspector.post("HeapProfiler.startSampling", {
    samplingInterval: 32768,
    includeObjectsCollectedByMajorGC: true,
    includeObjectsCollectedByMinorGC: true,
  });
}
const stopDiagnostics = startGatewayBenchDiagnostics();
const cpu = process.threadCpuUsage();
const start = performance.now();
await run(3000);
const wallMs = performance.now() - start;
const used = process.threadCpuUsage(cpu);
await nextTurn();
await nextTurn();
const diagnostics = stopDiagnostics();
let allocatedBytes: number | undefined;
if (values.allocations) {
  const { profile } = await inspector.post("HeapProfiler.stopSampling");
  const sum = (node: HeapProfiler.SamplingHeapProfileNode): number =>
    node.selfSize + node.children.reduce((total, child) => total + sum(child), 0);
  allocatedBytes = sum(profile.head);
  inspector.disconnect();
}
console.log(
  JSON.stringify({
    publications: 3000,
    ownerSha256: createHash("sha256").update(ownerSource).digest("hex"),
    recipients: clients.length,
    wallMs,
    threadCpuMs: (used.user + used.system) / 1000,
    allocatedBytes,
    wireBytes,
    wireDigest: digest.digest("hex"),
    memory: process.memoryUsage(),
    hostLoad: loadavg(),
    diagnostics,
  }),
);
