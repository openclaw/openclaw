// Stream subscription scope workload (Node 26):
// node --expose-gc --import ./scripts/tsx.mjs scripts/perf/stream-dispatch-scope-measure.ts
// Use --allocations for a separate collected-object sampling pass, or --trace-gc-nvp
// on Node for a separate promotion pass; neither pass supplies timing gates.
// Use --owner-root <frozen-source-root> to compare unchanged owner modules while
// sharing this workload and helper dependencies. Compare >=5 alternating pairs
// with --events 5000, on identical Node and source snapshots.
// Models the observer's queued track() plus detached chat delivery under three ambient
// stores, a shared context field, and the real model-transport/capacity owners.
// The baseline has eight native frame entries, matching the common built-Gateway
// assistant-event census; --ambient-stores varies the remaining caller context.
// 48 interleaved streams each emit 10 deltas per batch. This is owner proof,
// not a WebSocket/Gateway throughput benchmark. Output equality and settled drains
// are required; apply the campaign's absolute GC/tail materiality rules to timings.
// --tool-scopes enters the real scheduling/delivery/liveness owners for each ten
// events (48 concurrent tool invocations per batch). --owner-root selects these
// owners too; keep unchanged dependencies shared when freezing baseline sources.
// --ambient-fields also widens the shared carrier to include its object-copy cost.
import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import path from "node:path";
import { monitorEventLoopDelay, PerformanceObserver } from "node:perf_hooks";
import { setImmediate as nextTurn } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { Type } from "typebox";
import type {
  ToolSearchCatalogEntry,
  ToolSearchToolContext,
} from "../../src/agents/tool-search-types.js";
import { AsyncContext } from "../../src/shared/async-context.js";
import {
  AsyncWorkScope,
  getAsyncWorkSignal,
  runOutsideAsyncWorkScope,
} from "../../src/shared/async-work-scope.js";
import { sumSampledHeapBytes } from "../lib/heap-sampling.ts";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.ts";

const { values } = parseArgs({
  options: {
    events: { type: "string", default: "240000" },
    allocations: { type: "boolean", default: false },
    "ambient-stores": { type: "string", default: "3" },
    "ambient-fields": { type: "string", default: "0" },
    "owner-root": { type: "string", default: fileURLToPath(new URL("../../", import.meta.url)) },
    "tool-scopes": { type: "boolean", default: false },
  },
});
const events = parseStrictIntegerOption({
  raw: values.events,
  label: "--events",
  min: 1,
  fallback: 1,
});
const ownerRoot = path.resolve(values["owner-root"]);
const {
  withReleasableExecutionCapacity,
}: typeof import("../../src/agents/embedded-agent-runner/run/execution-capacity.js") = await import(
  pathToFileURL(path.join(ownerRoot, "src/agents/embedded-agent-runner/run/execution-capacity.ts"))
    .href
);
const { withModelTransportContext }: typeof import("../../src/llm/model-transport-context.js") =
  await import(pathToFileURL(path.join(ownerRoot, "src/llm/model-transport-context.ts")).href);
const { runScheduledToolSearchCall }: typeof import("../../src/agents/tool-search-scheduling.js") =
  await import(pathToFileURL(path.join(ownerRoot, "src/agents/tool-search-scheduling.ts")).href);
