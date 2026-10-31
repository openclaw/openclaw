/**
 * Measures real AgentSession steering admission with synthetic inter-session input.
 * Run on each revision, separately for timing and sampled allocation:
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/inter-session-steering-measure.ts --mode timing --iterations 5000
 * Repeat with --mode allocation. Startup and fixture preparation are excluded.
 * The session has 1,000 history entries; each admitted message is
 * withdrawn before execution. This measures producer overhead, not cache hits
 * or whole-Gateway throughput. Prefix correctness belongs to the steering test.
 */
import assert from "node:assert/strict";
import type { HeapProfiler } from "node:inspector";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import { parseArgs } from "node:util";
import { config, user } from "../../packages/agent-core/src/agent-loop.test-support.js";
import { Agent } from "../../packages/agent-core/src/agent.js";
import { AgentSession } from "../../src/agents/sessions/agent-session.js";
import { AuthStorage } from "../../src/agents/sessions/auth-storage.js";
import { ModelRegistry } from "../../src/agents/sessions/model-registry.js";
import { DefaultResourceLoader } from "../../src/agents/sessions/resource-loader.js";
import { SessionManager } from "../../src/agents/sessions/session-manager.js";
import { SettingsManager } from "../../src/agents/sessions/settings-manager.js";
import { createUserTurnTranscriptRecorder } from "../../src/sessions/user-turn-transcript.js";

const { values } = parseArgs({
  options: {
    mode: { type: "string", default: "timing" },
    iterations: { type: "string", default: "5000" },
  },
});
const iterations = Number(values.iterations);
assert(Number.isSafeInteger(iterations) && iterations > 0);
assert(values.mode === "timing" || values.mode === "allocation");
const manager = SessionManager.inMemory();
const resources = new DefaultResourceLoader({
  cwd: manager.getCwd(),
  agentDir: manager.getCwd(),
});
await resources.reload();
const agent = new Agent({
  streamFn: () => {
    throw new Error("Withdrawn steering must not start inference");
  },
  initialState: {
    model: config.model,
    messages: Array.from({ length: 1000 }, (_, index) => user(`Synthetic history ${index}`, index)),
  },
});
const session = new AgentSession({
  agent,
  systemPrompt: "Synthetic steering probe",
  sessionManager: manager,
  settingsManager: SettingsManager.inMemory({ compaction: { enabled: false } }),
  cwd: manager.getCwd(),
  resourceLoader: resources,
  modelRegistry: ModelRegistry.inMemory(AuthStorage.inMemory()),
  allowedToolNames: [],
  cleanupProviderSessionResourcesOnDispose: false,
});
const text = "Synthetic delegated task completed. ".repeat(64);
const recorder = createUserTurnTranscriptRecorder({
  input: {
    text,
    timestamp: 1700000000000,
    idempotencyKey: "synthetic-steering:user",
    provenance: { kind: "inter_session", sourceTool: "subagent_settle" },
  },
  target: () => undefined,
});
async function run(count: number) {
  for (let index = 0; index < count; index++) {
    await session.steer(text, undefined, recorder);
    assert.equal(session.clearQueue().steering.length, 1);
  }
}
await run(500);
globalThis.gc?.();
const inspector = new Session();
if (values.mode === "allocation") {
  inspector.connect();
  await inspector.post("HeapProfiler.startSampling", {
    samplingInterval: 1024,
    includeObjectsCollectedByMajorGC: true,
    includeObjectsCollectedByMinorGC: true,
  });
}
const hostLoad = loadavg();
const cpu = process.threadCpuUsage();
const start = performance.now();
await run(iterations);
const elapsedMs = performance.now() - start;
const used = process.threadCpuUsage(cpu);
let allocatedBytes: number | undefined;
if (values.mode === "allocation") {
  const { profile } = await inspector.post("HeapProfiler.stopSampling");
  inspector.disconnect();
  const sum = (node: HeapProfiler.SamplingHeapProfileNode): number =>
    node.selfSize + node.children.reduce((total, child) => total + sum(child), 0);
  allocatedBytes = sum(profile.head);
}
session.dispose();
console.log(
  JSON.stringify({
    mode: values.mode,
    iterations,
    hostLoad,
    elapsedMs,
    mainThreadCpuNsPerSteer: ((used.user + used.system) * 1000) / iterations,
    allocatedBytesPerSteer: allocatedBytes === undefined ? undefined : allocatedBytes / iterations,
  }),
);
