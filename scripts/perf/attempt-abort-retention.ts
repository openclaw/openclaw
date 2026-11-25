// Synthetic attempt-owner retention probe. Run on Node with --expose-gc --import ./scripts/tsx.mjs.
// Example: node --expose-gc --import ./scripts/tsx.mjs scripts/perf/attempt-abort-retention.ts
//   --operations 100 --mode retention --expect-released
// --owner and --deferred-owner accept exact baseline modules with imports resolved to this checkout.
// Alternate baseline/current processes. Use allocation and --trace-gc-nvp --mode promotion separately;
// --pairs N alternates baseline/current in one warmed process; omit baseline paths for A/A.
// Timing/GC output excludes the forced collections used only to count survivors.
import assert from "node:assert/strict";
import { Session } from "node:inspector/promises";
import { PerformanceObserver } from "node:perf_hooks";
import { setImmediate as nextTurn } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { queryObjects, writeHeapSnapshot } from "node:v8";
import { SessionManager } from "../../src/agents/sessions/session-manager.js";

const { values } = parseArgs({
  options: {
    owner: { type: "string" },
    "deferred-owner": { type: "string" },
    mode: { type: "string", default: "retention" },
    pairs: { type: "string" },
    operations: { type: "string", default: "100" },
    "payload-bytes": { type: "string", default: "65536" },
    snapshot: { type: "string" },
    "expect-released": { type: "boolean" },
  },
});
assert(global.gc, "Use --expose-gc");
assert(["retention", "timing", "allocation", "promotion"].includes(values.mode));
const operations = Number(values.operations);
const payloadBytes = Number(values["payload-bytes"]);
assert(Number.isSafeInteger(operations) && operations > 0);
assert(Number.isSafeInteger(payloadBytes) && payloadBytes > 0);
const {
  createEmbeddedAttemptExternalAbortController: baselineAbort,
}: typeof import("../../src/agents/embedded-agent-runner/run/attempt-finalize.js") = await import(
  values.owner
    ? pathToFileURL(values.owner).href
    : "../../src/agents/embedded-agent-runner/run/attempt-finalize.ts"
);

const {
  createEmbeddedAttemptDeferredLifecycleOwner: baselineDeferred,
}: typeof import("../../src/agents/embedded-agent-runner/run/deferred-lifecycle-owner.js") =
  await import(
    values["deferred-owner"]
      ? pathToFileURL(values["deferred-owner"]).href
      : "../../src/agents/embedded-agent-runner/run/deferred-lifecycle-owner.ts"
  );

const cleanupAfterEarlyAbort = async () => {};
const baseline = { abort: baselineAbort, deferred: baselineDeferred };
const candidate = values.pairs
  ? {
      abort: (await import("../../src/agents/embedded-agent-runner/run/attempt-finalize.js"))
        .createEmbeddedAttemptExternalAbortController,
      deferred: (
        await import("../../src/agents/embedded-agent-runner/run/deferred-lifecycle-owner.js")
      ).createEmbeddedAttemptDeferredLifecycleOwner,
    }
  : baseline;
