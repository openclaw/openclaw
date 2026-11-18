/** Restored-session mode of anthropic-request-construction.ts; synthetic data only. */
import assert from "node:assert/strict";
import { hash } from "node:crypto";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import { setImmediate } from "node:timers/promises";
import { GCProfiler } from "node:v8";
import { configureAiTransportHost } from "../../packages/ai/src/host.js";
import { createAnthropicMessagesTransportStreamFn } from "../../packages/ai/src/transports/anthropic-transport-stream.js";
import type { Context, Model } from "../../packages/llm-core/src/types.js";
import { prepareEmbeddedAttemptHistory } from "../../src/agents/embedded-agent-runner/run/attempt-history-prepare.js";
import { normalizeMessagesForLlmBoundary } from "../../src/agents/embedded-agent-runner/run/attempt-llm-boundary.js";
import { createToolResultPromptProjectionState } from "../../src/agents/embedded-agent-runner/session-prompt-state.js";
import type { AgentMessage } from "../../src/agents/runtime/index.js";
import { convertToLlm } from "../../src/agents/sessions/messages.js";
import { projectSessionModelContextEntries } from "../../src/agents/sessions/session-manager-codec.js";
import { SessionManager } from "../../src/agents/sessions/session-manager.js";
import { SettingsManager } from "../../src/agents/sessions/settings-manager.js";
import { transformTransportMessages } from "../../src/agents/transport-message-transform.js";
import {
  freezeJsonSnapshot,
  isDeeplyFrozenPlainData,
  isPlainData,
} from "../../src/shared/immutable-data.js";
import { createStageTimingTracker } from "../../src/shared/stage-timing.js";

