// Gateway subscription owner workload (Node 26):
// node --expose-gc --import ./scripts/tsx.mjs scripts/perf/agent-runtime-dispatch-measure.ts \
//   --source .local/runtime-dispatch/base.ts --events 5000
// Repeat with --allocations for a separate collected-object allocation pass. Compare
// >=5 alternating pairs of frozen server-runtime-subscriptions.ts source files.
// Executes the exact subscription block through the real event bus, lazy loader,
// dispatch helper, root admission and 24 ambient ALS stores. 48 interleaved streams
// deliver assistant/tool deltas in batches of 480. Audit/activity I/O and terminal
// binding (unreachable for these deltas) are stubs; the loaded chat handler counts
// and fingerprints delivery. This measures owner dispatch, not Gateway throughput,
// lifecycle persistence, WebSockets, or resource-loader's session handler.
import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Session, type HeapProfiler } from "node:inspector/promises";
import { stripTypeScriptTypes } from "node:module";
import { loadavg } from "node:os";
import { resolve } from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { parseArgs } from "node:util";
import { compileFunction } from "node:vm";
import { dispatchEventHandler } from "../../src/gateway/server-runtime-event-dispatch.js";
import {
  emitAgentEvent,
  onAgentRuntimeEvent,
  resetAgentEventsForTest,
  type AgentEventRuntimePayload,
} from "../../src/infra/agent-events.js";
import {
  getActiveGatewayRootWorkCount,
  tryBeginGatewayRootWorkAdmission,
} from "../../src/process/gateway-work-admission.js";
import { AsyncWorkScope, getAsyncWorkSignal } from "../../src/shared/async-work-scope.js";
import { createLazyPromiseLoader } from "../../src/shared/lazy-promise.js";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.ts";

const { values } = parseArgs({
  options: {
    source: { type: "string", default: "src/gateway/server-runtime-subscriptions.ts" },
    events: { type: "string", default: "5000" },
    allocations: { type: "boolean", default: false },
  },
});
const events = parseStrictIntegerOption({
  raw: values.events,
  label: "--events",
  min: 1,
  fallback: 1,
});
assert(global.gc, "Run with --expose-gc");
const sourcePath = resolve(values.source);
const source = readFileSync(sourcePath, "utf8");
const start = source.includes("  const isNonLifecycleDeliveryCurrent =")
  ? source.indexOf("  const isNonLifecycleDeliveryCurrent =")
  : source.indexOf("  const handleAgentEvent =");
const end = source.indexOf("  const agentUnsub =", start);
assert(start >= 0 && end > start, "Subscription source boundaries changed");
const block = source.slice(start, end);
const stores = Array.from({ length: 24 }, () => new AsyncLocalStorage<number>());
const emitter = new AsyncWorkScope();
const dispatches = new Set<Promise<void>>();
const golden = createHash("sha256");
let fingerprint = true;
let delivered = 0;
let activity = 0;
let audited = 0;
let inheritedScope = false;
let checksum = 0;
const handler = (event: AgentEventRuntimePayload) => {
  delivered++;
  checksum += event.seq;
  inheritedScope ||= getAsyncWorkSignal() !== undefined;
  if (fingerprint) {
    golden.update(JSON.stringify({ ...event, ts: 0 }));
  }
};
const dependencies = {
  params: {
    log: {
      warn: (message: string) => {
        throw new Error(message);
      },
    },
  },
  sessionActivitySummaries: {
    handleEvent: () => {
      activity++;
    },
  },
  auditRecorder: {
    record: () => {
      audited++;
    },
  },
  agentEventHandlerLoader: createLazyPromiseLoader(() => handler, { cacheRejections: true }),
  dispatchEventHandler,
  onAgentRuntimeEvent,
  agentEventDispatches: dispatches,
  bindChatAbortTerminalDispatch: (entries: unknown, _settled: Promise<void>, captured: unknown) => {
    assert.equal(entries, undefined);
    assert.equal(captured, undefined);
  },
};
const install = compileFunction(
  `${stripTypeScriptTypes(block)}\nreturn unsubscribeAgentEvents;`,
  Object.keys(dependencies),
  { filename: sourcePath },
);
const unsubscribe: () => void = install(...Object.values(dependencies));
const fixtures = Array.from({ length: 48 }, (_, index) => ({
  runId: `synthetic-stream-${index}`,
  stream: index % 3 === 0 ? "tool" : "assistant",
  data:
    index % 3 === 0
      ? {
          phase: "update",
          toolCallId: `tool-${index}`,
          name: "exec",
          partialResult: { content: [{ type: "text", text: "synthetic output" }] },
        }
      : { delta: "synthetic streamed text", text: "synthetic streamed text" },
}));
async function stream(count: number) {
  for (let offset = 0; offset < count; offset += 480) {
    for (let index = offset; index < Math.min(count, offset + 480); index++) {
      emitAgentEvent(fixtures[index % fixtures.length]!);
    }
    await Promise.all(dispatches);
    assert.equal(dispatches.size, 0);
  }
}
function enter(index: number, run: () => Promise<void>): Promise<void> {
  return index === stores.length
    ? emitter.run(run)
    : stores[index]!.run(index, () => enter(index + 1, run));
}
function allocated(node: HeapProfiler.SamplingHeapProfileNode): number {
  return node.selfSize + node.children.reduce((sum, child) => sum + allocated(child), 0);
}
const root = tryBeginGatewayRootWorkAdmission("synthetic-stream-benchmark");
assert(root);
const inspector = new Session();
try {
  await root.run(() => enter(0, () => stream(480)));
  const digest = golden.digest("hex");
  fingerprint = false;
  await root.run(() => enter(0, () => stream(5000)));
  for (let sample = 0; sample < 5; sample++) {
    global.gc();
    await nextTurn();
    delivered = activity = audited = checksum = 0;
    if (values.allocations) {
      if (sample === 0) {
        inspector.connect();
      }
      await inspector.post("HeapProfiler.startSampling", {
        samplingInterval: 16384,
        includeObjectsCollectedByMajorGC: true,
        includeObjectsCollectedByMinorGC: true,
      });
    }
    const cpu = process.threadCpuUsage();
    const started = performance.now();
    await root.run(() => enter(0, () => stream(events)));
    const elapsedMs = performance.now() - started;
    const used = process.threadCpuUsage(cpu);
    const profile = values.allocations
      ? (await inspector.post("HeapProfiler.stopSampling")).profile
      : undefined;
    assert.equal(delivered, events);
    assert.equal(activity, events);
    assert.equal(audited, events);
    assert.equal(inheritedScope, false);
    assert.equal(getActiveGatewayRootWorkCount(), 1);
    console.log(
      JSON.stringify({
        node: process.version,
        source: sourcePath,
        sourceDigest: createHash("sha256").update(block).digest("hex"),
        sample,
        events,
        delivered,
        checksum,
        digest,
        elapsedMs,
        cpuUsPerEvent: (used.user + used.system) / events,
        allocatedBytesPerEvent: profile ? allocated(profile.head) / events : undefined,
        allocationSamples: profile?.samples.length,
        hostLoad: loadavg(),
      }),
    );
  }
} finally {
  inspector.disconnect();
  unsubscribe();
  await Promise.all(dispatches);
  await emitter.drain();
  root.release();
  assert.equal(getActiveGatewayRootWorkCount(), 0);
  resetAgentEventsForTest();
  for (const store of stores) {
    store.disable();
  }
}
