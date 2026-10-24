import assert from "node:assert/strict";
import type { HeapProfiler } from "node:inspector";
import { Session } from "node:inspector/promises";
import { mock } from "node:test";
import { setImmediate as nextTurn } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { normalizeTranscriptJsonValue } from "../../src/config/sessions/transcript-json.js";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.ts";

const { values } = parseArgs({
  options: {
    calls: { type: "string", default: "1000" },
    messages: { type: "string", default: "500" },
    ownership: { type: "string", default: "mutable" },
    mode: { type: "string", default: "profile" },
    owner: { type: "string" },
  },
});
const {
  createModelPromptStats,
}: typeof import("../../src/agents/embedded-agent-runner/run/attempt.model-diagnostic-observation.js") =
  await import(
    values.owner
      ? pathToFileURL(values.owner).href
      : "../../src/agents/embedded-agent-runner/run/attempt.model-diagnostic-observation.js"
  );
const integer = (name: keyof typeof values) =>
  parseStrictIntegerOption({ raw: values[name], label: `--${name}`, min: 1, fallback: 1 });
const calls = integer("calls");
if (!["mutable", "content", "message"].includes(values.ownership)) {
  throw new Error("--ownership must be mutable, content or message");
}
if (!["profile", "timing"].includes(values.mode)) {
  throw new Error(
    "--mode must be profile or timing (use a separate --trace-gc-nvp timing pass for promotion)",
  );
}
const messages = Array.from({ length: integer("messages") }, (_, index) => {
  const message = {
    role: "user" as const,
    content: [
      {
        type: "text" as const,
        text: `${index}: ${'Quoted "text", café 🦞, lone \ud800 and newline\n'.repeat(200)}`,
      },
    ],
    timestamp: index,
  };
  if (values.ownership === "content") {
    normalizeTranscriptJsonValue(message, "");
  } else if (values.ownership === "message") {
    normalizeTranscriptJsonValue({ message }, "");
  }
  return message;
});
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
const coldCpu = process.cpuUsage();
const coldStart = performance.now();
const coldStats = measure(context);
const coldMs = performance.now() - coldStart;
const coldUsed = process.cpuUsage(coldCpu);
assert.deepEqual(coldStats, expected);
assert.deepEqual(measure(context), expected);

// Count payload traversal independently of timing and allocation instrumentation.
let payloadVisits = 0;
const nativeStringify = JSON.stringify;
const stringify = mock.method(JSON, "stringify", (value: unknown, replacer: unknown) => {
  assert.equal(typeof replacer, "function");
  return nativeStringify(value, function (key, part: unknown) {
    if (key === "text") {
      payloadVisits++;
    }
    return Reflect.apply(replacer as (...args: unknown[]) => unknown, this, [key, part]);
  });
});
try {
  measure(context);
} finally {
  stringify.mock.restore();
}

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
if (values.mode === "timing") {
  console.log("TIMING_START");
  const cpu = process.cpuUsage();
  const start = performance.now();
  for (let index = 0; index < calls; index++) {
    measure(context);
  }
  const elapsedMs = performance.now() - start;
  const used = process.cpuUsage(cpu);
  console.log("TIMING_END");
  console.log(
    JSON.stringify({
      node: process.version,
      calls,
      messages: messages.length,
      ownership: values.ownership,
      promptChars: expected.totalChars,
      payloadVisitsPerWarmCall: payloadVisits,
      coldMs,
      coldCpuMs: (coldUsed.user + coldUsed.system) / 1000,
      cpuMsPerCall: (used.user + used.system) / 1000 / calls,
      msPerCall: elapsedMs / calls,
    }),
  );
  process.exit(0);
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
    ownership: values.ownership,
    promptChars: expected.totalChars,
    newRecordsPerWarmCall: warmRecords,
    payloadVisitsPerWarmCall: payloadVisits,
    allocatedBytesPerCall: allocation.bytesPerCall,
    retainedChurnBytesPerCall: retainedChurn.bytesPerCall,
    profiledMsPerCall: allocation.elapsedMs / calls,
  }),
);
