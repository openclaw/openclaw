import type { AgentMessage } from "openclaw/plugin-sdk/agent-core";
import type { AssistantMessage, UserMessage, Usage } from "openclaw/plugin-sdk/llm";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { markInboundContextLabel } from "../auto-reply/reply/inbound-context-marker.js";
import { OPENCLAW_TRANSCRIPT_ARTIFACT_API } from "../shared/transcript-only-openclaw-assistant.js";
import {
  loadSanitizeSessionHistoryWithCleanMocks,
  makeMockSessionManager,
  makeInMemorySessionManager,
  makeModelSnapshotEntry,
  makeReasoningAssistantMessages,
  type SanitizeSessionHistoryHarness,
  type SanitizeSessionHistoryFn,
  TEST_SESSION_ID,
} from "./embedded-agent-runner.sanitize-session-history.test-harness.js";
import { validateReplayTurns } from "./embedded-agent-runner/replay-history.js";
import { castAgentMessage, castAgentMessages } from "./test-helpers/agent-message-fixtures.js";
import { textToolResult, textAssistant } from "./test-helpers/sparse-transcript.test-support.js";
import { extractToolCallsFromAssistant } from "./tool-call-id.js";
import type { TranscriptPolicy } from "./transcript-policy.js";
import { makeZeroUsageSnapshot } from "./usage.js";

vi.mock("./embedded-agent-helpers.js", async () => ({
  ...(await vi.importActual("./embedded-agent-helpers.js")),
  sanitizeSessionMessagesImages: vi.fn(async (msgs) => msgs),
}));

vi.mock("../plugins/provider-hook-runtime.js", async () => {
  const clearProviderRuntimePluginCacheForTest = vi.fn();
  return {
    clearProviderRuntimePluginCacheForTest,
    testing: { clearProviderRuntimePluginCacheForTest },
    prepareProviderExtraParams: vi.fn(() => undefined),
    resolveProviderHookPlugin: vi.fn(() => undefined),
    resolveProviderPluginsForHooks: vi.fn(() => []),
    resolveProviderRuntimePlugin: vi.fn(({ provider }: { provider?: string }) =>
      provider === "github-copilot"
        ? {
            buildReplayPolicy: ({ modelId }: { modelId?: string | null }) =>
              modelId?.includes("claude") ? { dropThinkingBlocks: true } : undefined,
          }
        : undefined,
    ),
    wrapProviderStreamFn: vi.fn(() => undefined),
  };
});

vi.mock("../plugins/provider-runtime.js", async () => {
  const actual = await vi.importActual<typeof import("../plugins/provider-runtime.js")>(
    "../plugins/provider-runtime.js",
  );
  return {
    ...actual,
    sanitizeProviderReplayHistoryWithPluginAsync: vi.fn(
      async ({
        provider,
        context,
      }: {
        provider?: string;
        context: {
          messages: AgentMessage[];
          sessionState?: {
            appendCustomEntryAsync(customType: string, data: unknown): Promise<string>;
          };
        };
      }) => {
        if (
          provider &&
          provider.startsWith("google") &&
          context.messages[0]?.role === "assistant" &&
          context.sessionState
        ) {
          await context.sessionState.appendCustomEntryAsync("google-turn-ordering-bootstrap", {
            timestamp: Date.now(),
          });
          return [
            { role: "user", content: "(session bootstrap)" } as AgentMessage,
            ...context.messages,
          ];
        }
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
      },
    ),
    validateProviderReplayTurnsWithPlugin: vi.fn(() => undefined),
  };
});

let sanitizeSessionHistory: SanitizeSessionHistoryFn;
let mockedHelpers: SanitizeSessionHistoryHarness["mockedHelpers"];
let testTimestamp = 1;
const nextTimestamp = () => testTimestamp++;
const text = (value: string) => ({ type: "text" as const, text: value });
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
const toolResult = (id: string, value = "ok", name = "read") =>
  castAgentMessage(textToolResult(id, name, value, { isError: false }));
