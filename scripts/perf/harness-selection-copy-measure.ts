/**
 * Built-in harness handoff owner probe; synthetic state, no Gateway/provider.
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/harness-selection-copy-measure.ts
 *   --source <saved-selection.ts> --mode timing|allocation|major|promotion|counts --iterations 3000
 * Alternate five base/candidate pairs per mode. Counts supports --expect-copies 1
 * as a regression check (the old owner retains two distinct full-width copies).
 * Counts also supports --expect-authority-properties 7 for the narrow authority handoff.
 * Executes the exact rest/handoff block, authority callback, and private helper from source;
 * does not export a production test seam. Plugin handoffs are outside this probe.
 * 205-property attempts, 40 plugin configs, 64 concurrent handoffs held across awaits.
 * Allocation includes collected samples; major excludes minor-collected samples
 * and collects young garbage after timing, before reading its endpoint profile.
 * Promotion requires --trace-gc-nvp; sum promoted= bytes only between
 * HARNESS_SELECTION_MEASURE_START and HARNESS_SELECTION_MEASURE_END. No forced GC
 * occurs within that trace window. Use 30000 or 100000 iterations for natural GC.
 * MiB/min is this owner workload's rate, NOT a production or whole-Gateway estimate.
 * Acceptance: equal handoff contents, preserved caller, one owned copy, lower
 * allocation/CPU. Timing is untraced; sampling passes do not gate latency or GC.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, writeSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { stripTypeScriptTypes } from "node:module";
import { loadavg } from "node:os";
import { setImmediate as nextTurn } from "node:timers/promises";
import { parseArgs } from "node:util";
import { compileFunction } from "node:vm";
import { isRecord } from "../../packages/normalization-core/src/record-coerce.ts";
import {
  copyChannelSourceTurnContext,
  readChannelSourceTurnId,
  readChannelSourceTurnSameThreadRequired,
  setChannelSourceTurnId,
  setChannelSourceTurnSameThreadRequired,
} from "../../src/auto-reply/reply/source-turn-id.ts";

const { values } = parseArgs({
  options: {
    source: { type: "string", default: "src/agents/harness/selection.ts" },
    mode: { type: "string", default: "timing" },
    iterations: { type: "string", default: "3000" },
    "expect-copies": { type: "string" },
    "expect-authority-properties": { type: "string" },
    output: { type: "string" },
  },
});
const iterations = Number(values.iterations);
assert(Number.isSafeInteger(iterations) && iterations > 0 && iterations <= 100_000);
assert(["timing", "allocation", "major", "promotion", "counts"].includes(values.mode));
assert(global.gc, "Use --expose-gc");
if (values.mode === "promotion") {
  assert(process.execArgv.includes("--trace-gc-nvp"), "Promotion requires --trace-gc-nvp");
}
const source = readFileSync(values.source, "utf8");
const start = source.indexOf("  const {\n    contextEngineLogicalTurnLease:");
const end = source.indexOf("  let result: EmbeddedRunAttemptResult;", start);
const helper = source.indexOf("function withoutInternalHarnessAuthority(");
assert(start >= 0 && end > start && helper > end, "Owner source boundaries changed");
const callbackMarker = "({ withPreparedEmbeddedRunToolAuthority }) =>";
const callbackStart = source.indexOf(callbackMarker, end);
const callbackEnd = source.indexOf("\n          );", callbackStart);
assert(callbackStart > end && callbackEnd > callbackStart, "Authority callback boundaries changed");
const authorityCallback = source.slice(callbackStart, callbackEnd).trim().replace(/,$/, "");
type Handoff = {
  attemptParams: Record<string, unknown>;
  pluginAttempt: { params: Record<string, unknown> };
  authorityParams: Record<string, unknown>;
};
const compiled = compileFunction(
  `${stripTypeScriptTypes(`
    ${source.slice(helper)}
    const selection = { builtIn: true, ownerPluginId: undefined };
    const harness = { id: "openclaw" };
    ${source.slice(start, end)}
    const effectiveAttemptParams = pluginAttempt.params;
    const authorityParams = (${authorityCallback})({
      withPreparedEmbeddedRunToolAuthority: captureToolAuthority,
    });
  `)}\nreturn { attemptParams, pluginAttempt, authorityParams };`,
  ["internalParams", "queueInputAdapter", "copyChannelSourceTurnContext", "captureToolAuthority"],
  { filename: values.source },
);
function isHandoff(value: unknown): value is Handoff {
  return (
    isRecord(value) &&
    isRecord(value.attemptParams) &&
    isRecord(value.pluginAttempt) &&
    isRecord(value.pluginAttempt.params) &&
    isRecord(value.authorityParams)
  );
}
function prepare(input: Record<string, unknown>): Handoff {
  const value: unknown = compiled(
    input,
    queueInputAdapter,
    copyChannelSourceTurnContext,
    captureToolAuthority,
  );
  assert(isHandoff(value), "Compiled owner returned an invalid handoff");
  return value;
}
const queueInputAdapter = "human-and-question-permission";
const captureToolAuthority = (internal: Record<string, unknown>) => internal;
const instance = { runId: "synthetic-run", instanceId: "synthetic-instance" };
const input: Record<string, unknown> = {
  admittedRunContext: { operationalRunInstance: instance },
  replyOperation: { synthetic: true },
  sessionPersistence: "durable",
  trigger: "user",
  bindWatchdogAttempt: () => {},
  joinObservation: { synthetic: true },
  config: {
    plugins: {
      entries: Object.fromEntries(
        Array.from({ length: 40 }, (_, i) => [`synthetic-${i}`, { enabled: true }]),
      ),
    },
  },
  sessionKey: "agent:main:synthetic",
  prompt: "synthetic prompt ".repeat(1024),
  toolsAllow: ["read", "exec"],
  contextEngineLogicalTurnLease: { synthetic: true },
  systemAgentTool: { synthetic: true },
};
for (let i = Object.keys(input).length; i < 205; i++) {
  input[`optionalAttemptField${i}`] = undefined;
}
setChannelSourceTurnId(input, "channel-user:v1:synthetic");
setChannelSourceTurnSameThreadRequired(input, true);
Object.freeze(input);
const beforeInput = Object.getOwnPropertyDescriptors(input);
const { contextEngineLogicalTurnLease: _lease, systemAgentTool: _tool, ...expected } = input;
expected.operationalRunInstance = instance;
const golden = prepare(input);
assert.deepEqual(golden.pluginAttempt.params, expected);
assert.notEqual(golden.pluginAttempt.params, input);
for (const key of [
  "admittedRunContext",
  "replyOperation",
  "sessionPersistence",
  "trigger",
  "bindWatchdogAttempt",
  "joinObservation",
]) {
  assert.equal(golden.authorityParams[key], input[key], `authority ${key} identity`);
}
assert.equal(golden.authorityParams.queueInputAdapter, queueInputAdapter);
assert.equal(readChannelSourceTurnId(golden.authorityParams), readChannelSourceTurnId(input));
assert.equal(readChannelSourceTurnSameThreadRequired(golden.authorityParams), true);
assert.deepEqual(Object.getOwnPropertyDescriptors(input), beforeInput);
const retainedCopies = new Set([golden.attemptParams, golden.pluginAttempt.params]).size;
const authorityProperties = Object.keys(golden.authorityParams).length;
const authorityOwnKeys = Reflect.ownKeys(golden.authorityParams).length;
if (values["expect-copies"] !== undefined) {
  assert.equal(values.mode, "counts");
  assert.equal(retainedCopies, Number(values["expect-copies"]), "retained full-width copies");
}
if (values["expect-authority-properties"] !== undefined) {
  assert.equal(values.mode, "counts");
  assert.equal(
    authorityProperties,
    Number(values["expect-authority-properties"]),
    "authority properties",
  );
}
async function workload(count: number) {
  for (let offset = 0; offset < count; offset += 64) {
    const pending = Array.from({ length: Math.min(64, count - offset) }, () => prepare(input));
    await nextTurn();
    for (const handoff of pending) {
      assert.equal(handoff.pluginAttempt.params.operationalRunInstance, instance);
      assert.equal(handoff.attemptParams.runtimePluginToolGrant, undefined);
      assert.equal(handoff.authorityParams.admittedRunContext, input.admittedRunContext);
      assert.equal(
        readChannelSourceTurnId(handoff.authorityParams),
        readChannelSourceTurnId(input),
      );
    }
  }
}
await workload(256);
global.gc();
const inspector = new Session();
const sampled = values.mode === "allocation" || values.mode === "major";
if (sampled) {
  inspector.connect();
  await inspector.post("HeapProfiler.startSampling", {
    samplingInterval: 4096,
    includeObjectsCollectedByMajorGC: true,
    includeObjectsCollectedByMinorGC: values.mode === "allocation",
  });
}
const memoryBefore = process.memoryUsage();
const hostLoadBefore = loadavg();
if (values.mode === "promotion") {
  writeSync(1, "HARNESS_SELECTION_MEASURE_START\n");
}
const cpu = process.threadCpuUsage();
const startTime = performance.now();
if (values.mode !== "counts") {
  await workload(iterations);
}
const elapsedMs = performance.now() - startTime;
const used = process.threadCpuUsage(cpu);
if (values.mode === "promotion") {
  writeSync(1, "HARNESS_SELECTION_MEASURE_END\n");
}
const memoryAfter = process.memoryUsage();
let sampledBytes: number | undefined;
if (sampled) {
  if (values.mode === "major") {
    global.gc({ type: "minor", execution: "sync" });
  }
  const { profile } = await inspector.post("HeapProfiler.stopSampling");
  sampledBytes = profile.samples.reduce((sum, sample) => sum + sample.size, 0);
  if (values.output) {
    writeFileSync(`${values.output}.heapprofile`, JSON.stringify(profile));
  }
  inspector.disconnect();
}
assert.deepEqual(Object.getOwnPropertyDescriptors(input), beforeInput);
const result = {
  mode: values.mode,
  sourceSha256: createHash("sha256").update(source).digest("hex"),
  outputSha256: createHash("sha256").update(JSON.stringify(expected)).digest("hex"),
  properties: Object.keys(input).length,
  retainedCopies,
  authorityProperties,
  authorityOwnKeys,
  iterations,
  elapsedMs,
  cpuUsPerAttempt: (used.user + used.system) / iterations,
  sampledBytesPerAttempt: sampledBytes === undefined ? undefined : sampledBytes / iterations,
  sampledMiBPerMinute:
    sampledBytes === undefined ? undefined : (sampledBytes / 1024 ** 2 / elapsedMs) * 60_000,
  memoryBefore,
  memoryAfter,
  hostLoadBefore,
  hostLoadAfter: loadavg(),
};
if (values.output) {
  writeFileSync(values.output, `${JSON.stringify(result, null, 2)}\n`);
}
console.log(JSON.stringify(result));
