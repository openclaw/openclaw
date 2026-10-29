/**
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/hook-message-loader-retention.ts
 *   --iterations 2000 [--allocations | --survivors] [--assert-released]
 * Run unchanged on base/candidate in fresh processes, alternating launch order.
 * Half the calls use agent_end, half before_agent_finalize. Each lazy loader owns
 * synthetic attempt state (200 messages, 40 tools); delivered output is independent.
 * All hooks remain pending together to amplify retention, not model Gateway concurrency.
 * Timing reports main-thread dispatch + settlement CPU, excluding forced GC/profiling.
 * Allocation includes collected objects; survivors samples only objects alive after
 * forced GC while hooks remain pending. Heap deltas include harness bookkeeping;
 * serialized payload bytes estimate retained data, not V8 object sizes or promotion.
 * Acceptance: zero captured attempts while hooks are pending, identical delivered
 * output/settlement, no material CPU or allocated-byte increase. This owner probe
 * does not exercise provider transport and makes no whole-Gateway performance claim.
 */
import assert from "node:assert/strict";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import { setImmediate as nextTurn } from "node:timers/promises";
import { parseArgs } from "node:util";
import {
  awaitAgentHarnessAgentEndHook,
  runAgentHarnessBeforeAgentFinalizeHook,
} from "../../src/agents/harness/lifecycle-hook-helpers.js";
import { bindAgentHarnessHookMessages } from "../../src/agents/harness/lifecycle-hook-messages.js";
import type {
  PluginHookAgentEndEvent,
  PluginHookBeforeAgentFinalizeEvent,
} from "../../src/plugins/hook-types.js";
import { createHookRunner } from "../../src/plugins/hooks.js";

const { values } = parseArgs({
  options: {
    iterations: { type: "string", default: "2000" },
    allocations: { type: "boolean", default: false },
    survivors: { type: "boolean", default: false },
    "assert-released": { type: "boolean", default: false },
  },
});
const iterations = Number(values.iterations);
assert(Number.isSafeInteger(iterations) && iterations > 0);
assert(!(values.allocations && values.survivors), "Use separate allocation/survivor passes");
assert(globalThis.gc, "Run with --expose-gc");
const gc = globalThis.gc;
const mode = values.allocations ? "allocations" : values.survivors ? "survivors" : "timing";
const deliveredMessages = [{ role: "assistant", content: "completed synthetic turn" }];
function makeAttempt(index: number) {
  return {
    runId: `synthetic-${index}`,
    messages: Array.from({ length: 200 }, (_, i) => ({ role: "user", content: `message-${i}` })),
    tools: Array.from({ length: 40 }, (_, i) => ({
      name: `tool-${i}`,
      description: "synthetic tool",
    })),
    pendingState: Array.from({ length: 512 }, (_, i) => i),
  };
}
const serializedPayloadBytes = Buffer.byteLength(JSON.stringify(makeAttempt(0)));
function makeLoader(index: number) {
  const attempt = makeAttempt(index);
  return {
    reference: new WeakRef(attempt),
    load: async () => {
      assert.equal(
        attempt.messages.length + attempt.tools.length + attempt.pendingState.length,
        752,
      );
      return deliveredMessages;
    },
  };
}
let delivered = 0;
function start(count: number) {
  const gate = Promise.withResolvers<void>();
  const dispatch = async (
    event: PluginHookAgentEndEvent | PluginHookBeforeAgentFinalizeEvent,
  ): Promise<undefined> => {
    assert.equal(event.messages, deliveredMessages);
    delivered++;
    await gate.promise;
  };
  const hookRunner = {
    ...createHookRunner({ hooks: [], typedHooks: [], plugins: [] }),
    hasHooks: () => true,
    runAgentEnd: dispatch,
    runBeforeAgentFinalize: dispatch,
  };
  const pending: Array<
    | ReturnType<typeof awaitAgentHarnessAgentEndHook>
    | ReturnType<typeof runAgentHarnessBeforeAgentFinalizeHook>
  > = [];
  const references: WeakRef<object>[] = [];
  for (let i = 0; i < count; i++) {
    const { reference, load } = makeLoader(i);
    references.push(reference);
    const params = {
      event: bindAgentHarnessHookMessages(
        { messages: [], success: true, sessionId: `session-${i}`, stopHookActive: false },
        load,
      ),
      ctx: { runId: `synthetic-${i}` },
      hookRunner,
    };
    pending.push(
      i % 2
        ? runAgentHarnessBeforeAgentFinalizeHook(params)
        : awaitAgentHarnessAgentEndHook(params),
    );
  }
  return { pending, references, release: gate.resolve };
}
async function collect() {
  await nextTurn();
  gc();
  await nextTurn();
  gc();
}
const warmup = start(64);
warmup.release();
await Promise.all(warmup.pending);
delivered = 0;
await collect();
const inspector = new Session();
if (mode !== "timing") {
  inspector.connect();
  await inspector.post("HeapProfiler.startSampling", {
    samplingInterval: 8192,
    includeObjectsCollectedByMajorGC: values.allocations,
    includeObjectsCollectedByMinorGC: values.allocations,
  });
}
const hostLoad = loadavg();
const heapBefore = process.memoryUsage().heapUsed;
const cpuStart = process.threadCpuUsage();
const startedAt = performance.now();
const running = start(iterations);
await nextTurn();
const dispatchCpu = process.threadCpuUsage(cpuStart);
const dispatchMs = performance.now() - startedAt;
assert.equal(delivered, iterations);
await collect();
const heapPending = process.memoryUsage().heapUsed;
const retainedAttempts = running.references.filter((reference) => reference.deref()).length;
let sampledBytes: number | undefined;
if (values.survivors) {
  const { profile } = await inspector.post("HeapProfiler.stopSampling");
  sampledBytes = profile.samples.reduce((sum, sample) => sum + sample.size, 0);
}
const settleStart = process.threadCpuUsage();
const settledAt = performance.now();
running.release();
const results = await Promise.all(running.pending);
const settleCpu = process.threadCpuUsage(settleStart);
const settleMs = performance.now() - settledAt;
assert.equal(
  results.filter((result) => result && result.action === "continue").length,
  Math.floor(iterations / 2),
);
if (values.allocations) {
  const { profile } = await inspector.post("HeapProfiler.stopSampling");
  sampledBytes = profile.samples.reduce((sum, sample) => sum + sample.size, 0);
}
if (mode !== "timing") {
  inspector.disconnect();
}
await collect();
console.log(
  JSON.stringify(
    {
      mode,
      iterations,
      hostLoad,
      delivered,
      retainedAttempts,
      serializedPayloadBytes,
      retainedPayloadEstimateBytes: retainedAttempts * serializedPayloadBytes,
      heapPendingDeltaBytes: heapPending - heapBefore,
      heapSettledDeltaBytes: process.memoryUsage().heapUsed - heapBefore,
      cpuUsPerAttempt:
        (dispatchCpu.user + dispatchCpu.system + settleCpu.user + settleCpu.system) / iterations,
      wallMs: dispatchMs + settleMs,
      sampledBytes,
      sampledBytesPerAttempt: sampledBytes === undefined ? undefined : sampledBytes / iterations,
    },
    null,
    2,
  ),
);
if (values["assert-released"]) {
  assert.equal(retainedAttempts, 0, "Hydrated loaders retain attempts while hooks are pending");
}
