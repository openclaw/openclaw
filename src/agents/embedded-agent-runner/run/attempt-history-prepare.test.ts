import * as crypto from "node:crypto";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { assert, beforeEach, expect, it, vi } from "vitest";
import { model } from "../../../../packages/agent-core/src/agent-loop.test-support.js";
import { configureAiTransportHost, getAiTransportHost } from "../../../../packages/ai/src/host.js";
import {
  anthropicModel,
  anthropicEvents,
  createAnthropicResponse,
} from "../../../../packages/ai/src/provider-transport-parity.test-support.js";
import { resolveTestOpenAIProviderCapabilities } from "../../../../packages/ai/src/providers/openai-provider.test-support.js";
import { createAnthropicMessagesTransportStreamFn } from "../../../../packages/ai/src/transports/anthropic-transport-stream.js";
import { createAssistantOutput } from "../../../../packages/ai/src/transports/assistant-output.js";
import { buildOpenAICompletionsParams } from "../../../../packages/ai/src/transports/openai-completions-params.js";
import { makeCompletionsModel } from "../../../../packages/ai/src/transports/openai-completions.test-support.js";
import { convertResponsesMessages } from "../../../../packages/ai/src/transports/openai-responses-replay-messages-internal.js";
import { awaitGateBeforeSettlement, createDeferred } from "../../../../test/helpers/promise.js";
import type { SessionEntry } from "../../../config/sessions/types.js";
import {
  freezeJsonSnapshot,
  isDeeplyFrozenPlainData,
  isPlainData,
} from "../../../shared/immutable-data.js";
import { createStageTimingTracker } from "../../../shared/stage-timing.js";
import type { AgentMessage } from "../../runtime/index.js";
import { estimateMessageTokenPressure } from "../../sessions/context-token-pressure.js";
import { convertToLlm } from "../../sessions/messages.js";
import { sessionManagerReadInitialContext } from "../../sessions/session-manager-current-turn.js";
import { SessionManager } from "../../sessions/session-manager.js";
import { SettingsManager } from "../../sessions/settings-manager.js";
import { transformTransportMessages } from "../../transport-message-transform.js";
import { createPromptCacheRequestObserver } from "../prompt-cache-request-observer.js";
import { createToolResultPromptProjectionState } from "../session-prompt-state.js";
import { prepareEmbeddedAttemptHistory } from "./attempt-history-prepare.js";
import { normalizeMessagesForLlmBoundary } from "./attempt-llm-boundary.js";

// mock-isolation: Count repeated history hashing while preserving native digests.
vi.mock("node:crypto", { spy: true });

const mocks = vi.hoisted(() => ({
  readEntry:
    vi.fn<
      typeof import("../../../config/sessions/session-entry-read-runtime.js").readSessionEntryInWorker
    >(),
  readSummaries:
    vi.fn<
      typeof import("../../../config/sessions/session-entry-read-runtime.js").readSessionEntrySummariesInWorker
    >(),
  updateEntry:
    vi.fn<typeof import("../../../config/sessions/session-accessor.js").patchSessionEntryCore>(),
}));

vi.mock("../../../config/sessions/session-entry-read-runtime.js", () => ({
  readSessionEntryInWorker: mocks.readEntry,
  readSessionEntrySummariesInWorker: mocks.readSummaries,
}));
vi.mock("../../../config/sessions/session-accessor.js", () => ({
  patchSessionEntryCore: mocks.updateEntry,
  loadSessionEntry: () => {
    throw new Error("main-thread entry read");
  },
  listSessionEntriesReadOnly: () => {
    throw new Error("main-thread hierarchy read");
  },
}));
// mock-isolation: Keep normalization real while isolating recovery-history setup.
vi.mock("../replay-history.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../replay-history.js")>()),
  sanitizeSessionHistory: async ({ messages }: { messages: AgentMessage[] }) => [...messages],
  validateReplayTurns: async ({ messages }: { messages: AgentMessage[] }) => messages,
}));

