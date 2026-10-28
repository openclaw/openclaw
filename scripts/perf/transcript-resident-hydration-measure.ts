/**
 * Resident transcript hydration through the real read owner and worker transport.
 * Run separate processes/passes; allocation sampling is not a latency/GC timing gate:
 *   node --expose-gc --import ./scripts/tsx.mjs scripts/perf/transcript-resident-hydration-measure.ts \
 *     --mode timing --operations 400 --output .local/resident-hydration.json
 * Modes: timing, allocation, bytes. Optional --owners-dir loads frozen
 * session-transcript-hydration.ts and session-actor-replica.ts at their original module URLs.
 * Prepare those files with git show for each revision; dependencies must be identical.
 * Acceptance: unchanged transcript bytes and resident graph; fewer hydration reply
 * bytes plus lower main-thread CPU or sampled allocation over counterbalanced runs.
 * This is an owner benchmark, not whole-Gateway or production frequency evidence.
 */
import assert from "node:assert/strict";
import { hash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { Session, type HeapProfiler } from "node:inspector/promises";
import { registerHooks } from "node:module";
import { loadavg } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { serialize } from "node:v8";
import { startGatewayBenchDiagnostics } from "../lib/gateway-bench-diagnostics.ts";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.ts";

const { values } = parseArgs({
  options: {
    "owners-dir": { type: "string" },
    operations: { type: "string", default: "400" },
    mode: { type: "string", default: "timing" },
    output: { type: "string" },
  },
});
assert(values.output, "--output is required");
const mode = values.mode;
assert(mode === "timing" || mode === "allocation" || mode === "bytes", "Invalid --mode");
const operations = parseStrictIntegerOption({
  raw: values.operations,
  label: "--operations",
  min: 1,
  fallback: 400,
});
const owners = ["session-transcript-hydration.ts", "session-actor-replica.ts"].map((name) => {
  const original = new URL(`../../src/config/sessions/${name}`, import.meta.url);
  const source = values["owners-dir"]
    ? pathToFileURL(path.resolve(values["owners-dir"], name))
    : original;
  return { name, original, source, sha256: hash("sha256", readFileSync(source)), loaded: false };
});
if (values["owners-dir"]) {
  registerHooks({
    load(url, context, nextLoad) {
      const owner = owners.find((entry) => entry.original.href === url);
      if (owner) {
        owner.loaded = true;
        const loaded = nextLoad(owner.source.href, context);
        return { format: loaded.format, source: loaded.source, shortCircuit: true };
      }
      return nextLoad(url, context);
    },
  });
}
const [
  { createOpenClawTestState },
  { upsertSessionEntryCore },
  { withSelectedTranscriptReader },
  { SessionManager },
  { prepareSessionTranscriptHydration },
  { readSessionActorTranscriptReplica },
  { runWithoutOwnedSessionTranscriptWrites },
  { historyLane },
] = await Promise.all([
  import("../../src/test-utils/openclaw-test-state.js"),
  import("../../src/config/sessions/session-accessor.js"),
  import("../../src/agents/sessions/session-manager-reader.test-support.js"),
  import("../../src/agents/sessions/session-manager.js"),
  import("../../src/config/sessions/session-transcript-hydration.js"),
  import("../../src/config/sessions/session-actor-replica.js"),
  import("../../src/config/sessions/transcript-write-context-store.js"),
  import("../../src/config/sessions/session-transcript-worker-resources.js"),
]);
assert(!values["owners-dir"] || owners.every((owner) => owner.loaded), "Frozen owners not loaded");
const state = await createOpenClawTestState({ label: "resident-hydration-measure" });
const inspector = mode === "allocation" ? new Session() : undefined;
function sampledBytes(node: HeapProfiler.SamplingHeapProfileNode): number {
  return node.selfSize + node.children.reduce((sum, child) => sum + sampledBytes(child), 0);
}
try {
  const target = {
    agentId: "main",
    sessionId: "synthetic-resident",
    sessionKey: "agent:main:synthetic-resident",
    storePath: path.join(state.agentDir("main"), "openclaw-agent.sqlite"),
  };
  await upsertSessionEntryCore(target, { sessionId: target.sessionId, updatedAt: 1 });
  const manager = await SessionManager.openAsync(target, state.workspaceDir);
  for (let index = 0; index < 32; index++) {
    await manager.appendMessageAsync({
      role: "user",
      content: [{ type: "text", text: `Message ${index}: ${"synthetic transcript ".repeat(240)}` }],
      timestamp: index + 1,
    });
  }
  const limits = { maxBytes: 1024 * 1024, maxEvents: 100 };
  await withSelectedTranscriptReader(
    target,
    async (actor) => {
      assert(actor);
      const expected = await prepareSessionTranscriptHydration(target, limits).read();
      const hot = actor.snapshot({ assertCurrent() {}, authorize() {} });
      assert(hot);
      const retained = readSessionActorTranscriptReplica(hot);
      assert(retained?.context, "The fixture must already retain its bounded transcript");
      const retainedBytes = serialize(retained).byteLength;
      let latest = expected;
      const read = async () => {
        latest = await prepareSessionTranscriptHydration(target, limits).read();
      };
      await runWithoutOwnedSessionTranscriptWrites(async () => {
        for (let index = 0; index < 32; index++) {
          await read();
        }
      });
      assert.deepEqual(latest.snapshot, expected.snapshot);
      const originalRun = historyLane.pool.run;
      let replyBytes = 0;
      let replies = 0;
      if (mode === "bytes") {
        historyLane.pool.run = function (input, options) {
          let hydration = false;
          return originalRun
            .call(
              this,
              async () => {
                const request = typeof input === "function" ? await input() : input;
                hydration = request.kind === "transcript-hydration";
                return request;
              },
              options,
            )
            .then((reply) => {
              if (hydration) {
                replies++;
                replyBytes += serialize(reply).byteLength;
              }
              return reply;
            });
        };
      }
      inspector?.connect();
      if (inspector) {
        await inspector.post("HeapProfiler.startSampling", {
          samplingInterval: 32768,
          includeObjectsCollectedByMajorGC: true,
          includeObjectsCollectedByMinorGC: true,
        });
      }
      const latencies = new Float64Array(operations);
      const hostBefore = loadavg();
      const memoryBefore = process.memoryUsage();
      const finish = startGatewayBenchDiagnostics();
      const cpuBefore = process.cpuUsage();
      const mainCpuBefore = process.threadCpuUsage();
      try {
        await runWithoutOwnedSessionTranscriptWrites(async () => {
          for (let index = 0; index < operations; index++) {
            const started = performance.now();
            await read();
            latencies[index] = performance.now() - started;
          }
        });
      } finally {
        historyLane.pool.run = originalRun;
      }
      const mainCpu = process.threadCpuUsage(mainCpuBefore);
      const cpu = process.cpuUsage(cpuBefore);
      const diagnostics = finish();
      const memoryAfter = process.memoryUsage();
      const hostAfter = loadavg();
      const allocation = inspector
        ? sampledBytes((await inspector.post("HeapProfiler.stopSampling")).profile.head)
        : undefined;
      assert.deepEqual(latest.snapshot, expected.snapshot, "Hydration changed transcript bytes");
      assert.equal(readSessionActorTranscriptReplica(hot), retained, "Residency was replaced");
      assert.equal(serialize(retained).byteLength, retainedBytes, "Resident transcript grew");
      for (const owner of owners) {
        assert.equal(
          hash("sha256", readFileSync(owner.source)),
          owner.sha256,
          "Owner source changed",
        );
      }
      const sorted = latencies.toSorted();
      const result = {
        scope:
          "Real admitted transcript reads, synthetic unchanged resident transcript; no Gateway",
        mode,
        operations,
        warmupOperations: 32,
        node: process.version,
        owners: owners.map(({ name, sha256 }) => ({
          name,
          sha256,
        })),
        fixture: { events: expected.snapshot.events.length, retainedBytes },
        latency: {
          count: operations,
          p50Ms: sorted[Math.ceil(operations * 0.5) - 1],
          p95Ms: sorted[Math.ceil(operations * 0.95) - 1],
          p99Ms: sorted[Math.ceil(operations * 0.99) - 1],
          maxMs: sorted.at(-1),
        },
        mainThreadCpuMs: (mainCpu.user + mainCpu.system) / 1000,
        processCpuMs: (cpu.user + cpu.system) / 1000,
        ...(allocation === undefined ? {} : { sampledAllocationBytes: allocation }),
        ...(mode === "bytes" ? { hydrationReplies: replies, hydrationReplyBytes: replyBytes } : {}),
        memory: { before: memoryBefore, after: memoryAfter },
        hostLoad: { before: hostBefore, after: hostAfter },
        diagnostics,
      };
      const output = path.resolve(values.output!);
      await mkdir(path.dirname(output), { recursive: true });
      await writeFile(output, `${JSON.stringify(result, null, 2)}\n`);
      console.log(
        JSON.stringify({
          output,
          mode,
          operations,
          mainThreadCpuMs: result.mainThreadCpuMs,
          sampledAllocationBytes: allocation,
          hydrationReplyBytes: mode === "bytes" ? replyBytes : undefined,
        }),
      );
    },
    true,
  );
} finally {
  inspector?.disconnect();
  await state.cleanup();
}
