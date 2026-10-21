import type { AgentMessage } from "openclaw/plugin-sdk/agent-core";
import type { AssistantMessage, UserMessage, Usage } from "openclaw/plugin-sdk/llm";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  loadSanitizeSessionHistoryWithCleanMocks,
  makeMockSessionManager,
  makeInMemorySessionManager,
  makeModelSnapshotEntry,
  type SanitizeSessionHistoryFn,
  TEST_SESSION_ID,
} from "./embedded-agent-runner.sanitize-session-history.test-harness.js";
import { castAgentMessages } from "./test-helpers/agent-message-fixtures.js";
import { textAssistant, textToolResult } from "./test-helpers/sparse-transcript.test-support.js";
import { makeZeroUsageSnapshot } from "./usage.js";

vi.mock("./embedded-agent-helpers/images.js", async () => ({
  ...(await vi.importActual<typeof import("./embedded-agent-helpers/images.js")>(
    "./embedded-agent-helpers/images.js",
  )),
  sanitizeSessionMessagesImages: vi.fn(async (msgs) => msgs),
}));

// mock-isolation: Use synthetic provider hooks without loading runtime plugin registries.
vi.mock("../plugins/provider-hook-runtime.js", async () => {
  const clearProviderRuntimePluginCacheForTest = vi.fn();
  return {
    clearProviderRuntimePluginCacheForTest,
    testing: { clearProviderRuntimePluginCacheForTest },
    prepareProviderExtraParams: vi.fn(() => undefined),
    resolveProviderHookPlugin: vi.fn(() => undefined),
    resolveProviderPluginsForHooks: vi.fn(() => []),
    resolveProviderRuntimePlugin: vi.fn(() => undefined),
    wrapProviderStreamFn: vi.fn(() => undefined),
  };
});

vi.mock("../plugins/provider-runtime.js", async () => {
  const actual = await vi.importActual<typeof import("../plugins/provider-runtime.js")>(
    "../plugins/provider-runtime.js",
  );
  return {
    ...actual,
    sanitizeProviderReplayHistoryWithPluginAsync: vi.fn<
      typeof actual.sanitizeProviderReplayHistoryWithPluginAsync
    >(async ({ provider, context }) => {
      if (provider === "replay-poison") {
        return context.messages.filter(
          (message) =>
            message.role !== "toolResult" ||
            !(
              (message as { isError?: unknown }).isError === true &&
              JSON.stringify((message as { content?: unknown }).content).includes("aborted")
            ),
        );
      }
      return context.messages;
    }),
    validateProviderReplayTurnsWithPlugin: vi.fn(() => undefined),
  };
});

let sanitizeSessionHistory: SanitizeSessionHistoryFn;
let testTimestamp = 1;
const nextTimestamp = () => testTimestamp++;
const text = (value: string) => ({ type: "text" as const, text: value });
const signedText = (value: string, signature: { id?: string; phase?: string }) => ({
  ...text(value),
  textSignature: JSON.stringify({ v: 1, ...signature }),
});
const thinking = (value: string, thinkingSignature?: string) => ({
  type: "thinking" as const,
  thinking: value,
  ...(thinkingSignature === undefined ? {} : { thinkingSignature }),
});
const toolCall = (id: string, name = "read") => ({
  type: "toolCall" as const,
  id,
  name,
  arguments: {},
});
const makeUsage = (input = 0, output = 0, totalTokens = 0): Usage => ({
  ...makeZeroUsageSnapshot(),
  input,
  output,
  totalTokens,
});
const user = (content: string, timestamp = nextTimestamp()): UserMessage => ({
  role: "user",
  content,
  timestamp,
});
const assistant = (
  content: AssistantMessage["content"],
  params: Partial<Pick<AssistantMessage, "stopReason" | "usage" | "timestamp">> = {},
): AssistantMessage => ({
  role: "assistant",
  content,
  api: "openai-responses",
  provider: "openai",
  model: "gpt-5.4",
  usage: makeUsage(),
  stopReason: "stop",
  timestamp: nextTimestamp(),
  ...params,
});
const assistantContent = (messages: AgentMessage[], index = 1) => {
  expect(messages[index]?.role).toBe("assistant");
  return (messages[index] as AssistantMessage).content;
};
const roles = (messages: AgentMessage[]) => messages.map((message) => message.role);
const anthropicRoute = {
  provider: "anthropic",
  modelApi: "anthropic-messages",
  modelId: "claude-sonnet-4-6",
};
const previousModel = (timestamp = 100) =>
  makeModelSnapshotEntry({
    timestamp,
    provider: "anthropic",
    modelApi: "anthropic-messages",
    modelId: "claude-3-7",
  });
const currentModel = (timestamp: number) =>
  makeModelSnapshotEntry({
    timestamp,
    provider: "openai",
    modelApi: "openai-responses",
    modelId: "gpt-5.4",
  });
