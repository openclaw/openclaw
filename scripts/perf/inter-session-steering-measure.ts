/**
 * Measures real AgentSession steering admission with synthetic inter-session input.
 * Run on each revision, separately for timing and sampled allocation:
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/inter-session-steering-measure.ts --mode timing --iterations 5000
 * Repeat with --mode allocation. Startup and fixture preparation are excluded.
 * The session has 1,000 history entries; each admitted message is
 * withdrawn before execution. This measures producer overhead, not cache hits
 * or whole-Gateway throughput. Prefix correctness belongs to the steering test.
 * --scenario checkpoint --hold-ms 100 measures input admitted during request
 * preparation, with a controlled model-response hold. Compare separate baseline
 * and candidate processes; unchanged baseline processes provide A/A controls.
 * --state-dir accepts only a generated team-shape fixture; --workspace selects
 * its populated worktree. Each process creates a fresh session in that database.
 * --scenario tool-boundary measures the embedded delivery owner during a held tool.
 * Use --hold-ms 120100 --warmup 0 to cross the historical implicit deadline.
 * --baseline-dir loads a sparse owner overlay before importing runtime modules.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { HeapProfiler } from "node:inspector";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import { Type } from "typebox";
import {
  config,
  user,
  makeAssistantMessage,
  reply,
} from "../../packages/agent-core/src/agent-loop.test-support.js";
import { Agent } from "../../packages/agent-core/src/agent.js";
import {
  getInternalBeforeRequest,
  setInternalBeforeRequest,
} from "../../packages/agent-core/src/internal-hooks.js";
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
    scenario: { type: "string", default: "admission" },
    "hold-ms": { type: "string", default: "100" },
    "state-dir": { type: "string" },
    workspace: { type: "string" },
    warmup: { type: "string" },
    "baseline-dir": { type: "string" },
  },
});
const iterations = Number(values.iterations);
assert(Number.isSafeInteger(iterations) && iterations > 0);
assert(values.mode === "timing" || values.mode === "allocation");
assert(["admission", "checkpoint", "tool-boundary"].includes(values.scenario));
if (values["baseline-dir"]) {
  process.env.OPENCLAW_BENCH_BASELINE_DIR = path.resolve(values["baseline-dir"]);
  await import("./worker-retained-heap-preload.ts");
}
const { steerActiveSessionWithOptionalDeliveryWait } =
  await import("../../src/agents/embedded-agent-runner/run/attempt-queue-message.js");
const holdMs = Number(values["hold-ms"]);
assert(Number.isFinite(holdMs) && holdMs >= 0);
const stateDir = values["state-dir"] && path.resolve(values["state-dir"]);
let manager: SessionManager;
if (stateDir) {
  const fixture = JSON.parse(
    await readFile(path.join(stateDir, "team-shape-summary.json"), "utf8"),
  );
  assert.equal(fixture.format, "openclaw-team-shape-v1");
  process.env.OPENCLAW_STATE_DIR = stateDir;
  process.env.OPENCLAW_CONFIG_PATH = path.join(stateDir, "openclaw.json");
  const { upsertSessionEntryCore } = await import("../../src/config/sessions/session-accessor.js");
  const sessionId = randomUUID();
  const target = {
    agentId: "main",
    sessionId,
    sessionKey: `agent:main:steering-measure:${sessionId}`,
    storePath: path.join(stateDir, "agents", "main", "agent", "openclaw-agent.sqlite"),
  };
  await upsertSessionEntryCore(target, { sessionId, updatedAt: Date.now() });
  manager = await SessionManager.openAsync(
    target,
    values.workspace ? path.resolve(values.workspace) : path.join(stateDir, "workspace"),
  );
} else {
  manager = SessionManager.inMemory();
}
const resources = new DefaultResourceLoader({
  cwd: manager.getCwd(),
  agentDir: manager.getCwd(),
});
await resources.reload();
let toolStarted = Promise.withResolvers<void>();
let turnRequests = 0;
const agent = new Agent({
  streamFn: () => {
    throw new Error("Withdrawn steering must not start inference");
  },
  initialState: {
    model: config.model,
    tools:
      values.scenario === "tool-boundary"
        ? [
            {
              name: "hold",
              label: "hold",
              description: "Synthetic held tool",
              parameters: Type.Object({}),
              execute: async () => {
                toolStarted.resolve();
                await delay(holdMs);
                return { content: [{ type: "text" as const, text: "Tool complete" }], details: {} };
              },
            },
          ]
        : [],
    messages: Array.from({ length: 1000 }, (_, index) => user(`Synthetic history ${index}`, index)),
  },
});
const auth = AuthStorage.inMemory();
auth.setRuntimeApiKey(config.model.provider, "synthetic-benchmark-key");
const session = new AgentSession({
  agent,
  systemPrompt: "Synthetic steering probe",
  sessionManager: manager,
  settingsManager: SettingsManager.inMemory({ compaction: { enabled: false } }),
  cwd: manager.getCwd(),
  resourceLoader: resources,
  modelRegistry: ModelRegistry.inMemory(auth),
  customTools: agent.state.tools,
  allowedToolNames: values.scenario === "tool-boundary" ? ["hold"] : [],
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
const injectionMs: number[] = [];
const acceptanceMs: number[] = [];
const outcomes: string[] = [];
let requestCount = 0;
let sentAt = 0;
let checkpointArrival = false;
if (values.scenario === "checkpoint") {
  const prepare = getInternalBeforeRequest(agent);
  setInternalBeforeRequest(agent, async (signal) => {
    const messages = await prepare?.(signal);
    if (checkpointArrival) {
      checkpointArrival = false;
      sentAt = performance.now();
      await session.steer(text, undefined, recorder);
    }
    return messages;
  });
  session.subscribe((event) => {
    if (
      event.type === "message_end" &&
      event.message.role === "user" &&
      JSON.stringify(event.message.content).includes(text)
    ) {
      injectionMs.push(performance.now() - sentAt);
    }
  });
  agent.streamFn = async () => {
    requestCount++;
    await delay(holdMs);
    return reply(makeAssistantMessage([{ type: "text", text: "Synthetic response" }]));
  };
}
if (values.scenario === "tool-boundary") {
  agent.streamFn = () => {
    requestCount++;
    const first = ++turnRequests === 1;
    return reply(
      makeAssistantMessage(
        first
          ? [{ type: "toolCall", id: randomUUID(), name: "hold", arguments: {} }]
          : [{ type: "text", text: "Synthetic response" }],
      ),
    );
  };
}
async function run(count: number) {
  for (let index = 0; index < count; index++) {
    if (values.scenario === "tool-boundary") {
      toolStarted = Promise.withResolvers<void>();
      turnRequests = 0;
      const active = session.prompt("Run the held tool");
      await Promise.race([
        toolStarted.promise,
        active.then(() => {
          throw new Error("Synthetic turn ended before starting its held tool");
        }),
      ]);
      const started = performance.now();
      const result = await steerActiveSessionWithOptionalDeliveryWait(session, text, {
        waitForTranscriptCommit: true,
        onQueueAccepted: (accepted) => {
          assert(accepted);
          acceptanceMs.push(performance.now() - started);
        },
      }).then(
        () => "committed",
        (error: unknown) => {
          if (error instanceof Error && error.name === "MessageInjectionWithdrawnError") {
            return "withdrawn";
          }
          throw error;
        },
      );
      injectionMs.push(performance.now() - started);
      outcomes.push(result);
      await active;
      assert.equal(session.getSteeringMessages().length, 0);
    } else if (values.scenario === "checkpoint") {
      checkpointArrival = true;
      const delivered = injectionMs.length;
      await session.prompt("Synthetic current request");
      assert.equal(injectionMs.length, delivered + 1);
      assert.equal(session.getSteeringMessages().length, 0);
    } else {
      await session.steer(text, undefined, recorder);
      assert.equal(session.clearQueue().steering.length, 1);
    }
  }
}
const warmup = Number(values.warmup ?? (values.scenario === "admission" ? 500 : 5));
assert(Number.isSafeInteger(warmup) && warmup >= 0);
await run(warmup);
injectionMs.length = 0;
acceptanceMs.length = 0;
outcomes.length = 0;
requestCount = 0;
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
const processCpu = process.cpuUsage();
const start = performance.now();
await run(iterations);
const elapsedMs = performance.now() - start;
const used = process.threadCpuUsage(cpu);
const processUsed = process.cpuUsage(processCpu);
let allocatedBytes: number | undefined;
if (values.mode === "allocation") {
  const { profile } = await inspector.post("HeapProfiler.stopSampling");
  inspector.disconnect();
  const sum = (node: HeapProfiler.SamplingHeapProfileNode): number =>
    node.selfSize + node.children.reduce((total, child) => total + sum(child), 0);
  allocatedBytes = sum(profile.head);
}
session.dispose();
if (stateDir) {
  const { cleanupSessionStateForTest } =
    await import("../../src/test-utils/session-state-cleanup.js");
  await cleanupSessionStateForTest({ stateDir });
}
console.log(
  JSON.stringify({
    mode: values.mode,
    scenario: values.scenario,
    iterations,
    hostLoad,
    elapsedMs,
    mainThreadCpuNsPerSteer: ((used.user + used.system) * 1000) / iterations,
    processCpuNsPerSteer: ((processUsed.user + processUsed.system) * 1000) / iterations,
    allocatedBytesPerSteer: allocatedBytes === undefined ? undefined : allocatedBytes / iterations,
    ...(values.scenario !== "admission"
      ? { holdMs, injectionMs, requestCount, acceptanceMs, outcomes }
      : {}),
  }),
);