const {
  runWithToolResultDelivery,
  assertCompleteToolResult,
}: typeof import("../../src/agents/tool-result-limits.js") = await import(
  pathToFileURL(path.join(ownerRoot, "src/agents/tool-result-limits.ts")).href
);
const {
  createDiagnosticToolExecutionLiveness,
  recordDiagnosticToolExecutionDeadline,
}: typeof import("../../src/infra/diagnostic-tool-execution-liveness.js") = await import(
  pathToFileURL(path.join(ownerRoot, "src/infra/diagnostic-tool-execution-liveness.ts")).href
);
const tool: ToolSearchCatalogEntry = {
  id: "synthetic",
  source: "openclaw",
  name: "synthetic",
  description: "Synthetic tool",
  tool: {
    name: "synthetic",
    label: "Synthetic",
    description: "Synthetic tool",
    parameters: Type.Object({}),
    execute: async () => ({ content: [], details: {} }),
  },
};
const toolContext: ToolSearchToolContext = {
  catalogRef: {
    current: {
      entries: [tool],
      counterScope: "synthetic",
      searchCount: 0,
      describeCount: 0,
      callCount: 0,
    },
  },
};
async function inTool(run: () => void) {
  const invocation = createDiagnosticToolExecutionLiveness();
  try {
    await runScheduledToolSearchCall({
      ctx: toolContext,
      entry: tool,
      execute: () =>
        runWithToolResultDelivery(true, () =>
          invocation.run(async () => {
            await Promise.resolve();
            recordDiagnosticToolExecutionDeadline(123);
            assert.equal(invocation.view.deadlineAtMs, 123);
            assertCompleteToolResult("complete");
            run();
          }),
        ),
    });
  } finally {
    invocation.close();
  }
}
assert(global.gc, "Run with --expose-gc");
const ambientStores = parseStrictIntegerOption({
  raw: values["ambient-stores"],
  label: "--ambient-stores",
  min: 0,
  fallback: 3,
});
const stores = Array.from({ length: ambientStores }, () => new AsyncLocalStorage<number>());
const ambientFields = parseStrictIntegerOption({
  raw: values["ambient-fields"],
  label: "--ambient-fields",
  min: 0,
  fallback: 0,
});
const fields = Array.from(
  { length: ambientFields },
  () => new AsyncContext<number>(Symbol("ambient-field")),
);
const context = new AsyncContext<boolean>(Symbol("stream-benchmark"));
const emitter = new AsyncWorkScope();
const observer = new AsyncWorkScope();
let tail = Promise.resolve();
const ready = Promise.resolve();
const observed = new Uint32Array(48);
const delivered = new Uint32Array(48);
const latencies: number[] = [];
const collections: { kind: number; duration: number }[] = [];
let measuring = false;
const gc = new PerformanceObserver((list) => {
  for (const entry of list.getEntries()) {
    if ("detail" in entry) {
      const detail = entry.detail as { kind: number };
      collections.push({ kind: detail.kind, duration: entry.duration });
    }
  }
});
const loop = monitorEventLoopDelay({ resolution: 1 });
async function stream(count: number) {
  for (let offset = 0; offset < count; offset += 480) {
    const emit = (index: number) => {
      const session = index % 48;
      const result = observer.track(() => tail.then(() => observed[session]!++));
      tail = result.then(
        () => undefined,
        () => undefined,
      );
      const started = performance.now();
      void runOutsideAsyncWorkScope(() =>
        ready.then(() => {
          assert.equal(getAsyncWorkSignal(), undefined);
          delivered[session]!++;
          if (measuring && !values.allocations) {
            latencies.push(performance.now() - started);
          }
        }),
      );
    };
    if (values["tool-scopes"]) {
      const calls: Promise<void>[] = [];
      for (let start = offset; start < Math.min(count, offset + 480); start += 10) {
        calls.push(
          inTool(() => {
            for (let index = start; index < Math.min(count, start + 10); index++) {
              emit(index);
            }
          }),
        );
      }
      await Promise.all(calls);
    } else {
      for (let index = offset; index < Math.min(count, offset + 480); index++) {
        emit(index);
      }
    }
    await tail;
    await nextTurn();
  }
}
function enter(index: number, run: () => Promise<void>): Promise<void> {
  if (index >= stores.length && index < stores.length + fields.length) {
    return fields[index - stores.length]!.run(index, () => enter(index + 1, run));
  }
  return index === stores.length + fields.length
    ? context.run(true, () =>
        withReleasableExecutionCapacity(
          (task) => task(),
          () => {
            // Provider setup has returned before the Gateway consumes its stream.
            withModelTransportContext({ requestId: "synthetic-stream" }, () => undefined);
            return emitter.run(run);
          },
        ),
      )
    : stores[index]!.run(index, () => enter(index + 1, run));
}
const inspector = new Session();
try {
  await enter(0, () => stream(4800));
  global.gc();
  await nextTurn();
  observed.fill(0);
  delivered.fill(0);
  if (values.allocations) {
    inspector.connect();
    await inspector.post("HeapProfiler.startSampling", {
      samplingInterval: 16384,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
  }
  gc.observe({ entryTypes: ["gc"] });
  loop.enable();
  measuring = true;
  if (process.execArgv.includes("--trace-gc-nvp")) {
    console.log("MEASURE_START");
  }
  const cpu = process.threadCpuUsage();
  const started = performance.now();
  await enter(0, () => stream(events));
  const elapsedMs = performance.now() - started;
  const used = process.threadCpuUsage(cpu);
  if (process.execArgv.includes("--trace-gc-nvp")) {
    console.log("MEASURE_END");
  }
  measuring = false;
  loop.disable();
  await nextTurn();
  gc.disconnect();
  const profile = values.allocations
    ? (await inspector.post("HeapProfiler.stopSampling")).profile
    : undefined;
  for (let session = 0; session < 48; session++) {
    const expected = Math.floor(events / 48) + (session < events % 48 ? 1 : 0);
    assert.equal(observed[session], expected);
    assert.equal(delivered[session], expected);
  }
  latencies.sort((left, right) => left - right);
  const byKind: Record<number, { count: number; totalMs: number; maxMs: number }> = {};
  for (const entry of collections) {
    const value = (byKind[entry.kind] ??= { count: 0, totalMs: 0, maxMs: 0 });
    value.count++;
    value.totalMs += entry.duration;
    value.maxMs = Math.max(value.maxMs, entry.duration);
  }
  const gcTails = Object.fromEntries(
    Object.entries(byKind).map(([kind, summary]) => {
      const durations = collections
        .filter((entry) => entry.kind === Number(kind))
        .map((entry) => entry.duration)
        .toSorted((a, b) => a - b);
      return [
        kind,
        {
          ...summary,
          p95Ms: durations[Math.floor(durations.length * 0.95)],
          p99Ms: durations[Math.floor(durations.length * 0.99)],
        },
      ];
    }),
  );
  console.log(
    JSON.stringify({
      node: process.version,
      hostLoad: loadavg(),
      events,
      ambientStores,
      ambientFields,
      toolScopes: values["tool-scopes"],
      ownerRoot,
      deliveries: delivered.reduce((sum, count) => sum + count, 0),
      elapsedMs,
      cpuUsPerEvent: (used.user + used.system) / events,
      allocatedBytesPerEvent: profile ? sumSampledHeapBytes(profile.head) / events : undefined,
      allocationSamples: profile?.samples.length,
      gc: gcTails,
      gcMsPerEvent: collections.reduce((sum, entry) => sum + entry.duration, 0) / events,
      latency: {
        count: latencies.length,
        p95Ms: latencies[Math.floor(latencies.length * 0.95)],
        p99Ms: latencies[Math.floor(latencies.length * 0.99)],
        maxMs: latencies.at(-1),
      },
      loop: {
        count: loop.count,
        p95Ms: loop.percentile(95) / 1e6,
        p99Ms: loop.percentile(99) / 1e6,
        maxMs: loop.max / 1e6,
      },
    }),
  );
} finally {
  inspector.disconnect();
  gc.disconnect();
  loop.disable();
  await observer.drain();
  await emitter.drain();
  for (const store of stores) {
    store.disable();
  }
}
