/**
 * Actual prompt-context argument expression microbenchmark; not a phase/Gateway load test.
 * node --expose-gc scripts/perf/attempt-prompt-context-measure.ts --iterations 5000
 * Pass --source <saved attempt-prompt-phase.ts> for a baseline; alternate revisions.
 * CPU is untraced; sampling includes/excludes minor-collected objects separately.
 * Holds 128 through minor/full GC: forced owner survival, not production promotion.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    source: {
      type: "string",
      default: "src/agents/embedded-agent-runner/run/attempt-prompt-phase.ts",
    },
    iterations: { type: "string", default: "5000" },
  },
});
const iterations = Number(values.iterations);
assert(Number.isSafeInteger(iterations) && iterations > 0);
assert(globalThis.gc, "Run with --expose-gc");
const source = readFileSync(values.source, "utf8");
const marker = "const promptContext = await prepareEmbeddedAttemptPromptContext(";
const start = source.indexOf(marker);
assert(start >= 0, "Prompt-context call must exist");
const end = source.indexOf("\n    });", start);
assert(end > start, "Prompt-context arguments must end at the owner indentation");
const expression = source.slice(start + marker.length, end + 6);
const fragments = [{ kind: "runtime-instruction", text: "Synthetic turn instruction" }];
const systemFragments = [{ kind: "runtime-instruction", text: "Synthetic system context" }];
const messages = Array.from({ length: 600 }, (_, index) =>
  Object.freeze({
    role: index % 2 ? "toolResult" : "user",
    timestamp: index,
    content: Object.freeze([Object.freeze({ type: "text", text: `Synthetic history ${index}` })]),
    ...(index % 2 ? { toolCallId: `call-${index}`, toolName: "read", isError: false } : {}),
  }),
);
Object.freeze(messages);
const attempt: Record<string, unknown> & { runtimeContextFragments: typeof fragments } = {
  runtimeContextFragments: fragments,
};
for (let index = Object.keys(attempt).length; index < 205; index++) {
  attempt[`unusedAttemptField${index}`] = undefined;
}
const facts = {
  attempt,
  activeSession: { messages, agent: { state: { messages } } },
  sessionManager: { getHeader: () => ({ version: 4 }) },
  prepared: {
    systemPrompt: { runtimeContextFragments: systemFragments },
    toolCatalog: { toolSearchRunPlan: { capabilityToolNames: new Set(["read"]) } },
  },
  promptAssembly: { effectivePrompt: "Synthetic question" },
  appendOnlyRuntimeContext: true,
  inHistorySystemUpdates: true,
  boundaryTimezone: "UTC",
  includeBoundaryTimestamp: true,
  isRawModelRun: false,
  preparedUserTurnMessage: undefined,
  sessionAgentId: "main",
  systemPromptReport: undefined,
  systemPromptText: "Synthetic system prompt",
  toolResultPromptProjectionState: { replacements: new Map(), frozen: new Set() },
};
// oxlint-disable-next-line typescript/no-implied-eval -- Extracts the selected trusted checkout's expression, never external input.
const construct = new Function(
  "facts",
  `const { ${Object.keys(facts).join(",")} } = facts; return function preparePromptContextOptions() { return (${expression}); };`,
);
const run: () => {
  attempt: typeof attempt;
  messages: typeof messages;
  systemPromptRuntimeContextFragments?: typeof fragments;
} = construct(facts);
const first = run();
assert.equal(first.messages, messages);
const combined = [
  ...first.attempt.runtimeContextFragments,
  ...(first.systemPromptRuntimeContextFragments ?? []),
];
assert.deepEqual(combined, [...fragments, ...systemFragments]);
const argumentPayloadSha256 = createHash("sha256")
  .update(JSON.stringify({ messages: first.messages, fragments: combined }))
  .digest("hex");
let checksum = 0;
function batch(count: number, promote = false) {
  const retained = Array.from({ length: count }, () => run());
  if (promote) {
    globalThis.gc!({ type: "minor", execution: "sync" });
  }
  for (const options of retained) {
    checksum += Number(options.messages === messages);
  }
  return retained;
}
batch(1000);
globalThis.gc();
const cpuStart = process.threadCpuUsage();
batch(iterations);
const cpu = process.threadCpuUsage(cpuStart);
const inspector = new Session();
inspector.connect();
const allocations = [];
for (const includeMinorCollected of [true, false]) {
  globalThis.gc();
  await inspector.post("HeapProfiler.startSampling", {
    samplingInterval: 512,
    includeObjectsCollectedByMajorGC: true,
    includeObjectsCollectedByMinorGC: includeMinorCollected,
  });
  let live: ReturnType<typeof batch> | undefined = undefined;
  for (let done = 0; done < iterations; done += 128) {
    live = batch(Math.min(128, iterations - done), true);
  }
  const { profile } = await inspector.post("HeapProfiler.stopSampling");
  let bytes = 0;
  function visit(node: typeof profile.head, inOwner = false) {
    const owner = inOwner || node.callFrame.functionName === "preparePromptContextOptions";
    if (owner) {
      bytes += node.selfSize;
    }
    for (const child of node.children) {
      visit(child, owner);
    }
  }
  visit(profile.head);
  assert(live?.length);
  allocations.push({ includeMinorCollected, bytesPerCall: bytes / iterations });
}
inspector.disconnect();
globalThis.gc();
const beforeHeap = process.memoryUsage().heapUsed;
const retained = batch(128);
globalThis.gc();
const retainedHeapBytes = process.memoryUsage().heapUsed - beforeHeap;
console.log(
  JSON.stringify({
    source: values.source,
    sourceSha256: createHash("sha256").update(source).digest("hex"),
    argumentPayloadSha256,
    iterations,
    attemptKeys: Object.keys(attempt).length,
    historyMessages: messages.length,
    cpuUsPerCall: (cpu.user + cpu.system) / iterations,
    allocations,
    retainedCalls: retained.length,
    retainedHeapBytes,
    retainedHeapBytesPerCall: retainedHeapBytes / retained.length,
    hostLoad: loadavg(),
    checksum,
  }),
);