const makeUsage = (input = 0, output = 0, totalTokens = 0): Usage => ({
  input,
  output,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
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
const omittedReasoning = [text("[assistant reasoning omitted]")];
const makeAnthropicReplayPolicy = (
  overrides: Partial<TranscriptPolicy> = {},
): TranscriptPolicy => ({
  sanitizeMode: "full",
  sanitizeToolCallIds: true,
  toolCallIdMode: "strict",
  preserveNativeAnthropicToolUseIds: true,
  repairToolUseResultPairing: true,
  preserveSignatures: true,
  dropThinkingBlocks: false,
  applyGoogleTurnOrdering: false,
  validateGeminiTurns: false,
  validateAnthropicTurns: true,
  allowSyntheticToolResults: true,
  ...overrides,
});
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
const metadata = [
  markInboundContextLabel("Conversation info:"),
  "```json",
  '{"chat_id":"channel:123","sender":"OpenClaw"}',
  "```",
].join("\n");

describe("sanitizeSessionHistory", () => {
  let sessionManager: ReturnType<typeof makeMockSessionManager>;
  const sanitize = (
    messages: AgentMessage[],
    overrides: Partial<Parameters<SanitizeSessionHistoryFn>[0]> = {},
  ) =>
    sanitizeSessionHistory({
      messages: structuredClone(messages),
      modelApi: "openai-responses",
      provider: "openai",
      sessionManager,
      sessionId: TEST_SESSION_ID,
      ...overrides,
    });
  const sanitizeAnthropic = (
    messages: AgentMessage[],
    overrides: Partial<Parameters<SanitizeSessionHistoryFn>[0]> = {},
  ) => sanitize(messages, { ...anthropicRoute, ...overrides });
  const validateAnthropic = (messages: AgentMessage[], policy?: TranscriptPolicy) =>
    validateReplayTurns({ messages, ...anthropicRoute, sessionId: TEST_SESSION_ID, policy });

  beforeAll(async () => {
    const harness = await loadSanitizeSessionHistoryWithCleanMocks();
    sanitizeSessionHistory = harness.sanitizeSessionHistory;
    mockedHelpers = harness.mockedHelpers;
  });
  beforeEach(() => {
    testTimestamp = 1;
    vi.clearAllMocks();
    vi.mocked(mockedHelpers.sanitizeSessionMessagesImages).mockImplementation(async (msgs) => msgs);
    sessionManager = makeMockSessionManager();
  });

  it.each([
    { state: "available", promptTokens: 148_874, totalTokens: 163_978 },
    { state: "unavailable" },
  ] as const)(
    "preserves $state context snapshots while normalizing replay usage",
    async (contextUsage) => {
      const out = await sanitizeAnthropic(
        castAgentMessages([
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
        ]),
      );
      expect((out[1] as AssistantMessage).usage).toMatchObject({
        contextUsage,
        totalTokens: 927_907,
      });
    },
  );

  it("lets Google provider hooks prepend a bootstrap turn and persist a marker", async () => {
    const entries: Array<{ type: string; customType: string; data: unknown }> = [];
    const out = await sanitize(castAgentMessages([textAssistant("hello")]), {
      modelApi: "google-generative-ai",
      provider: "google-vertex",
      sessionManager: makeInMemorySessionManager(entries),
    });
    expect(out[0]).toMatchObject({ role: "user", content: "(session bootstrap)" });
    expect(entries.some((entry) => entry.customType === "google-turn-ordering-bootstrap")).toBe(
      true,
    );
  });

  it("prepends a bootstrap user turn for strict OpenAI-compatible assistant-first history", async () => {
    const entries: Array<{ type: string; customType: string; data: unknown }> = [];
    const out = await sanitize(castAgentMessages([textAssistant("hello")]), {
      modelApi: "openai-completions",
      provider: "vllm",
      modelId: "gemma-3-27b",
      sessionManager: makeInMemorySessionManager(entries),
    });
    expect(out[0]).toMatchObject({ role: "user", content: "(session bootstrap)" });
    expect(out[1]?.role).toBe("assistant");
    expect(entries.some((entry) => entry.customType === "google-turn-ordering-bootstrap")).toBe(
      false,
    );
  });

  it("annotates inter-session user messages before context sanitization", async () => {
    const out = await sanitize(
      castAgentMessages([
        {
          ...user("forwarded instruction"),
          provenance: {
            kind: "inter_session",
            sourceSessionKey: "agent:main:req",
            sourceTool: "sessions_send",
          },
        },
      ]),
    );
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
    const out = await sanitize(
      castAgentMessages([
        user("question"),
        { ...textAssistant("answer"), usage: { output: 3, cache_read_input_tokens: 9, cost } },
      ]),
    );
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
    const out = await sanitize(
      castAgentMessages([user("question"), { ...textAssistant("answer"), usage }]),
    );
    expect((out[1] as AssistantMessage).usage).toEqual(usage);
    expect((out[1] as AssistantMessage).usage.cost).toBeUndefined();
  });

  it("keeps fresh usage after compaction timestamp in summary-first ordering", async () => {
    const timestamp = Date.parse("2026-02-26T12:00:00.000Z");
    const freshUsage = makeUsage(1_000, 250, 1_250);
    const out = await sanitize(
      castAgentMessages([
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
      ]),
    );
    expect((out[1] as AssistantMessage).usage).toEqual(makeZeroUsageSnapshot());
    expect((out[3] as AssistantMessage).usage).toEqual(freshUsage);
  });

  it("keeps OpenAI Responses real tool results paired without rewriting valid ids", async () => {
    const id = "call_mock_image_generate_1";
    const out = await sanitize(
      castAgentMessages([
        user("generate"),
        assistant([toolCall(id, "image_generate")], { stopReason: "toolUse" }),
        {
          role: "toolResult",
          call_id: id,
          toolName: "image_generate",
          content: [text("Background task started.")],
          isError: false,
        },
        user("inspect the attachment"),
      ]),
    );
    expect(roles(out)).toEqual(["user", "assistant", "toolResult", "user"]);
    expect(extractToolCallsFromAssistant(out[1] as AssistantMessage)[0]?.id).toBe(id);
    expect(out[2]).toMatchObject({
      toolCallId: id,
      call_id: id,
      content: [text("Background task started.")],
    });
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

  it("repairs a message-tool delivery-mirror poisoned replay", async () => {
    const out = await sanitize(
      castAgentMessages([
        user("start"),
        assistant([toolCall("call_message|fc_message", "message")], { stopReason: "toolUse" }),
        {
          ...textAssistant("visible reply"),
          provider: "openclaw",
          model: "delivery-mirror",
          api: OPENCLAW_TRANSCRIPT_ARTIFACT_API,
          stopReason: "stop",
        },
        user("continue"),
      ]),
    );
    expect(roles(out)).toEqual(["user", "assistant", "toolResult", "user"]);
    expect(out.some((message) => (message as { model?: string }).model === "delivery-mirror")).toBe(
      false,
    );
    expect(out[2]).toMatchObject({ toolCallId: "call_message", content: [text("aborted")] });
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
          policy: makeAnthropicReplayPolicy({
            sanitizeMode: "images-only",
            sanitizeToolCallIds: false,
            preserveNativeAnthropicToolUseIds: false,
            repairToolUseResultPairing: false,
            preserveSignatures: false,
            dropReasoningFromHistory: false,
            validateAnthropicTurns: false,
            allowSyntheticToolResults: false,
          }),
        },
      ),
    ).rejects.toThrow(/invalid_replay_transcript.*dangling_tool_call.*call_1/);
  });

  it("keeps real parallel tool results for openai-responses and aborts missing siblings", async () => {
    const calls = [toolCall("call_1"), toolCall("call_2", "exec"), toolCall("call_3", "write")];
    const out = await sanitize([
      assistant(calls, { stopReason: "toolUse" }),
      user("continue"),
      toolResult("call_2", "ok", "exec"),
    ]);
    expect(roles(out)).toEqual(["assistant", "toolResult", "toolResult", "toolResult", "user"]);
    expect(
      extractToolCallsFromAssistant(out[0] as AssistantMessage).map(({ id, name }) => ({
        id,
        name,
      })),
    ).toEqual(calls.map(({ id, name }) => ({ id, name })));
    expect(
      out
        .slice(1, 4)
        .map((message) => (message as Extract<AgentMessage, { role: "toolResult" }>).toolCallId),
    ).toEqual(["call_1", "call_2", "call_3"]);
    expect(
      out
        .slice(1, 4)
        .map((message) => (message as Extract<AgentMessage, { role: "toolResult" }>).content),
    ).toEqual([[text("aborted")], [text("ok")], [text("aborted")]]);
    expect(JSON.stringify(out)).not.toContain("missing tool result");
  });

  it.each([
    {
      name: "missing input or arguments",
      calls: [{ type: "toolCall", id: "call_1", name: "read" }],
    },
    {
      name: "invalid or overlong names",
      calls: [
        toolCall("call_bad", 'toolu_01mvznfebfuu <|tool_call_argument_begin|> {"command"'),
        toolCall("call_long", `read_${"x".repeat(80)}`),
      ],
    },
  ])("drops malformed tool calls: $name", async ({ calls }) => {
    const out = await sanitize(
      castAgentMessages([{ role: "assistant", content: calls }, user("hello")]),
    );
    expect(roles(out)).toEqual(["user"]);
  });

  it("drops tool calls that are not in the allowed tool set", async () => {
    const out = await sanitize(
      [assistant([toolCall("call_1", "write")], { stopReason: "toolUse" })],
      {
        allowedToolNames: ["read"],
      },
    );
    expect(out).toStrictEqual([]);
  });

  it("keeps pre-switch reasoning dropped on the switch turn and the next turn", async () => {
    const history = [
      assistant(
        [
          thinking("reasoning before switch", JSON.stringify({ id: "rs_old", type: "reasoning" })),
          text("before switch"),
        ],
        { timestamp: 150 },
      ),
    ];
    const manager = makeInMemorySessionManager([previousModel()]);
    const switchTurn = await sanitize(history, { modelId: "gpt-5.4", sessionManager: manager });
    const nextTurn = await sanitize(history, { modelId: "gpt-5.4", sessionManager: manager });
    expect(assistantContent(switchTurn, 0)).toEqual([text("before switch")]);
    expect(JSON.stringify(nextTurn)).toBe(JSON.stringify(switchTurn));
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
      castAgentMessages([
        {
          role: "assistant",
          content: [
            thinking("reasoning", JSON.stringify({ id: "rs_test", type: "reasoning" })),
            { ...text("plain"), textSignature: JSON.stringify({ v: 1, id: "msg_plain" }) },
            {
              ...text("commentary"),
              textSignature: JSON.stringify({ v: 1, id: "msg_commentary", phase: "commentary" }),
            },
            {
              ...text("answer"),
              textSignature: JSON.stringify({ v: 1, id: "msg_final", phase: "final_answer" }),
            },
          ],
        },
      ]),
      { modelId: "gpt-5.4", sessionManager: makeInMemorySessionManager([previousModel()]) },
    );
    expect(out).toEqual([
      {
        role: "assistant",
        usage: makeZeroUsageSnapshot(),
        content: [
          text("plain"),
          { ...text("commentary"), textSignature: JSON.stringify({ v: 1, phase: "commentary" }) },
          { ...text("answer"), textSignature: JSON.stringify({ v: 1, phase: "final_answer" }) },
        ],
      },
    ]);
  });

  it("keeps paired openai reasoning when the active branch never switched", async () => {
    const active = currentModel(100);
    const messages = makeReasoningAssistantMessages({
      thinkingSignature: "json",
      includeText: true,
      timestamp: 1,
    });
    const out = await sanitize(messages, {
      modelId: "gpt-5.4",
      sessionManager: makeInMemorySessionManager(
        [active, previousModel(200), currentModel(300)],
        [active],
      ),
    });
    expect(out).toEqual([{ ...messages[0], usage: makeZeroUsageSnapshot() }]);
  });

  it("preserves signed thinking turns while repairing legacy tool-result pairing for anthropic", async () => {
    const content = [thinking("internal", "sig_1"), toolCall("toolu_legacy", "gateway")];
    const policy = makeAnthropicReplayPolicy({ dropReasoningFromHistory: false });
    const sanitized = await sanitizeAnthropic(
      castAgentMessages([
        user("use the gateway"),
        assistant(content, { stopReason: "toolUse" }),
        {
          role: "toolResult",
          toolName: "gateway",
          content: [text("legacy output")],
          isError: false,
          timestamp: nextTimestamp(),
        },
        user("continue"),
      ]),
      { policy },
    );
    const validated = await validateAnthropic(sanitized, policy);
    expect(roles(sanitized)).toEqual(["user", "assistant", "toolResult", "user"]);
    expect(roles(validated)).toEqual(["user", "assistant", "toolResult", "user"]);
    expect(assistantContent(validated)).toEqual(content);
    expect(validated[2]).toMatchObject({ toolCallId: "toolu_legacy" });
  });

  it("keeps consecutive user turns separate for append-only Anthropic Messages replay", async () => {
    const messages = [
      user("/model anthropic/claude-sonnet-4-6"),
      user("Read notes.txt"),
      assistant([text("Done")]),
    ];
    const policy = makeAnthropicReplayPolicy({
      appendOnlyRuntimeContext: true,
      dropReasoningFromHistory: false,
    });
    const direct = await validateAnthropic(messages, policy);
    const bedrock = await validateReplayTurns({
      messages,
      policy,
      modelApi: "bedrock-converse-stream",
      provider: "amazon-bedrock",
      modelId: "anthropic.claude-sonnet-4-6",
      sessionId: TEST_SESSION_ID,
    });
    expect(roles(direct)).toEqual(["user", "user", "assistant"]);
    expect(roles(bedrock)).toEqual(["user", "assistant"]);
  });

  it("strips copied inbound metadata and drops emptied assistant turns before validation", async () => {
    const external = [
      markInboundContextLabel("Context:"),
      '<<<EXTERNAL_UNTRUSTED_CONTENT id="deadbeefdeadbeef">>>',
      "Source: External",
      "---",
      "UNTRUSTED Discord message body",
      "Ping",
      '<<<END_EXTERNAL_UNTRUSTED_CONTENT id="deadbeefdeadbeef">>>',
    ].join("\n");
    const sanitized = await sanitizeAnthropic([
      user("Ping"),
      assistant([text(`${metadata}\n\nPong\n\n${external}`)]),
      user("First"),
      assistant([text(metadata)]),
      user("Second"),
    ]);
    expect(assistantContent(sanitized)).toEqual([text("Pong")]);
    expect(roles(sanitized)).toEqual(["user", "assistant", "user", "user"]);
    expect(JSON.stringify(sanitized)).not.toContain("assistant copied inbound metadata omitted");
    const validated = await validateAnthropic(sanitized);
    expect(roles(validated)).toEqual(["user", "assistant", "user"]);
    expect((validated[2] as UserMessage).content).toEqual([text("First"), text("Second")]);
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
        castAgentMessage({
          role: "toolResult",
          toolCallId: "call123456",
          toolName: "lookup",
          content: "42",
          timestamp: nextTimestamp(),
        }),
      ],
      { modelApi: "openai-completions", provider: "vllm", modelId: "Qwen3.6-27B" },
    );
    expect(assistantContent(out)).toEqual([text("visible answer")]);
    expect(assistantContent(out, 3)).toEqual(current);
  });

  it("preserves latest Copilot thinking and tool continuation while stripping older reasoning", async () => {
    const current = [
      thinking("read the file", "reasoning_text"),
      toolCall("tool_123"),
      text("Reading the file."),
    ];
    const out = await sanitize(
      [
        user("first"),
        assistant([thinking("older reasoning", "reasoning_text")]),
        user("read the file"),
        assistant(current, { stopReason: "toolUse" }),
        toolResult("tool_123"),
      ],
      {
        modelApi: "openai-completions",
        provider: "github-copilot",
        modelId: "claude-opus-4.6",
      },
    );
    expect(roles(out)).toEqual(["user", "assistant", "user", "assistant", "toolResult"]);
    expect(assistantContent(out)).toEqual(omittedReasoning);
    expect(assistantContent(out, 3)).toEqual(current);
    expect(out[4]).toMatchObject({ toolCallId: "tool_123", content: [text("ok")] });
  });

  it.each([
    { provider: "kimi", modelId: "kimi-for-coding" },
    { provider: "github-copilot", modelId: "claude-opus-4.6" },
  ])("preserves unsigned thinking for $provider over Anthropic transport", async (route) => {
    const content = [thinking("unsigned reasoning"), text("result")];
    const out = await sanitizeAnthropic([user("analyze"), assistant(content)], {
      ...route,
      preserveLatestAssistantThinking: false,
      policy: makeAnthropicReplayPolicy({
        preserveNativeAnthropicToolUseIds: false,
        preserveSignatures: false,
        dropReasoningFromHistory: false,
        validateAnthropicTurns: false,
        allowSyntheticToolResults: false,
      }),
    });
    expect(assistantContent(out)).toEqual(content);
  });

  it("keeps regular latest Anthropic thinking replay while preserving older stripped turns", async () => {
    const latest = [thinking("latest private reasoning", "sig_latest"), text("latest answer")];
    const out = await sanitizeAnthropic(
      [
        user("first"),
        assistant([thinking("old private reasoning", "sig_old")]),
        user("second"),
        assistant(latest),
      ],
      { modelId: "claude-3-7-sonnet-20250219" },
    );
    expect(assistantContent(out)).toEqual(omittedReasoning);
    expect(assistantContent(out, 3)).toEqual(latest);
  });

  it("strips invalid prior thinking signatures while preserving the latest assistant turn", async () => {
    const invalid = [thinking("missing"), thinking("blank", "   ")];
    const latest = [
      ...invalid,
      thinking("latest signed", "sig_latest"),
      text("latest visible answer"),
    ];
    const out = await sanitizeAnthropic([
      user("first"),
      assistant([...invalid, thinking("signed", "sig_old"), text("old visible answer")]),
      user("second"),
      assistant(latest),
    ]);
    expect(assistantContent(out)).toEqual([
      thinking("signed", "sig_old"),
      text("old visible answer"),
    ]);
    expect(assistantContent(out, 3)).toEqual(latest);
  });

  it("preserves active tool-turn thinking signatures even when a tool result follows", async () => {
    const content = [
      { type: "thinking", thinking: "call the tool", signature: "" },
      toolCall("call_1", "lookup"),
    ];
    const out = await sanitizeAnthropic(
      castAgentMessages([
        user("look up the answer"),
        { ...assistant([]), content },
        toolResult("call_1", "42", "lookup"),
      ]),
    );
    expect(assistantContent(out)).toEqual(content);
  });

  it("uses immutable thinking replay for anthropic-compatible providers when policy preserves signatures", async () => {
    const out = await sanitizeAnthropic(
      [user("retry"), assistant([thinking("internal", "sig_1"), toolCall("call_1", " read ")])],
      {
        provider: "anthropic-vertex",
        policy: makeAnthropicReplayPolicy({ sanitizeThoughtSignatures: undefined }),
      },
    );
    expect(roles(out)).toEqual(["user"]);
    expect((out[0] as UserMessage).content).toBe("retry");
  });

  it("preserves signed thinking tool ids when preserveSignatures is false", async () => {
    const content = [thinking("internal", "sig_1"), toolCall("call_1")];
    const out = await sanitizeAnthropic([user("retry"), assistant(content), toolResult("call_1")], {
      policy: makeAnthropicReplayPolicy({
        preserveNativeAnthropicToolUseIds: false,
        preserveSignatures: false,
        allowSyntheticToolResults: false,
      }),
    });
    expect(assistantContent(out)).toEqual(content);
    expect(out[2]).toMatchObject({ toolCallId: "call_1" });
  });

  it("keeps earlier mutable ids from colliding with later preserved signed ids", async () => {
    const signed = [thinking("internal", "sig_1"), toolCall("call1")];
    const sanitized = await sanitizeAnthropic([
      user("first"),
      assistant([toolCall("call_1")]),
      toolResult("call_1", "first result"),
      user("second"),
      assistant(signed, { stopReason: "toolUse" }),
      toolResult("call1", "second result"),
      user("retry"),
    ]);
    const validated = await validateAnthropic(sanitized);
    const first = extractToolCallsFromAssistant(sanitized[1] as AssistantMessage)[0]?.id;
    const second = extractToolCallsFromAssistant(sanitized[4] as AssistantMessage)[0]?.id;
    expect(first).not.toBe("call1");
    expect(second).toBe("call1");
    expect(first).not.toBe(second);
    expect(sanitized[2]).toMatchObject({ toolCallId: first });
    expect(sanitized[5]).toMatchObject({ toolCallId: "call1" });
    expect(assistantContent(validated, 4)).toEqual(signed);
  });

  it("drops later preserved signed turns that reuse an earlier raw tool id across the transcript", async () => {
    const sanitized = await sanitizeAnthropic([
      user("first"),
      assistant([thinking("internal", "sig_1"), toolCall("call1")], { stopReason: "toolUse" }),
      toolResult("call1", "first result"),
      user("second"),
      assistant([thinking("internal", "sig_2"), toolCall("call1")], { stopReason: "toolUse" }),
      toolResult("call1", "second result"),
      user("retry"),
    ]);
    const validated = await validateAnthropic(sanitized);
    for (const messages of [sanitized, validated]) {
      expect(
        messages.filter(
          (message) =>
            message.role === "assistant" && extractToolCallsFromAssistant(message).length > 0,
        ),
      ).toHaveLength(1);
      expect(messages.filter((message) => message.role === "toolResult")).toHaveLength(1);
    }
    expect(JSON.stringify(validated)).not.toContain("[tool calls omitted]");
  });

  it("keeps the earlier anthropic replay prefix stable after a later subagent turn", async () => {
    const priorId = "toolu_01ABCDEF1234567890";
    const laterId = "toolu_01ZZZZZZ9999999999";
    const policy = makeAnthropicReplayPolicy({
      sanitizeThoughtSignatures: undefined,
      dropThinkingBlocks: true,
    });
    const priorCall = {
      type: "toolUse",
      id: priorId,
      name: "read",
      input: { path: "IDENTITY.md" },
    };
    const base = castAgentMessages([
      user("Read IDENTITY.md"),
      { ...assistant([], { stopReason: "toolUse" }), content: [priorCall] },
      { ...textToolResult(priorId, "read", "ok", { isError: false }), toolUseId: priorId },
      assistant([text("done")]),
    ]);
    const extended = castAgentMessages([
      ...base,
      user("Ask a subagent for an emoji"),
      {
        ...assistant([], { stopReason: "toolUse" }),
        content: [{ type: "toolUse", id: laterId, name: "subagent", input: { prompt: "emoji" } }],
      },
      { ...textToolResult(laterId, "subagent", "😀", { isError: false }), toolUseId: laterId },
      assistant([text("it was 😀")]),
    ]);
    const sanitizedBase = await sanitizeAnthropic(base, { policy });
    const sanitizedExtended = await sanitizeAnthropic(extended, { policy });
    expect(sanitizedExtended.slice(0, sanitizedBase.length)).toEqual(sanitizedBase);
    expect(assistantContent(sanitizedBase)).toEqual([priorCall]);
    expect(sanitizedBase[2]).toMatchObject({ toolCallId: priorId });
  });

  it("strips unsigned latest Bedrock thinking even when preserveSignatures is false", async () => {
    const out = await sanitizeAnthropic(
      [
        user("analyze"),
        assistant([
          thinking("no sig"),
          thinking("blank", ""),
          thinking("signed", "sig_bedrock"),
          text("done"),
        ]),
      ],
      {
        provider: "amazon-bedrock",
        modelApi: "bedrock-converse-stream",
        preserveLatestAssistantThinking: false,
        policy: makeAnthropicReplayPolicy({
          preserveNativeAnthropicToolUseIds: false,
          preserveSignatures: false,
          allowSyntheticToolResults: false,
        }),
      },
    );
    expect(assistantContent(out)).toEqual([thinking("signed", "sig_bedrock"), text("done")]);
  });
});