function createFixture() {
  const messages: AgentMessage[] = [{ role: "user", content: "Continue", timestamp: 1 }];
  const agent = { state: { messages } };
  const entry: SessionEntry = {
    sessionId: "parent-session",
    updatedAt: 1,
    quotaSuspension: {
      schemaVersion: 1,
      suspendedAt: Date.now(),
      state: "resuming",
      reason: "quota_exhausted",
      failedProvider: "test-provider",
      failedModel: "test-model",
      summary: "Delegate the remaining work",
    },
  };
  const input = {
    attempt: {
      model: { api: "test", id: "test-model" },
      modelId: "test-model",
      provider: "test-provider",
      sessionId: entry.sessionId,
      sessionKey: "agent:main:main",
      config: { session: { store: "/tmp/s11-hierarchy/sessions.json" } },
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
        sessionManager: {},
        toolResultPromptProjectionState: createToolResultPromptProjectionState(),
        transcriptPolicy: {},
        transport: {},
        state: { systemPromptText: "System prompt" },
      },
      toolCatalog: { toolSearchRunPlan: {} },
    },
    setup: {
      sessionAgentId: "main",
      effectiveWorkspace: "/tmp/s11-hierarchy",
      prepStages: createStageTimingTracker(() => 0),
    },
  } as Parameters<typeof prepareEmbeddedAttemptHistory>[0];
  const controller = new AbortController();
  const assertActive = () => controller.signal.throwIfAborted();
  mocks.readEntry.mockResolvedValue(entry);
  const summaries = [
    {
      sessionKey: "agent:main:subagent:child",
      entry: {
        sessionId: "child-session",
        updatedAt: 1,
        spawnedBy: entry.sessionId,
        subagentRole: "orchestrator" as const,
        status: "done" as const,
      },
    },
    {
      sessionKey: "agent:main:subagent:other",
      entry: { sessionId: "unrelated", updatedAt: 1, spawnedBy: "another-parent" },
    },
  ];
  mocks.readSummaries.mockResolvedValue(summaries);
  mocks.updateEntry.mockResolvedValue(entry);
  return { input, entry, summaries, agent, messages, controller, assertActive };
}

beforeEach(() => {
  vi.resetAllMocks();
});

it("fits a long settled tool turn inside its final-answer request", async () => {
  const fixture = createFixture();
  const contextTokenBudget = 131_072;
  const prompt = "Summarize the completed work without repeating tool actions.";
  const history: AgentMessage[] = [
    { role: "user", content: "source context ".repeat(19_000), timestamp: 1 },
  ];
  for (let index = 0; index < 44; index += 1) {
    const assistant = createAssistantOutput(model);
    assistant.content = [
      { type: "toolCall", id: `call_${index}`, name: "read", arguments: { index } },
    ];
    assistant.stopReason = "toolUse";
    history.push(assistant, {
      role: "toolResult",
      toolCallId: `call_${index}`,
      toolName: "read",
      content: [{ type: "text", text: "source line\n".repeat(700) + `result ${index}` }],
      isError: false,
      timestamp: index + 2,
    });
  }
  const proxyModel = makeCompletionsModel({
    provider: "vllm",
    baseUrl: "http://localhost:8000/v1",
    reasoning: false,
    contextWindow: contextTokenBudget,
    maxTokens: 8_192,
  });
  const request = (messages: AgentMessage[]) => {
    const priorHost = getAiTransportHost();
    configureAiTransportHost({
      ...priorHost,
      resolveProviderRequestCapabilities: resolveTestOpenAIProviderCapabilities,
    });
    try {
      const providerMessages = [
        ...messages.filter(
          (message) =>
            message.role === "user" ||
            message.role === "assistant" ||
            message.role === "toolResult",
        ),
        { role: "user", content: prompt, timestamp: 99 },
      ] as Parameters<typeof buildOpenAICompletionsParams>[1]["messages"];
      return buildOpenAICompletionsParams(
        proxyModel,
        {
          systemPrompt: "",
          messages: providerMessages,
          tools: [
            { name: "read", description: "Read a source file", parameters: { type: "object" } },
          ],
        },
        { maxTokens: 8_192 },
      );
    } finally {
      configureAiTransportHost(priorHost);
    }
  };
  expect(() => request(history)).toThrow("Context window exceeded");

  fixture.input.attempt.operation = "settled-tool-finalization";
  fixture.input.attempt.contextTokenBudget = contextTokenBudget;
  fixture.input.attempt.prompt = prompt;
  fixture.input.attempt.settledTurnFinalizationMessages = history;
  mocks.readEntry.mockResolvedValue(undefined);
  await prepareEmbeddedAttemptHistory(fixture.input, fixture.assertActive);

  const selected = fixture.agent.state.messages;
  const finalizerRequest = request(selected);
  expect(finalizerRequest.max_completion_tokens ?? finalizerRequest.max_tokens).toBe(8_192);
  const selectedLastResult = selected.find(
    (message) => message.role === "toolResult" && message.toolCallId === "call_43",
  );
  expect(selectedLastResult?.role).toBe("toolResult");
  if (selectedLastResult?.role !== "toolResult") {
    throw new Error("Expected the latest tool result in the final-answer context");
  }
  expect(selectedLastResult.content).toContainEqual({
    type: "text",
    text: "source line\n".repeat(700) + "result 43",
  });
  const lastResult = history.at(-1);
  expect(lastResult?.role).toBe("toolResult");
  if (lastResult?.role !== "toolResult") {
    throw new Error("Expected the last tool result");
  }
  expect(lastResult.content).toEqual([
    { type: "text", text: "source line\n".repeat(700) + "result 43" },
  ]);
});

