/**
 * Owner-boundary proof for discarded tool-event copies and duplicate memory-reader captures.
 * node --import ./scripts/tsx.mjs scripts/perf/gateway-clone-measure.ts --workload tool
 * Use --workload history for queued actor reads; --allocation measures allocation separately.
 * --source-dir points to baseline files saved with their src/gateway-relative paths.
 * Run baseline/candidate in alternating order; this is not whole-Gateway stress evidence.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Session, type HeapProfiler } from "node:inspector/promises";
import { registerHooks } from "node:module";
import { loadavg } from "node:os";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import type { WorkerLiveEventParams } from "../../packages/gateway-protocol/src/schema/worker-admission.js";
import { startGatewayBenchDiagnostics } from "../lib/gateway-bench-diagnostics.ts";

const { values } = parseArgs({
  options: {
    workload: { type: "string", default: "tool" },
    iterations: { type: "string", default: "3000" },
    allocation: { type: "boolean", default: false },
    "source-dir": { type: "string" },
  },
});
const iterations = Number(values.iterations);
assert(Number.isSafeInteger(iterations) && iterations > 0);
assert(values.workload === "tool" || values.workload === "history");
const gatewayRoot = new URL("../../src/gateway/", import.meta.url);
if (values["source-dir"]) {
  const sourceDir = path.resolve(values["source-dir"]);
  const replacements = new Map(
    ["session-transcript-readers.ts", "worker-environments/live-event-projection.ts"].map(
      (file) => [new URL(file, gatewayRoot).href, path.join(sourceDir, file)],
    ),
  );
  registerHooks({
    load(url, context, nextLoad) {
      const replacement = replacements.get(url);
      return replacement
        ? {
            format: "module-typescript",
            source: readFileSync(replacement, "utf8"),
            shortCircuit: true,
          }
        : nextLoad(url, context);
    },
  });
}

let run: () => Promise<void>;
let cleanup = () => {};
let operationsPerIteration: number;
if (values.workload === "tool") {
  const { prepareWorkerLiveEventData } =
    await import("../../src/gateway/worker-environments/live-event-projection.js");
  // A search/list result and a tool screenshot exercise payloads common to busy agent turns.
  const result = {
    content: [
      { type: "text", text: "synthetic output ".repeat(1024) },
      { type: "image", data: "YQ==".repeat(16384) },
    ],
    details: {
      rows: Array.from({ length: 100 }, (_, index) => ({
        id: `session-${index}`,
        title: `Synthetic session ${index}`,
        archived: true,
      })),
    },
  };
  const events: WorkerLiveEventParams["event"][] = [
    {
      kind: "tool",
      payload: {
        name: "read",
        toolCallId: "synthetic",
        phase: "start",
        args: { queries: ["synthetic query"], limit: 100 },
      },
    },
    {
      kind: "tool",
      payload: { name: "read", toolCallId: "synthetic", phase: "update", partialResult: result },
    },
    {
      kind: "tool",
      payload: { name: "read", toolCallId: "synthetic", phase: "result", result, isError: false },
    },
  ];
  operationsPerIteration = events.length;
  run = async () => {
    for (const event of events) {
      assert.equal(prepareWorkerLiveEventData(event).name, "read");
    }
  };
} else {
  const [
    { memorySessionActorOwners },
    { runWithSessionActorStorage },
    { resolveIncognitoOpenClawAgentSqlitePath },
    { readSessionActorStorageResult },
    readers,
  ] = await Promise.all([
    import("../../src/config/sessions/session-actor-memory-owner.js"),
    import("../../src/config/sessions/session-actor-storage-binding.js"),
    import("../../src/state/openclaw-agent-db.paths.js"),
    import("../../src/config/sessions/session-actor-storage-result.js"),
    import("../../src/gateway/session-transcript-readers.js"),
  ]);
  const env = { OPENCLAW_STATE_DIR: path.resolve(".local/gateway-clone-measure") };
  const agentId = "synthetic";
  const storePath = resolveIncognitoOpenClawAgentSqlitePath({ agentId, env });
  const owner = memorySessionActorOwners.get({ agentId, path: storePath });
  const authority = { assertCurrent() {}, authorize() {} };
  const sessionKey = `agent:${agentId}:dashboard:incognito-measure`;
  const actor = await owner.acquire(
    { database: owner.identity, sessionKey },
    { assertCurrent() {}, assertReadable() {} },
  );
  const sessionId = "synthetic-session";
  const created = await actor.storage!.mutate(
    {
      type: "session.entry.create",
      input: {
        entry: { sessionId, updatedAt: 1, incognito: true },
        transcriptEvents: [
          { type: "session", id: sessionId, version: 3, cwd: "/synthetic" },
          ...Array.from({ length: 100 }, (_, index) => ({
            type: "message",
            id: `message-${index}`,
            parentId: index ? `message-${index - 1}` : null,
            timestamp: "2026-10-25T00:00:00.000Z",
            message: { role: "user", content: "Synthetic history text" },
          })),
        ],
      },
    },
    authority,
  );
  readSessionActorStorageResult(created);
  const scope = { agentId, sessionId, sessionKey, storePath, env };
  operationsPerIteration = 2;
  run = () =>
    runWithSessionActorStorage({ actor, authority, agentId, path: storePath }, async () => {
      const page = await readers.readSessionMessagesPageWithStatsAsync(scope, {
        offset: 90,
        maxMessages: 10,
      });
      const exact = await readers.readSessionMessageByIdAsync(scope, "message-99", {
        currentOnly: true,
        maxBytes: 16384,
      });
      assert.equal(page.messages.length, 10);
      assert.equal(exact.found, true);
    });
  cleanup = () => memorySessionActorOwners.reset();
}
for (let index = 0; index < 200; index++) {
  await run();
}
const inspector = new Session();
if (values.allocation) {
  inspector.connect();
  await inspector.post("HeapProfiler.startSampling", {
    samplingInterval: 4096,
    includeObjectsCollectedByMajorGC: true,
    includeObjectsCollectedByMinorGC: true,
  });
}
const diagnostics = startGatewayBenchDiagnostics();
const hostLoad = loadavg();
const before = process.memoryUsage();
const cpuBefore = process.cpuUsage();
const started = performance.now();
for (let index = 0; index < iterations; index++) {
  await run();
  if (index % 32 === 31) {
    await setImmediate();
  }
}
const wallMs = performance.now() - started;
const cpu = process.cpuUsage(cpuBefore);
await setImmediate();
const metrics = diagnostics();
let sampledBytes: number | undefined;
let allocationSamples: number | undefined;
if (values.allocation) {
  const { profile } = await inspector.post("HeapProfiler.stopSampling");
  const sum = (node: HeapProfiler.SamplingHeapProfileNode): number =>
    node.selfSize + node.children.reduce((total, child) => total + sum(child), 0);
  sampledBytes = sum(profile.head);
  allocationSamples = profile.samples.length;
  inspector.disconnect();
}
const operations = iterations * operationsPerIteration;
console.log(
  JSON.stringify({
    workload: values.workload,
    source: values["source-dir"] ? "baseline" : "candidate",
    node: process.version,
    ownerRoot: fileURLToPath(gatewayRoot),
    iterations,
    operations,
    allocation: values.allocation,
    wallMs,
    cpuUsPerOperation: (cpu.user + cpu.system) / operations,
    sampledBytesPerOperation: sampledBytes === undefined ? undefined : sampledBytes / operations,
    allocationSamples,
    hostLoad,
    memory: { before, after: process.memoryUsage() },
    diagnostics: metrics,
  }),
);
cleanup();
