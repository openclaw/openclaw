/**
 * Tool-context preparation CPU/allocation proof; synthetic, no Gateway or credentials.
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/attempt-tool-context-measure.ts
 *   --arm base|candidate --mode cpu|allocation|major --iterations 10000
 * Run five counterbalanced pairs per mode. Base reproduces the old caller's spread;
 * both arms invoke the real context builder with identical facts and overrides.
 * Width 205 models an attempt's unrelated fields; width 12 is a sensitivity control.
 * Acceptance: identical output and lower CPU/allocation with no new retained state.
 * Major sampling excludes minor-collected objects, not an exact promotion counter.
 * This bounded owner probe does not establish whole-Gateway latency or throughput.
 */
import assert from "node:assert/strict";
import { hash } from "node:crypto";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import { setImmediate } from "node:timers/promises";
import { parseArgs } from "node:util";
import { buildEmbeddedAttemptToolRunContext } from "../../src/agents/embedded-agent-runner/run/attempt-tool-run-context.js";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.js";

const { values } = parseArgs({
  options: {
    arm: { type: "string" },
    mode: { type: "string", default: "cpu" },
    iterations: { type: "string", default: "10000" },
  },
});
assert(values.arm === "base" || values.arm === "candidate");
assert(["cpu", "allocation", "major"].includes(values.mode));
const iterations = parseStrictIntegerOption({
  raw: values.iterations,
  fallback: 10000,
  min: 1,
  label: "--iterations",
});
const facts = {
  sessionId: "synthetic-session",
  sessionKey: "agent:main:synthetic",
  model: { provider: "synthetic", id: "synthetic-model" },
  toolsAllow: ["read", "exec"],
  clientCaps: ["inline-widgets"],
  memberRoleIds: ["synthetic-role"],
  currentInboundAudio: false,
  replyOperation: { acceptedSteeredInboundAudio: false },
  config: {
    plugins: {
      entries: Object.fromEntries(
        Array.from({ length: 40 }, (_, i) => [`synthetic-${i}`, { enabled: true }]),
      ),
    },
  },
  extraSystemPrompt: "synthetic context".repeat(1024),
  forceMessageTool: false,
  trace: { traceId: "11111111111111111111111111111111" },
};
const overrides = {
  forceMessageTool: true,
  trace: { traceId: "22222222222222222222222222222222" },
};
const inspector = new Session();
if (values.mode !== "cpu") {
  inspector.connect();
}
try {
  for (const width of [Object.keys(facts).length, 205]) {
    const attempt = {
      ...Object.fromEntries(
        Array.from({ length: width - Object.keys(facts).length }, (_, i) => [
          `unrelated-${i}`,
          undefined,
        ]),
      ),
      ...facts,
    };
    const invoke: () => ReturnType<typeof buildEmbeddedAttemptToolRunContext> =
      values.arm === "base"
        ? () =>
            buildEmbeddedAttemptToolRunContext({
              ...attempt,
              forceMessageTool: overrides.forceMessageTool,
              trace: overrides.trace,
            })
        : () => buildEmbeddedAttemptToolRunContext(attempt, overrides);
    let result = invoke();
    assert.deepEqual(result.runtimeToolAllowlist, ["read", "exec", "message"]);
    assert.equal(result.trace?.traceId, overrides.trace.traceId);
    const digest = hash("sha256", JSON.stringify(result));
    for (let i = 0; i < 1000; i++) {
      result = invoke();
    }
    global.gc?.();
    if (values.mode !== "cpu") {
      await inspector.post("HeapProfiler.startSampling", {
        samplingInterval: 4096,
        includeObjectsCollectedByMajorGC: true,
        includeObjectsCollectedByMinorGC: values.mode === "allocation",
      });
    }
    const hostLoadBefore = loadavg();
    const cpu = process.threadCpuUsage();
    const started = performance.now();
    for (let i = 0; i < iterations; i++) {
      result = invoke();
      if ((i + 1) % 100 === 0) {
        await setImmediate();
      }
    }
    const elapsedMs = performance.now() - started;
    const used = process.threadCpuUsage(cpu);
    let sampledBytes: number | undefined;
    if (values.mode !== "cpu") {
      const { profile } = await inspector.post("HeapProfiler.stopSampling");
      sampledBytes = profile.samples.reduce((sum, sample) => sum + sample.size, 0);
    }
    assert.equal(hash("sha256", JSON.stringify(result)), digest);
    console.log(
      JSON.stringify({
        arm: values.arm,
        mode: values.mode,
        width,
        iterations,
        digest,
        cpuUsPerOp: (used.user + used.system) / iterations,
        elapsedMs,
        sampledBytesPerOp: sampledBytes === undefined ? undefined : sampledBytes / iterations,
        hostLoadBefore,
        hostLoadAfter: loadavg(),
        memory: process.memoryUsage(),
      }),
    );
  }
} finally {
  if (values.mode !== "cpu") {
    inspector.disconnect();
  }
}