it("keeps fresh tool results when the final-answer request fits", async () => {
  const fixture = createFixture();
  const history: AgentMessage[] = [{ role: "user", content: "Continue", timestamp: 1 }];
  for (let index = 0; index < 14; index += 1) {
    const assistant = createAssistantOutput(model);
    assistant.content = [
      { type: "toolCall", id: `call_${index}`, name: "read", arguments: { index } },
    ];
    assistant.stopReason = "toolUse";
    history.push(assistant, {
      role: "toolResult",
      toolCallId: `call_${index}`,
      toolName: "read",
      content: [{ type: "text", text: String(index).padStart(2, "0") + "x".repeat(31_998) }],
      isError: false,
      timestamp: index + 2,
    });
  }
  fixture.input.attempt.operation = "settled-tool-finalization";
  fixture.input.attempt.contextTokenBudget = 200_000;
  fixture.input.attempt.prompt = "Summarize the completed work.";
  fixture.input.attempt.settledTurnFinalizationMessages = history;
  mocks.readEntry.mockResolvedValue(undefined);

  await prepareEmbeddedAttemptHistory(fixture.input, fixture.assertActive);

  const selected = fixture.agent.state.messages;
  expect(selected).toHaveLength(history.length);
  expect(
    selected.every((message, index) =>
      message.role === "toolResult"
        ? JSON.stringify(message.content) === JSON.stringify(history[index]?.content)
        : true,
    ),
  ).toBe(true);
  expect(
    Math.ceil(
      selected.reduce((sum, message) => sum + estimateMessageTokenPressure(message), 0) * 1.25,
    ),
  ).toBeLessThanOrEqual(191_808);
});

it("publishes restored assistant history without rehashing it on later model requests", async () => {
  const fixture = createFixture();
  mocks.readEntry.mockResolvedValue(undefined);
  const restored = createAssistantOutput(model);
  restored.content = [
    {
      type: "toolCall",
      id: "call_restored",
      name: "lookup",
      arguments: { nested: { key: "saved" } },
    },
  ];
  fixture.messages.push(restored);
  const wire = (message: typeof restored) =>
    JSON.stringify(convertResponsesMessages(model, { messages: [message] }, new Set()));
  const before = wire(restored);
  await prepareEmbeddedAttemptHistory(fixture.input, fixture.assertActive);
  const published = fixture.agent.state.messages.find((message) => message.role === "assistant");
  assert(published?.role === "assistant");
  expect(wire(published)).toBe(before);
  const observer = createPromptCacheRequestObserver(
    { sessionId: "restored-history", streamStrategy: "test" },
    () => {},
  );
  await observer.onModelRequest(model, { messages: [published] });
  for (let turn = 0; turn < 3; turn++) {
    vi.mocked(crypto.hash).mockClear();
    await observer.onModelRequest(model, { messages: [published] });
    expect(crypto.hash).not.toHaveBeenCalled();
  }
});

