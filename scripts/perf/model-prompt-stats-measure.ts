import assert from "node:assert/strict";
import type { HeapProfiler } from "node:inspector";
import { Session } from "node:inspector/promises";
import { mock } from "node:test";
import { setImmediate as nextTurn } from "node:timers/promises";
import { parseArgs } from "node:util";
import { createModelPromptStats } from "../../src/agents/embedded-agent-runner/run/attempt.model-diagnostic-observation.js";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.ts";

const { values } = parseArgs({
  options: {
    calls: { type: "string", default: "1000" },
    messages: { type: "string", default: "500" },
  },
});
const integer = (name: keyof typeof values) =>
  parseStrictIntegerOption({ raw: values[name], label: `--${name}`, min: 1, fallback: 1 });
const calls = integer("calls");
const messages = Array.from({ length: integer("messages") }, (_, index) => ({
  role: "user" as const,
  content: `${index}: ${'Quoted "text", café 🦞, lone \ud800 and newline\n'.repeat(200)}`,
  timestamp: index,
}));
const context = { messages, systemPrompt: "Synthetic instructions", tools: [] };
const expected = {
  inputMessagesCount: messages.length,
  inputMessagesChars: JSON.stringify(messages).length,
  systemPromptChars: context.systemPrompt.length,
  toolDefinitionsCount: 0,
  toolDefinitionsChars: 2,
  totalChars: JSON.stringify(messages).length + context.systemPrompt.length + 2,
};
const measure = createModelPromptStats();
assert.deepEqual(measure(context), expected);

// Count record creation separately so instrumentation is outside the profiles.
const records = new WeakSet<object>();
// oxlint-disable-next-line typescript/unbound-method -- The probe forwards the original receiver.
const originalSet = Map.prototype.set;
let newRecords = 0;
const set = mock.method(
  Map.prototype,
  "set",
  function (this: Map<unknown, unknown>, key: unknown, value: unknown) {
    if (typeof value === "object" && value !== null && "text" in value && "chars" in value) {
      if (!records.has(value)) {
        newRecords++;
        records.add(value);
      }
    }
    return originalSet.call(this, key, value);
  },
);
let warmRecords: number;
try {
  assert.deepEqual(measure(context), expected);
  newRecords = 0;
  assert.deepEqual(measure(context), expected);
  warmRecords = newRecords;
} finally {
  set.mock.restore();
}
for (let index = 0; index < 50; index++) {
  measure(context);
}
if (!global.gc) {
  throw new Error("Run with --expose-gc");
}
const inspector = new Session();
inspector.connect();
function ownerBytes(node: HeapProfiler.SamplingHeapProfileNode, owned = false): number {
  // V8 can inline jsonLength into the prompt-stat owner after warmup.
  const underOwner =
    owned ||
    node.callFrame.functionName === "jsonLength" ||
    node.callFrame.functionName === "streamContextModelPromptStats";
  return (
    (underOwner ? node.selfSize : 0) +
    node.children.reduce((sum, child) => sum + ownerBytes(child, underOwner), 0)
  );
}
async function profile(includeCollected: boolean) {
  global.gc!();
  await inspector.post("HeapProfiler.startSampling", {
    samplingInterval: 512,
    includeObjectsCollectedByMajorGC: includeCollected,
    includeObjectsCollectedByMinorGC: includeCollected,
  });
  console.log(`PROFILE_START ${includeCollected ? "allocation" : "retained"}`);
  const start = performance.now();
  for (let index = 0; index < calls; index++) {
    measure(context);
    if (index % 100 === 99) {
      await nextTurn();
    }
  }
  const elapsedMs = performance.now() - start;
  console.log("PROFILE_END");
  if (!includeCollected) {
    await nextTurn();
    global.gc!();
  }
  const { profile: result } = await inspector.post("HeapProfiler.stopSampling");
  return { bytesPerCall: ownerBytes(result.head) / calls, elapsedMs };
}
const allocation = await profile(true);
const retainedChurn = await profile(false);
inspector.disconnect();
assert.deepEqual(measure(context), expected);
console.log(
  JSON.stringify({
    node: process.version,
    calls,
    messages: messages.length,
    promptChars: expected.totalChars,
    newRecordsPerWarmCall: warmRecords,
    allocatedBytesPerCall: allocation.bytesPerCall,
    retainedChurnBytesPerCall: retainedChurn.bytesPerCall,
    profiledMsPerCall: allocation.elapsedMs / calls,
  }),
);