describe("sanitizeSessionHistory", () => {
  let sessionManager: ReturnType<typeof makeMockSessionManager>;
  // Sparse and malformed transcript fixtures cross the typed boundary once, here.
  const sanitize = (
    messages: unknown[],
    overrides: Partial<Parameters<SanitizeSessionHistoryFn>[0]> = {},
  ) =>
    sanitizeSessionHistory({
      messages: castAgentMessages(structuredClone(messages)),
      modelApi: "openai-responses",
      provider: "openai",
      sessionManager,
      sessionId: TEST_SESSION_ID,
      ...overrides,
    });
  const sanitizeAnthropic = (
    messages: unknown[],
    overrides: Partial<Parameters<SanitizeSessionHistoryFn>[0]> = {},
  ) => sanitize(messages, { ...anthropicRoute, ...overrides });

  beforeAll(async () => {
    sanitizeSessionHistory = await loadSanitizeSessionHistoryWithCleanMocks();
  });
  beforeEach(() => {
    testTimestamp = 1;
    vi.clearAllMocks();
    sessionManager = makeMockSessionManager();
  });

  it.each([
    { state: "available", promptTokens: 148_874, totalTokens: 163_978 },
    { state: "unavailable" },
  ] as const)(
    "preserves $state context snapshots while normalizing replay usage",
    async (contextUsage) => {
      const out = await sanitizeAnthropic([
        user("hello"),
        {
          ...assistant([text("done")]),
          usage: {
            input: 12,
            output: 15_104,
            cacheRead: 819_661,
            cacheWrite: 93_130,
            contextUsage,
          },
        },
      ]);
      expect((out[1] as AssistantMessage).usage).toMatchObject({
        contextUsage,
        totalTokens: 927_907,
      });
    },
  );

  it("annotates inter-session user messages before context sanitization", async () => {
    const out = await sanitize([
      {
        ...user("forwarded instruction"),
        provenance: {
          kind: "inter_session",
          sourceSessionKey: "agent:main:req",
          sourceTool: "sessions_send",
        },
      },
    ]);
    expect(out[0]?.role).toBe("user");
    const content = (out[0] as UserMessage).content;
    expect(content).toContain("[Inter-session message]");
    expect(content).toContain("sourceSession=agent:main:req");
  });

  it("preserves existing usage cost while normalizing token fields", async () => {
    const cost = {
      input: 1.25,
      output: 2.5,
      cacheRead: 0.25,
      cacheWrite: 0,
      total: 4,
      totalOrigin: "provider-billed",
    };
    const out = await sanitize([
      user("question"),
      { ...textAssistant("answer"), usage: { output: 3, cache_read_input_tokens: 9, cost } },
    ]);
    expect((out[1] as AssistantMessage).usage).toEqual({
      input: 0,
      output: 3,
      cacheRead: 9,
      cacheWrite: 0,
      totalTokens: 12,
      cost,
    });
  });

  it("preserves unknown cost when token fields already match", async () => {
    const usage = { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, totalTokens: 10 };
    const out = await sanitize([user("question"), { ...textAssistant("answer"), usage }]);
    expect((out[1] as AssistantMessage).usage).toEqual(usage);
    expect((out[1] as AssistantMessage).usage.cost).toBeUndefined();
  });

  it("keeps fresh usage after compaction timestamp in summary-first ordering", async () => {
    const timestamp = Date.parse("2026-02-26T12:00:00.000Z");
    const freshUsage = makeUsage(1_000, 250, 1_250);
    const out = await sanitize([
      {
        role: "compactionSummary",
        summary: "compressed",
        tokensBefore: 123_000,
        timestamp: new Date(timestamp).toISOString(),
      },
      assistant([text("old")], {
        timestamp: timestamp - 2_000,
        usage: makeUsage(120_000, 3_000, 123_000),
      }),
      user("new question", timestamp + 1_000),
      assistant([text("fresh")], { timestamp: timestamp + 2_000, usage: freshUsage }),
    ]);
    expect((out[1] as AssistantMessage).usage).toEqual(makeZeroUsageSnapshot());
    expect((out[3] as AssistantMessage).usage).toEqual(freshUsage);
  });

  it("preserves paired tool IDs for an unowned Azure Responses provider", async () => {
    const id = "call_gateway_0|fc_gateway_0";
    const out = await sanitize(
      [
        {
          role: "assistant",
          content: [
            {
              type: "thinking",
              thinking: "reasoning",
              thinkingSignature: { id: "rs_test", type: "reasoning" },
            },
            toolCall(id, "noop"),
          ],
        },
        textToolResult(id, "noop", "", { isError: false }),
      ],
      {
        modelApi: "azure-openai-responses",
        provider: "custom-compatible",
        modelId: undefined,
        sessionManager: makeInMemorySessionManager([]),
      },
    );
    expect((out[0] as AssistantMessage).content).toContainEqual(toolCall(id, "noop"));
    expect(out[1]).toMatchObject({ toolCallId: id });
  });

  it("strips completed Qwen reasoning but preserves the current tool-call continuation", async () => {
    const current = [
      thinking("call the tool", "reasoning_content"),
      toolCall("call123456", "lookup"),
    ];
    const out = await sanitize(
      [
        user("first"),
        assistant([thinking("old private reasoning", "reasoning_content"), text("visible answer")]),
        user("look up the answer"),
        assistant(current),
        {
          role: "toolResult",
          toolCallId: "call123456",
          toolName: "lookup",
          content: "42",
          timestamp: nextTimestamp(),
        },
      ],
      { modelApi: "openai-completions", provider: "vllm", modelId: "Qwen3.6-27B" },
    );
    expect(assistantContent(out)).toEqual([text("visible answer")]);
    expect(assistantContent(out, 3)).toEqual(current);
  });

  it("repairs OpenAI Responses replay again after provider hooks mutate history", async () => {
    const out = await sanitize(
      [
        user("generate"),
        assistant([toolCall("call_1", "image_generate")], { stopReason: "toolUse" }),
        assistant([text("done")]),
      ],
      { provider: "replay-poison" },
    );
    expect(roles(out)).toEqual(["user", "assistant", "toolResult", "assistant"]);
    expect(out[2]).toMatchObject({
      role: "toolResult",
      toolName: "image_generate",
      isError: true,
      content: [text("aborted")],
    });
  });

  it("rejects dangling OpenAI Responses tool calls before provider replay when repair is disabled", async () => {
    await expect(
      sanitize(
        [
          user("start"),
          assistant([toolCall("call_1")], { stopReason: "toolUse" }),
          user("continue"),
        ],
        {
          policy: {
            sanitizeMode: "images-only",
            sanitizeToolCallIds: false,
            toolCallIdMode: "strict",
            preserveNativeAnthropicToolUseIds: false,
            repairToolUseResultPairing: false,
            preserveSignatures: false,
            dropThinkingBlocks: false,
            dropReasoningFromHistory: false,
            applyGoogleTurnOrdering: false,
            validateGeminiTurns: false,
            validateAnthropicTurns: false,
            allowSyntheticToolResults: false,
          },
        },
      ),
    ).rejects.toThrow(/invalid_replay_transcript.*dangling_tool_call.*call_1/);
  });

  it("keeps reasoning newer than the latest actual model switch", async () => {
    const reasoningTurn = (id: string, timestamp: number) =>
      assistant(
        [
          thinking(`reasoning ${id}`, JSON.stringify({ id: `rs_${id}`, type: "reasoning" })),
          text(id),
        ],
        { timestamp },
      );
    const newer = reasoningTurn("new", 250);
    const out = await sanitize([reasoningTurn("old", 150), user("after switch", 225), newer], {
      modelId: "gpt-5.4",
      sessionManager: makeInMemorySessionManager([
        previousModel(),
        currentModel(200),
        currentModel(300),
      ]),
    });
    expect(assistantContent(out, 0)).toEqual([text("old")]);
    expect(assistantContent(out, 2)).toEqual(newer.content);
  });

  it("preserves phase metadata while dropping paired message ids after a model switch", async () => {
    const out = await sanitize(
      [
        {
          role: "assistant",
          content: [
            thinking("reasoning", JSON.stringify({ id: "rs_test", type: "reasoning" })),
            signedText("plain", { id: "msg_plain" }),
            signedText("commentary", { id: "msg_commentary", phase: "commentary" }),
            signedText("answer", { id: "msg_final", phase: "final_answer" }),
          ],
        },
      ],
      { modelId: "gpt-5.4", sessionManager: makeInMemorySessionManager([previousModel()]) },
    );
    expect(out).toEqual([
      {
        role: "assistant",
        usage: makeZeroUsageSnapshot(),
        content: [
          text("plain"),
          signedText("commentary", { phase: "commentary" }),
          signedText("answer", { phase: "final_answer" }),
        ],
      },
    ]);
  });

  it("keeps paired openai reasoning when the active branch never switched", async () => {
    const active = currentModel(100);
    const messages = castAgentMessages([
      {
        role: "assistant",
        timestamp: 1,
        content: [
          thinking("reasoning", JSON.stringify({ id: "rs_test", type: "reasoning" })),
          text("answer"),
        ],
      },
    ]);
    const out = await sanitize(messages, {
      modelId: "gpt-5.4",
      sessionManager: makeInMemorySessionManager(
        [active, previousModel(200), currentModel(300)],
        [active],
      ),
    });
    expect(out).toEqual([{ ...messages[0], usage: makeZeroUsageSnapshot() }]);
  });
});