it("reuses restored tool history fragments across turns without changing request bytes", async () => {
  const fixture = createFixture();
  mocks.readEntry.mockResolvedValue(undefined);
  const target = { ...anthropicModel, id: "claude-sonnet-4-5", maxTokens: 8192 };
  const appendTurn = (turn: number) => {
    const assistant = createAssistantOutput(target);
    assistant.content = [{ type: "toolCall", id: `call_${turn}`, name: "lookup", arguments: {} }];
    assistant.stopReason = "toolUse";
    return [
      assistant,
      {
        role: "toolResult" as const,
        toolCallId: `call_${turn}`,
        toolName: "lookup",
        content: [{ type: "text" as const, text: `Result ${turn}: ` + "café 🦞\n".repeat(4096) }],
        isError: false,
        timestamp: turn,
      },
    ];
  };
  for (let turn = 0; turn < 99; turn++) {
    fixture.messages.push(...appendTurn(turn));
  }
  const next = appendTurn(99).map(freezeJsonSnapshot);
  const initialHost = getAiTransportHost();
  const response = createAnthropicResponse(anthropicEvents);
  let wire = "";
  configureAiTransportHost({
    ...initialHost,
    transformTransportMessages,
    immutableData: { freezeJsonSnapshot, isDeeplyFrozenPlainData, isPlainData },
    buildModelFetch: () => async (input, init) => {
      wire = await new Request(input, init).text();
      return response.clone();
    },
  });
  const send = async (messages: AgentMessage[]) => {
    const stream = await createAnthropicMessagesTransportStreamFn()(
      target,
      {
        systemPrompt: "Stable instructions",
        messages: convertToLlm(normalizeMessagesForLlmBoundary(messages)),
      },
      {
        apiKey: "synthetic-request-key",
        cacheRetention: "long",
        reasoning: "low",
        onPayload: () => undefined,
      },
    );
    expect((await stream.result()).stopReason).toBe("stop");
    return wire;
  };
  try {
    // The writable restored view supplies independent pre-publication wire bytes.
    const expected = [await send(fixture.messages), await send([...fixture.messages, ...next])];
    await prepareEmbeddedAttemptHistory(fixture.input, fixture.assertActive);
    const published = fixture.agent.state.messages;
    expect(await send(published)).toBe(expected[0]);
    const stringify = JSON.stringify;
    let messageEncodes = 0;
    const spy = vi.spyOn(JSON, "stringify").mockImplementation((value, replacer, space) => {
      if (isRecord(value) && (value.role === "user" || value.role === "assistant")) {
        messageEncodes++;
      }
      return stringify(value, replacer, space);
    });
    let second: string;
    try {
      second = await send([...published, ...next]);
    } finally {
      spy.mockRestore();
    }
    expect(second).toBe(expected[1]);
    // Only the two moving checkpoints and two appended messages may be encoded.
    expect(messageEncodes).toBeLessThanOrEqual(4);
  } finally {
    configureAiTransportHost(initialHost);
  }
});

it("does not walk admitted history while sealing a new shallow-frozen reply", async () => {
  const fixture = createFixture();
  mocks.readEntry.mockResolvedValue(undefined);
  const prefix = createAssistantOutput(model);
  prefix.content = [{ type: "toolCall", id: "old", name: "read", arguments: { path: "old" } }];
  const manager = SessionManager.inMemory();
  await manager.appendMessageAsync(prefix);
  const retained = await manager[sessionManagerReadInitialContext]();
  const tail = Object.freeze({ ...prefix, content: [{ type: "text" as const, text: "new" }] });
  fixture.messages.push(...retained.messages, tail);
  const ownKeys = vi.spyOn(Reflect, "ownKeys");
  await prepareEmbeddedAttemptHistory(fixture.input, fixture.assertActive);
  const prefixWalks = ownKeys.mock.calls.filter(([value]) => value === prefix).length;
  ownKeys.mockRestore();
  expect(prefixWalks).toBe(0);
  expect(fixture.agent.state.messages.at(-2)).toBe(prefix);
  expect(fixture.agent.state.messages.at(-1)).toBe(tail);
  expect(Reflect.set(prefix.content[0]!, "name", "changed")).toBe(false);
  expect(() => tail.content.push({ type: "text", text: "changed" })).toThrow(TypeError);
  expect(Reflect.set(tail.content[0]!, "text", "changed")).toBe(false);
});