const model: Model<"anthropic-messages"> = {
  id: "claude-sonnet-4-5",
  name: "Synthetic",
  provider: "anthropic",
  api: "anthropic-messages",
  baseUrl: "https://api.anthropic.com",
  reasoning: true,
  input: ["text"],
  contextWindow: 200000,
  maxTokens: 8192,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const toolText = Buffer.from(
  'Synthetic tool output: "quoted" \\ café 🦞\n' + "Synthetic file contents.\n".repeat(2000),
)
  .subarray(0, 40 * 1024)
  .toString();
const responseBody = [
  {
    type: "message_start",
    message: { id: "fixture", model: model.id, usage: { input_tokens: 1, output_tokens: 0 } },
  },
  { type: "content_block_start", index: 0, content_block: { type: "text", text: "Done" } },
  { type: "content_block_stop", index: 0 },
  { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
  { type: "message_stop" },
]
  .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
  .join("");

function toolTurn(turn: number): Context["messages"] {
  return [
    {
      role: "assistant",
      api: model.api,
      provider: model.provider,
      model: model.id,
      timestamp: turn * 2,
      stopReason: "toolUse",
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      content: [
        {
          type: "toolCall",
          id: `call_${turn}`,
          name: "lookup",
          arguments: { path: `file-${turn}` },
        },
      ],
    },
    {
      role: "toolResult",
      toolCallId: `call_${turn}`,
      toolName: "lookup",
      timestamp: turn * 2 + 1,
      isError: false,
      content: [{ type: "text", text: `${turn}: ${toolText}` }],
    },
  ];
}

async function fixture() {
  const sessionManager = SessionManager.inMemory();
  await sessionManager.appendMessageAsync({
    role: "user",
    content: "Inspect the synthetic files.",
    timestamp: 0,
  });
  for (let turn = 0; turn < 99; turn++) {
    for (const message of toolTurn(turn)) {
      await sessionManager.appendMessageAsync(message);
    }
  }
  // Use hydration's immutable model-view owner.
  const restored = projectSessionModelContextEntries(sessionManager.getEntries()).flatMap(
    (entry) => (entry.type === "message" ? [entry.message] : []),
  );
  assert(restored.every((message) => Object.isFrozen(message)));
  const agent = { state: { messages: restored } };
  const input = {
    attempt: {
      model,
      modelId: model.id,
      provider: model.provider,
      sessionId: "synthetic-restored",
    },
    prepared: {
      sessionRuntime: {
        agentSession: {
          activeSession: {
            agent,
            get messages() {
              return agent.state.messages;
            },
          },
          settingsManager: SettingsManager.inMemory(),
        },
        boundary: {},
        sessionManager,
        toolResultPromptProjectionState: createToolResultPromptProjectionState(),
        transcriptPolicy: { sanitizeMode: "images-only" },
        transport: {},
        state: { systemPromptText: "Inspect synthetic files accurately." },
      },
      toolCatalog: { toolSearchRunPlan: {} },
    },
    setup: {
      sessionAgentId: "main",
      effectiveWorkspace: "/synthetic",
      prepStages: createStageTimingTracker(() => 0),
    },
  } as Parameters<typeof prepareEmbeddedAttemptHistory>[0];
  return { agent, input, sessionManager };
}

async function appendToolTurn(target: Awaited<ReturnType<typeof fixture>>, turn: number) {
  for (const message of toolTurn(turn)) {
    await target.sessionManager.appendMessageAsync(message);
    assert(isDeeplyFrozenPlainData(message));
    target.agent.state.messages.push(message);
  }
}

/** Measures cold preparation separately from warm, growing-history transport turns. */
export async function measureRestoredAnthropicSession(options: {
  iterations: number;
  allocation: boolean;
}) {
  assert(globalThis.gc, "Pass --expose-gc");
  assert(options.iterations <= 200, "Use at most 200 turns per session");
  const inspector = options.allocation ? new Session() : undefined;
  inspector?.connect();
  const startSampling = async () =>
    inspector?.post("HeapProfiler.startSampling", {
      samplingInterval: 4096,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
  const stopSampling = async () => {
    if (!inspector) {
      return undefined;
    }
    const { profile } = await inspector.post("HeapProfiler.stopSampling");
    return profile.samples.reduce((sum, sample) => sum + sample.size, 0);
  };
  let wire = new Uint8Array();
  let payload: unknown;
  let encodedAsBlob = false;
  configureAiTransportHost({
    transformTransportMessages,
    immutableData: { freezeJsonSnapshot, isDeeplyFrozenPlainData, isPlainData },
    buildModelFetch: () => async (_url, init) => {
      assert(init?.body instanceof Blob || typeof init?.body === "string");
      encodedAsBlob = init.body instanceof Blob;
      wire =
        init.body instanceof Blob
          ? new Uint8Array(await init.body.arrayBuffer())
          : new TextEncoder().encode(init.body);
      return new Response(responseBody, { headers: { "content-type": "text/event-stream" } });
    },
  });
  const streamFn = createAnthropicMessagesTransportStreamFn();
  const send = async (messages: AgentMessage[]) => {
    const context: Context = {
      systemPrompt: "Inspect synthetic files accurately.",
      messages: convertToLlm(normalizeMessagesForLlmBoundary(messages)),
      tools: [
        {
          name: "lookup",
          description: "Read a synthetic file",
          parameters: {
            type: "object",
            properties: { path: { type: "string" } },
            required: ["path"],
          },
        },
      ],
    };
    const stream = await streamFn(model, context, {
      apiKey: "synthetic-request-key",
      cacheRetention: "long",
      reasoning: "low",
      onPayload(value) {
        payload = value;
      },
    });
    assert.equal((await stream.result()).stopReason, "stop");
    return context.messages;
  };
  const record = (name: string) => {
    assert.equal(Buffer.from(wire).toString(), JSON.stringify(payload));
    return { name, bytes: wire.byteLength, sha256: hash("sha256", wire) };
  };
  async function collectProof() {
    const proof = await fixture();
    await prepareEmbeddedAttemptHistory(proof.input, () => {});
    const first = await send(proof.agent.state.messages);
    const scenarioHashes = [record("initial")];
    await appendToolTurn(proof, 99);
    const stringify = JSON.stringify;
    let messageEncodes = 0;
    let wholePayloadEncodes = 0;
    JSON.stringify = (value, replacer, space) => {
      if (value && typeof value === "object") {
        if (Reflect.get(value, "role") === "user" || Reflect.get(value, "role") === "assistant") {
          messageEncodes++;
        }
        if (
          Reflect.get(value, "model") === model.id &&
          Array.isArray(Reflect.get(value, "messages"))
        ) {
          wholePayloadEncodes++;
        }
      }
      // Preserve both native replacer overloads while counting one serialization.
      if (typeof replacer === "function") {
        return stringify(value, replacer, space);
      }
      return stringify(value, replacer, space);
    };
    let second: Context["messages"];
    try {
      second = await send(proof.agent.state.messages);
    } finally {
      JSON.stringify = stringify;
    }
    scenarioHashes.push(record("appended_tool_turn"));
    const proofCounts = {
      sourceMessages: first.length,
      frozenSources: first.filter(isDeeplyFrozenPlainData).length,
      byRole: ["user", "assistant", "toolResult"].map((role) => {
        const messages = first.filter((message) => message.role === role);
        return {
          role,
          messages: messages.length,
          frozen: messages.filter(isDeeplyFrozenPlainData).length,
        };
      }),
      unchangedSourceIdentities: first.filter((message, index) => message === second[index]).length,
      secondRequestMessages: second.length,
      messageEncodes,
      wholePayloadEncodes,
      encodedAsBlob,
      reusedFragments: wholePayloadEncodes ? 0 : second.length - messageEncodes,
    };
    // Warm imports/JIT on a separate history so the measured session starts cold.
    for (let turn = 0; turn < 5; turn++) {
      await send(proof.agent.state.messages);
    }
    return {
      scenarioHashes,
      proofCounts,
      sourceRefs: first.map((message) => new WeakRef(message)),
    };
  }
  const { scenarioHashes, proofCounts, sourceRefs } = await collectProof();
  // Release the proof session before measuring a separate, initially cold session.
  wire = new Uint8Array();
  payload = undefined;
  for (let turn = 0; turn < 3; turn++) {
    await setImmediate();
    globalThis.gc();
  }
  const retainedProofSources = sourceRefs.filter(
    (reference) => reference.deref() !== undefined,
  ).length;
  assert.equal(retainedProofSources, 0, "Proof history must be released before measurement");
  sourceRefs.length = 0;
  const measured = await fixture();
  await setImmediate();
  globalThis.gc();
  await startSampling();
  const coldCpu = process.threadCpuUsage();
  const coldStart = performance.now();
  await prepareEmbeddedAttemptHistory(measured.input, () => {});
  const coldUsed = process.threadCpuUsage(coldCpu);
  const preparationMs = performance.now() - coldStart;
  const preparationAllocationBytes = await stopSampling();
  await startSampling();
  const firstRequestCpu = process.threadCpuUsage();
  const firstRequestStart = performance.now();
  await send(measured.agent.state.messages);
  const firstRequestUsed = process.threadCpuUsage(firstRequestCpu);
  const firstRequestMs = performance.now() - firstRequestStart;
  const firstRequestAllocationBytes = await stopSampling();
  const initialWire = record("measured_initial");
  await setImmediate();
  globalThis.gc();
  await startSampling();
  const hostLoadBefore = loadavg();
  const gc = new GCProfiler();
  gc.start();
  const times: number[] = [];
  const cpu = process.threadCpuUsage();
  const start = performance.now();
  for (let turn = 0; turn < options.iterations; turn++) {
    const before = performance.now();
    await appendToolTurn(measured, 99 + turn);
    await send(measured.agent.state.messages);
    times.push(performance.now() - before);
  }
  const used = process.threadCpuUsage(cpu);
  const elapsedMs = performance.now() - start;
  const collections = gc.stop()?.statistics ?? [];
  const allocationBytes = await stopSampling();
  inspector?.disconnect();
  const finalWire = record("measured_final");
  times.sort((a, b) => a - b);
  console.log(
    JSON.stringify({
      mode: "restored",
      baselineDirectory: process.env.OPENCLAW_BENCH_BASELINE_DIR,
      initialMessages: 199,
      toolResultCharacters: toolText.length,
      toolResultBytes: Buffer.byteLength(toolText),
      iterations: options.iterations,
      allocation: options.allocation,
      scenarioHashes,
      proofCounts,
      retainedProofSources,
      initialWire,
      finalWire,
      preparationCpuUs: coldUsed.user + coldUsed.system,
      preparationMs,
      preparationAllocationBytes,
      firstRequestCpuUs: firstRequestUsed.user + firstRequestUsed.system,
      firstRequestMs,
      firstRequestAllocationBytes,
      mainThreadCpuUsPerRequest: (used.user + used.system) / options.iterations,
      wallMsPerRequest: elapsedMs / options.iterations,
      p95Ms: times[Math.floor(times.length * 0.95)],
      allocationBytesPerRequest:
        allocationBytes === undefined ? undefined : allocationBytes / options.iterations,
      gcMs: collections.reduce((sum, entry) => sum + entry.cost / 1000, 0),
      gcMaxMs: Math.max(0, ...collections.map((entry) => entry.cost / 1000)),
      hostLoadBefore,
      hostLoadAfter: loadavg(),
      memory: process.memoryUsage(),
    }),
  );
}