const pairs = Number(values.pairs ?? "1");
assert(Number.isSafeInteger(pairs) && pairs > 0);
async function measure(factories: typeof baseline, arm: "base" | "candidate", pair: number) {
  const {
    abort: createEmbeddedAttemptExternalAbortController,
    deferred: createEmbeddedAttemptDeferredLifecycleOwner,
  } = factories;
  async function completedAttempt(index: number) {
    const manager = SessionManager.inMemory();
    await manager.appendMessageAsync({
      role: "user",
      content: Buffer.alloc(payloadBytes, 65 + (index % 26)).toString(),
      timestamp: index,
    });
    const owner = createEmbeddedAttemptExternalAbortController({
      abortSignal: new AbortController().signal,
      cleanupAfterEarlyAbort,
      runAbortController: new AbortController(),
      runId: `synthetic-${index}`,
      state: { terminal: { kind: "ok" } },
    });
    owner.setActiveSessionAbort(async () => {
      manager.getSessionId();
    });
    owner.setRunAbort(() => {
      manager.getSessionId();
    });
    owner.setCompactionState({
      isPendingOrRetrying: () => Boolean(manager.getSessionId()),
      isInFlight: () => Boolean(manager.getSessionId()),
    });
    const deferred = createEmbeddedAttemptDeferredLifecycleOwner({
      runId: `synthetic-${index}`,
      sessionId: manager.getSessionId(),
      diagnosticOwner: {
        generation: {},
        sessionId: manager.getSessionId(),
        workKey: `synthetic-${index}`,
      },
      isCurrent: () => Boolean(manager.getSessionId()),
      onRetryWaitCompleted: () => {
        manager.getSessionId();
      },
      clearActiveRun: () => {
        manager.getSessionId();
      },
      trajectoryRecorder: null,
    });
    owner.arm();
    owner.dispose();
    await deferred.complete();
    return { owner, deferred };
  }
  async function collect() {
    for (let pass = 0; pass < 4; pass++) {
      await nextTurn();
      global.gc!();
    }
  }
  for (let index = 0; index < 10; index++) {
    await completedAttempt(index);
  }
  await collect();
  const beforeManagers = queryObjects(SessionManager, { format: "count" });
  const beforeHeap = process.memoryUsage().heapUsed;
  const collections: Array<{ kind: number; duration: number }> = [];
  const observer = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      const detail = (entry as PerformanceEntry & { detail: { kind: number } }).detail;
      collections.push({ kind: detail.kind, duration: entry.duration });
    }
  });
  observer.observe({ entryTypes: ["gc"] });
  const inspector = new Session();
  if (values.mode === "allocation") {
    inspector.connect();
    await inspector.post("HeapProfiler.startSampling", {
      samplingInterval: 1024,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
  }
  const held: Awaited<ReturnType<typeof completedAttempt>>[] = [];
  const durations: number[] = [];
  if (values.mode === "promotion") {
    console.log("MEASUREMENT_START");
  }
  const cpuBefore = process.cpuUsage();
  const started = performance.now();
  for (let index = 0; index < operations; index++) {
    const start = performance.now();
    held.push(await completedAttempt(index));
    durations.push(performance.now() - start);
  }
  const wallMs = performance.now() - started;
  const cpu = process.cpuUsage(cpuBefore);
  if (values.mode === "promotion") {
    console.log("MEASUREMENT_END");
  }
  let sampledBytes: number | undefined;
  if (values.mode === "allocation") {
    const { profile } = await inspector.post("HeapProfiler.stopSampling");
    sampledBytes = profile.samples.reduce((sum, sample) => sum + sample.size, 0);
    inspector.disconnect();
  }
  await nextTurn();
  await nextTurn();
  observer.disconnect();
  await collect();
  const retainedBytes = process.memoryUsage().heapUsed - beforeHeap;
  const retainedManagers = queryObjects(SessionManager, { format: "count" }) - beforeManagers;
  if (values.snapshot) {
    writeHeapSnapshot(
      values.pairs ? `${values.snapshot}.${arm}-${pair}.heapsnapshot` : values.snapshot,
    );
  }
  durations.sort((a, b) => a - b);
  console.log(
    JSON.stringify({
      node: process.version,
      arm,
      pair,
      mode: values.mode,
      operations,
      payloadBytes,
      beforeManagers,
      retainedManagers,
      retainedBytes,
      wallMs,
      cpuMs: (cpu.user + cpu.system) / 1000,
      sampledBytes,
      latency: {
        samples: durations.length,
        p95Ms: durations[Math.ceil(durations.length * 0.95) - 1],
        p99Ms: durations[Math.ceil(durations.length * 0.99) - 1],
        maxMs: durations.at(-1),
      },
      gc: [...new Set(collections.map(({ kind }) => kind))].map((kind) => {
        const pauses = collections.filter((entry) => entry.kind === kind).map((e) => e.duration);
        return {
          kind,
          count: pauses.length,
          totalMs: pauses.reduce((sum, duration) => sum + duration, 0),
          maxMs: Math.max(0, ...pauses),
        };
      }),
    }),
  );
  // Keep every disposed owner observable until after collection.
  for (const { owner, deferred } of held) {
    owner.dispose();
    await deferred.complete();
  }
  if (values["expect-released"] && arm === "candidate") {
    assert.equal(retainedManagers, 0, "Completed attempt owners retained their sessions");
  }
}
for (let pair = 1; pair <= pairs; pair++) {
  const arms: Array<"base" | "candidate"> = values.pairs
    ? pair % 2 === 1
      ? ["base", "candidate"]
      : ["candidate", "base"]
    : ["candidate"];
  for (const arm of arms) {
    await measure(arm === "base" ? baseline : candidate, arm, pair);
  }
}
