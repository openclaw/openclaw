/**
 * After-turn context owner CPU/allocation proof (synthetic, no Gateway).
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/after-turn-context-measure.ts
 *   [--owner-file <saved-attempt-prompt-helpers.ts>] [--mode cpu|allocation|major]
 * Run baseline/candidate in counterbalanced order. Allocation and major-retained
 * sampling are separate from CPU. Major mode includes live objects and excludes
 * minor-collected objects; it is not a measurement of exact promoted bytes.
 */
import assert from "node:assert/strict";
import { hash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { registerHooks } from "node:module";
import { loadavg } from "node:os";
import { setImmediate } from "node:timers/promises";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    "owner-file": { type: "string" },
    mode: { type: "string", default: "cpu" },
  },
});
assert(["cpu", "allocation", "major"].includes(values.mode));
const ownerUrl = new URL(
  "../../src/agents/embedded-agent-runner/run/attempt-prompt-helpers.ts",
  import.meta.url,
);
const source = readFileSync(values["owner-file"] ?? ownerUrl, "utf8");
let replaced = false;
if (values["owner-file"]) {
  registerHooks({
    load(url, context, nextLoad) {
      if (url === ownerUrl.href) {
        replaced = true;
        return { format: "module-typescript", source, shortCircuit: true };
      }
      return nextLoad(url, context);
    },
  });
}
const { buildAfterTurnRuntimeContext } =
  await import("../../src/agents/embedded-agent-runner/run/attempt-prompt-helpers.js");
assert(!values["owner-file"] || replaced, "Baseline owner was not loaded");
// Attempt objects carry many unrelated request, tool, replay and callback fields.
// Exercise both a narrow input and a 160-field attempt-width sensitivity control.
const baseAttempt = {
  sessionId: "synthetic-session",
  sessionKey: "agent:main:synthetic",
  provider: "openai",
  modelId: "gpt-5.4",
  thinkLevel: "off" as const,
  agentHarnessId: "openclaw",
  modelSelectionLocked: true,
  trigger: "user" as const,
  config: {
    plugins: {
      entries: Object.fromEntries(
        Array.from({ length: 40 }, (_, i) => [`synthetic-${i}`, { enabled: true }]),
      ),
    },
  },
  toolsAllow: ["read", "exec"],
  extraSystemPrompt: "synthetic context".repeat(1024),
};
const inspector = new Session();
if (values.mode !== "cpu") {
  inspector.connect();
}
try {
  for (const width of [Object.keys(baseAttempt).length, 160]) {
    const attempt = {
      ...Object.fromEntries(
        Array.from({ length: width - Object.keys(baseAttempt).length }, (_, i) => [
          `unused-${i}`,
          undefined,
        ]),
      ),
      ...baseAttempt,
    };
    const params = {
      attempt,
      workspaceDir: "/synthetic",
      agentDir: "/synthetic/agent",
      activeAgentId: "main",
      tokenBudget: 128000,
      currentTokenCount: 64000,
    };
    const invoke = () => buildAfterTurnRuntimeContext(params);
    let result = invoke();
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
    const operations = 10000;
    const cpu = process.threadCpuUsage();
    const started = performance.now();
    for (let i = 0; i < operations; i++) {
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
      sampledBytes = 0;
      const nodes = [profile.head];
      for (const node of nodes) {
        sampledBytes += node.selfSize;
        nodes.push(...node.children);
      }
    }
    assert.equal(hash("sha256", JSON.stringify(result)), digest);
    console.log(
      JSON.stringify({
        mode: values.mode,
        width,
        operations,
        sourceSha256: hash("sha256", source),
        digest,
        cpuUsPerOp: (used.user + used.system) / operations,
        elapsedMs,
        sampledBytesPerOp: sampledBytes === undefined ? undefined : sampledBytes / operations,
        hostLoad: loadavg(),
        heapUsed: process.memoryUsage().heapUsed,
      }),
    );
  }
} finally {
  if (values.mode !== "cpu") {
    inspector.disconnect();
  }
}
