/**
 * Measure prepareStream's actual subscriber-options expression, without running
 * the subscriber or Gateway. Run on each revision, or pass a saved --source file:
 * node --expose-gc scripts/perf/attempt-stream-options-measure.ts --iterations 5000
 *
 * The synthetic 205-field attempt models the wide attempt passed by the runner.
 * Options remain live through the sampled window and minor GC, as across model
 * awaits. CPU runs untraced; allocation runs separately, including/excluding
 * minor-collected objects. MiB/min uses an explicit 1,000 calls/min normalization,
 * not a claim about production call frequency. Alternate revisions for five pairs.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    source: {
      type: "string",
      default: "src/agents/embedded-agent-runner/run/attempt-stream-prepare.ts",
    },
    iterations: { type: "string", default: "5000" },
  },
});
const iterations = Number(values.iterations);
assert(Number.isSafeInteger(iterations) && iterations > 0);
assert(globalThis.gc, "Run with --expose-gc");
const source = readFileSync(values.source, "utf8");
const marker = "const streamSubscription = subscribeEmbeddedAgentSession(";
const start = source.indexOf(marker);
assert(start >= 0, "Subscriber call must exist");
const end = source.indexOf("\n  });", start);
assert(end > start, "Subscriber options must end at the owner indentation");
const expression = source.slice(start + marker.length, end + 4);
// Extract the production expression so the benchmark cannot retain a stale copy.
// oxlint-disable-next-line typescript/no-implied-eval -- Executes the selected trusted checkout's owner expression, never external input.
const construct = new Function(
  "attempt",
  "agentSession",
  "input",
  "activeSession",
  `const onBeforeTerminalDelivery = undefined;
   const shouldRunBeforeAgentFinalize = false;
   const getGlobalHookRunner = () => undefined;
   const getModelProviderRuntimePluginHandle = () => undefined;
   return function prepareStreamOptions() { return (${expression}); };`,
);
const noop = () => {};
const attempt: Record<string, unknown> = {
  runId: "synthetic-run",
  sessionId: "synthetic-session",
  sessionKey: "agent:main:synthetic",
  onAgentEvent: noop,
  config: {},
  model: {},
  reasoningLevel: "off",
  thinkLevel: "off",
};
for (let index = Object.keys(attempt).length; index < 205; index++) {
  attempt[`unusedAttemptField${index}`] = undefined;
}
const agentSession = {
  activeSession: {},
  hookRunner: null,
  clientToolCallSlots: [],
  hasDeliveredSourceReply: () => false,
  markSourceReplyDelivered: noop,
  builtinToolNames: new Set(),
  coreBuiltinToolNames: new Set(),
  replaySafeToolNames: new Set(),
  codeModeExecToolNames: new Set(),
  sourceReplyCapableToolNames: new Set(),
  sideEffectToolOwners: new Map(),
  trustedLocalMediaToolNames: new Set(),
};
const input = { hookAgentId: "main", runAbortController: new AbortController() };
const run: () => Record<string, unknown> = construct(
  attempt,
  agentSession,
  input,
  agentSession.activeSession,
);
const optionKeys = Object.keys(run()).length;
let checksum = 0;
function batch(count: number, promote: boolean) {
  const retained = [];
  for (let index = 0; index < count; index++) {
    retained.push(run());
  }
  if (promote) {
    globalThis.gc!({ type: "minor", execution: "sync" });
  }
  for (const options of retained) {
    checksum += Number(options.runId === "synthetic-run");
  }
  return retained;
}
batch(1000, false);
globalThis.gc();
const started = performance.now();
const cpuStart = process.cpuUsage();
batch(iterations, false);
const cpu = process.cpuUsage(cpuStart);
const elapsedMs = performance.now() - started;
const inspector = new Session();
inspector.connect();
const allocations = [];
try {
  for (const includeMinorCollected of [true, false]) {
    globalThis.gc();
    await inspector.post("HeapProfiler.startSampling", {
      samplingInterval: 4096,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: includeMinorCollected,
    });
    const liveOptions = [];
    for (let done = 0; done < iterations; done += 128) {
      liveOptions.push(...batch(Math.min(128, iterations - done), true));
    }
    const { profile } = await inspector.post("HeapProfiler.stopSampling");
    let bytes = 0;
    function visit(node: typeof profile.head, inOwner = false) {
      const owner = inOwner || node.callFrame.functionName === "prepareStreamOptions";
      if (owner) {
        bytes += node.selfSize;
      }
      for (const child of node.children) {
        visit(child, owner);
      }
    }
    visit(profile.head);
    assert.equal(liveOptions.length, iterations);
    allocations.push({
      includeMinorCollected,
      bytesPerCall: bytes / iterations,
      mibPer1000Calls: ((bytes / iterations) * 1000) / 2 ** 20,
    });
  }
} finally {
  inspector.disconnect();
}
console.log(
  JSON.stringify({
    source: values.source,
    iterations,
    attemptKeys: Object.keys(attempt).length,
    optionKeys,
    cpuUsPerCall: (cpu.user + cpu.system) / iterations,
    elapsedMs,
    allocations,
    hostLoad: loadavg(),
    checksum,
  }),
);
