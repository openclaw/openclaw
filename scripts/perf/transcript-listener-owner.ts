/**
 * Real in-memory SDK session/attempt cleanup benchmark, isolated from Gateway I/O.
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/transcript-listener-owner.ts
 *   --output <json> [--baseline-dir <exact-source-overlay>] [--allocations]
 * Alternate fresh baseline/candidate processes; use unchanged runs for A/A.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { registerHooks } from "node:module";
import { loadavg } from "node:os";
import path from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { queryObjects } from "node:v8";
import { transformSync } from "esbuild";

const { values } = parseArgs({
  options: {
    output: { type: "string" },
    "baseline-dir": { type: "string" },
    operations: { type: "string", default: "1000" },
    allocations: { type: "boolean" },
    profile: { type: "boolean" },
  },
});
assert(values.output && global.gc, "Pass --output and run with --expose-gc");
const operations = Number(values.operations);
assert(Number.isSafeInteger(operations) && operations > 0);
const output = path.resolve(values.output);
mkdirSync(path.dirname(output), { recursive: true });
const fixture = `${output}.state`;
mkdirSync(fixture);
Object.assign(process.env, { OPENCLAW_STATE_DIR: fixture, OPENCLAW_HOME: fixture });
const root = fileURLToPath(new URL("../../", import.meta.url));
if (values["baseline-dir"]) {
  const baseline = path.resolve(values["baseline-dir"]);
  registerHooks({
    load(url, context, nextLoad) {
      if (!url.startsWith("file:") || !url.endsWith(".ts")) {
        return nextLoad(url, context);
      }
      const file = path.join(baseline, path.relative(root, fileURLToPath(url)));
      if (!existsSync(file)) {
        return nextLoad(url, context);
      }
      return {
        format: "module",
        source: transformSync(readFileSync(file, "utf8"), {
          loader: "ts",
          format: "esm",
          target: "esnext",
        }).code,
        shortCircuit: true,
      };
    },
  });
}
const [
  { createAgentSession },
  { SessionManager },
  { AgentSession },
  { AuthStorage },
  { ModelRegistry },
  { SettingsManager },
  { DefaultResourceLoader },
  { createAssistantMessageEventStream },
  { cleanupEmbeddedAttemptSessionPhase },
  { createEmbeddedAttemptTranscriptLifecycle },
  { makeProviderModelFixture },
  { createZeroUsageFixture },
] = await Promise.all([
  import("../../src/agents/sessions/sdk.ts"),
  import("../../src/agents/sessions/session-manager.ts"),
  import("../../src/agents/sessions/agent-session.ts"),
  import("../../src/agents/sessions/auth-storage.ts"),
  import("../../src/agents/sessions/model-registry.ts"),
  import("../../src/agents/sessions/settings-manager.ts"),
  import("../../src/agents/sessions/resource-loader.ts"),
  import("../../src/llm/utils/event-stream.ts"),
  import("../../src/agents/embedded-agent-runner/run/attempt-session-settle.ts"),
  import("../../src/agents/embedded-agent-runner/run/attempt-transcript-lifecycle.ts"),
  import("../../src/agents/test-helpers/provider-model-fixture.ts"),
  import("../../src/agents/test-helpers/usage-fixtures.ts"),
]);
const model = makeProviderModelFixture({
  id: "synthetic-model",
  provider: "synthetic-provider",
  api: "openai-responses",
  baseUrl: "https://example.invalid",
});
const authStorage = AuthStorage.inMemory();
authStorage.setRuntimeApiKey(model.provider, "synthetic-key");
const modelRegistry = ModelRegistry.inMemory(authStorage);
modelRegistry.registerProvider(model.provider, {
  api: model.api,
  streamSimple: (activeModel) => {
    const stream = createAssistantMessageEventStream();
    stream.push({
      type: "done",
      reason: "stop",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Done" }],
        api: activeModel.api,
        provider: activeModel.provider,
        model: activeModel.id,
        usage: createZeroUsageFixture(),
        stopReason: "stop",
        timestamp: 1,
      },
    });
    stream.end();
    return stream;
  },
});
const settingsManager = SettingsManager.inMemory({
  compaction: { enabled: false },
  retry: { enabled: false },
});
const resourceLoader = new DefaultResourceLoader({
  cwd: fixture,
  agentDir: path.join(fixture, "agent"),
  extensionFactories: [],
});
await resourceLoader.reload();
async function operation(index: number, fail: boolean) {
  const lifecycle = createEmbeddedAttemptTranscriptLifecycle({
    onDrained: () => {
      if (fail) {
        throw new Error("Synthetic release failure");
      }
    },
  });
  const sessionManager = SessionManager.inMemory();
  await sessionManager.appendMessageAsync({
    role: "user",
    content: Buffer.alloc(65536, 65 + (index % 26)).toString(),
    timestamp: 1,
  });
  const { session } = await createAgentSession({
    model,
    modelRegistry,
    settingsManager,
    resourceLoader,
    sessionManager,
    systemPrompt: "Synthetic session",
    thinkingLevel: "off",
    tools: [],
    withSessionWriteSettlement: (run) => lifecycle.withTranscriptWrite(run),
  });
  await session.prompt("Finish this synthetic turn.");
  try {
    await cleanupEmbeddedAttemptSessionPhase({
      attempt: { sessionId: sessionManager.getSessionId(), runId: `synthetic-${index}` },
      session,
      sessionManager,
      trajectoryRecorder: null,
      trajectoryEndRecorded: false,
      buildAbortSettlePromise: () => null,
      state: { terminal: { kind: "ok" }, beforeAgentRunBlockedBy: undefined },
      transcriptLifecycle: lifecycle,
    });
    assert(!fail, "Expected release failure");
  } catch (error) {
    assert(fail && error instanceof Error && error.message === "Synthetic release failure");
  }
}
for (let index = 0; index < 20; index++) {
  await operation(index, false);
}
await nextTurn();
const listeners = Reflect.get(
  globalThis,
  Symbol.for("openclaw.internalSessionTranscriptListeners"),
) as Set<unknown>;
const capture = () => {
  global.gc!();
  const managers = queryObjects(SessionManager, { format: "count" });
  const sessions = queryObjects(AgentSession, { format: "count" });
  global.gc!();
  return {
    listeners: listeners.size,
    managers,
    sessions,
    heapUsed: process.memoryUsage().heapUsed,
  };
};
const before = capture();
const profiler = new Session();
profiler.connect();
if (values.profile) {
  await profiler.post("Profiler.enable");
  await profiler.post("Profiler.start");
}
if (values.allocations) {
  await profiler.post("HeapProfiler.startSampling", {
    samplingInterval: 16384,
    includeObjectsCollectedByMajorGC: true,
    includeObjectsCollectedByMinorGC: true,
  });
}
const hostLoad = loadavg();
const cpuStart = process.threadCpuUsage();
const start = performance.now();
const timings: number[] = [];
for (let index = 0; index < operations; index++) {
  const begin = performance.now();
  await operation(index, index % 5 === 0);
  timings.push(performance.now() - begin);
}
const elapsedMs = performance.now() - start;
const cpu = process.threadCpuUsage(cpuStart);
if (values.profile) {
  const { profile } = await profiler.post("Profiler.stop");
  writeFileSync(`${output}.cpuprofile`, JSON.stringify(profile));
}
let allocationBytes: number | undefined;
if (values.allocations) {
  const { profile } = await profiler.post("HeapProfiler.stopSampling");
  const sum = (node: typeof profile.head): number =>
    node.selfSize + node.children.reduce((total, child) => total + sum(child), 0);
  allocationBytes = sum(profile.head);
}
profiler.disconnect();
await nextTurn();
const after = capture();
timings.sort((a, b) => a - b);
const result = {
  operations,
  before,
  after,
  elapsedMs,
  cpuMs: (cpu.user + cpu.system) / 1000,
  p50Ms: timings[Math.floor(timings.length * 0.5)],
  p95Ms: timings[Math.floor(timings.length * 0.95)],
  allocationBytes,
  hostLoad,
  hostLoadEnd: loadavg(),
  baseline: values["baseline-dir"],
  node: process.version,
};
writeFileSync(output, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result));