it.each([
  [
    false,
    `[SYSTEM HANDOFF] The previous model is no longer active and a fallback model is now active.
Review the current state below and continue the conversation from where the previous model left off.

CURRENT STATE SUMMARY:
Delegate the remaining work`,
  ],
  [
    true,
    `[SYSTEM HANDOFF] The previous model is no longer active and a fallback model is now active.
You are the new LEADER (Orchestrator). Do not perform tasks already delegated to subordinates.

ACTIVE SUBORDINATE UNITS:
- Subagent child-session (orchestrator): done
- Subagent worker-2 (leaf): running

CURRENT STATE SUMMARY:
Delegate the remaining work

INSTRUCTIONS:
1. Review the state and subordinate reports.
2. Provide strategic guidance and commands to subordinates.
3. Do not repeat work already performed by subordinates.`,
  ],
] as const)("publishes the complete recovery briefing with team=%s", async (team, expected) => {
  const fixture = createFixture();
  mocks.readSummaries.mockResolvedValue(
    team
      ? [
          ...fixture.summaries,
          {
            sessionKey: "agent:main:subagent:worker-2",
            entry: { sessionId: "worker-2", updatedAt: 1, spawnedBy: fixture.entry.sessionId },
          },
        ]
      : [],
  );
  await prepareEmbeddedAttemptHistory(fixture.input, fixture.assertActive);
  expect(fixture.agent.state.messages.at(-1)).toMatchObject({
    role: "user",
    content: expected,
  });
});

it("awaits descriptive worker rows before publishing the recovery briefing", async () => {
  const fixture = createFixture();
  const entered = createDeferred();
  const rows = createDeferred<Awaited<ReturnType<typeof mocks.readSummaries>>>();
  mocks.readSummaries.mockImplementationOnce(() => {
    entered.resolve();
    return rows.promise;
  });
  const preparation = prepareEmbeddedAttemptHistory(fixture.input, fixture.assertActive);
  await awaitGateBeforeSettlement(entered.promise, preparation, "hierarchy reader was not reached");
  expect(fixture.agent.state.messages).toBe(fixture.messages);
  expect(mocks.updateEntry).not.toHaveBeenCalled();
  rows.resolve(fixture.summaries);
  await preparation;
  expect(fixture.agent.state.messages.at(-1)).toMatchObject({
    role: "user",
    content: expect.stringContaining("Subagent child-session (orchestrator): done"),
  });
  expect(fixture.agent.state.messages.at(-1)).toMatchObject({
    content: expect.not.stringContaining("unrelated"),
  });
  const [, update] = mocks.updateEntry.mock.calls[0]!;
  expect(await update(fixture.entry, {})).toMatchObject({ quotaSuspension: { state: "active" } });
  expect(await update({ ...fixture.entry, sessionId: "replacement" }, {})).toBeNull();
});

it.each([
  { stage: "entry", rejected: false },
  { stage: "hierarchy", rejected: false },
  { stage: "settlement", rejected: false },
  { stage: "hierarchy", rejected: true },
])(
  "refuses publication after $stage revocation or rejection ($rejected)",
  async ({ stage, rejected }) => {
    const fixture = createFixture();
    const entered = createDeferred();
    const resume = createDeferred();
    const wait = async () => {
      entered.resolve();
      await resume.promise;
      if (rejected) {
        throw new Error("reader unavailable");
      }
    };
    if (stage === "entry") {
      mocks.readEntry.mockImplementationOnce(async () => {
        await wait();
        return fixture.entry;
      });
    } else if (stage === "hierarchy") {
      mocks.readSummaries.mockImplementationOnce(async () => {
        await wait();
        return [];
      });
    } else {
      mocks.updateEntry.mockImplementationOnce(async () => {
        await wait();
        return fixture.entry;
      });
    }
    const preparation = prepareEmbeddedAttemptHistory(fixture.input, fixture.assertActive);
    await awaitGateBeforeSettlement(
      entered.promise,
      preparation,
      "read/settlement was not reached",
    );
    if (!rejected) {
      fixture.controller.abort(new Error("attempt retired"));
    }
    resume.resolve();
    await expect(preparation).rejects.toThrow(rejected ? "reader unavailable" : "attempt retired");
    expect(fixture.agent.state.messages).toBe(fixture.messages);
    if (stage !== "settlement") {
      expect(mocks.updateEntry).not.toHaveBeenCalled();
    }
  },
);
