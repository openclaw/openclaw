import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as helpers from "./pi-embedded-helpers.js";
import {
  expectGoogleModelApiFullSanitizeCall,
  loadSanitizeSessionHistoryWithCleanMocks,
  makeMockSessionManager,
  makeInMemorySessionManager,
  makeModelSnapshotEntry,
  makeReasoningAssistantMessages,
  makeSimpleUserMessages,
  makeSnapshotChangedOpenAIReasoningScenario,
  type SanitizeSessionHistoryFn,
  sanitizeWithOpenAIResponses,
  TEST_SESSION_ID,
} from "./pi-embedded-runner.sanitize-session-history.test-harness.js";

let sanitizeSessionHistory: SanitizeSessionHistoryFn;

// Mock dependencies
vi.mock("./pi-embedded-helpers.js", async () => {
  const actual = await vi.importActual("./pi-embedded-helpers.js");
  return {
    ...actual,
    isGoogleModelApi: vi.fn(),
    sanitizeSessionMessagesImages: vi.fn().mockImplementation(async (msgs) => msgs),
  };
});

// We don't mock session-transcript-repair.js as it is a pure function and complicates mocking.
// We rely on the real implementation which should pass through our simple messages.

describe("sanitizeSessionHistory", () => {
  const mockSessionManager = makeMockSessionManager();
  const mockMessages = makeSimpleUserMessages();
  const setNonGoogleModelApi = () => {
    vi.mocked(helpers.isGoogleModelApi).mockReturnValue(false);
  };

  const sanitizeGithubCopilotHistory = async (params: {
    messages: AgentMessage[];
    modelApi?: string;
    modelId?: string;
  }) =>
    sanitizeSessionHistory({
      messages: params.messages,
      modelApi: params.modelApi ?? "openai-completions",
      provider: "github-copilot",
      modelId: params.modelId ?? "claude-opus-4.6",
      sessionManager: makeMockSessionManager(),
      sessionId: TEST_SESSION_ID,
    });

  const getAssistantMessage = (messages: AgentMessage[]) => {
    expect(messages[1]?.role).toBe("assistant");
    return messages[1] as Extract<AgentMessage, { role: "assistant" }>;
  };

  const getAssistantContentTypes = (messages: AgentMessage[]) =>
    getAssistantMessage(messages).content.map((block: { type: string }) => block.type);

  beforeEach(async () => {
    sanitizeSessionHistory = await loadSanitizeSessionHistoryWithCleanMocks();
  });

  it("sanitizes tool call ids for Google model APIs", async () => {
    await expectGoogleModelApiFullSanitizeCall({
      sanitizeSessionHistory,
      messages: mockMessages,
      sessionManager: mockSessionManager,
    });
  });

  it("sanitizes tool call ids with strict9 for Mistral models", async () => {
    setNonGoogleModelApi();

    await sanitizeSessionHistory({
      messages: mockMessages,
      modelApi: "openai-responses",
      provider: "openrouter",
      modelId: "mistralai/devstral-2512:free",
      sessionManager: mockSessionManager,
      sessionId: TEST_SESSION_ID,
    });

    expect(helpers.sanitizeSessionMessagesImages).toHaveBeenCalledWith(
      mockMessages,
      "session:history",
      expect.objectContaining({
        sanitizeMode: "full",
        sanitizeToolCallIds: true,
        toolCallIdMode: "strict9",
      }),
    );
  });

  it("sanitizes tool call ids for Anthropic APIs", async () => {
    setNonGoogleModelApi();

    await sanitizeSessionHistory({
      messages: mockMessages,
      modelApi: "anthropic-messages",
      provider: "anthropic",
      sessionManager: mockSessionManager,
      sessionId: TEST_SESSION_ID,
    });

    expect(helpers.sanitizeSessionMessagesImages).toHaveBeenCalledWith(
      mockMessages,
      "session:history",
      expect.objectContaining({ sanitizeMode: "full", sanitizeToolCallIds: true }),
    );
  });

  it("does not sanitize tool call ids for openai-responses", async () => {
    setNonGoogleModelApi();

    await sanitizeWithOpenAIResponses({
      sanitizeSessionHistory,
      messages: mockMessages,
      sessionManager: mockSessionManager,
    });

    expect(helpers.sanitizeSessionMessagesImages).toHaveBeenCalledWith(
      mockMessages,
      "session:history",
      expect.objectContaining({ sanitizeMode: "images-only", sanitizeToolCallIds: false }),
    );
  });

  it("annotates inter-session user messages before context sanitization", async () => {
    setNonGoogleModelApi();

    const messages: AgentMessage[] = [
      {
        role: "user",
        content: "forwarded instruction",
        provenance: {
          kind: "inter_session",
          sourceSessionKey: "agent:main:req",
          sourceTool: "sessions_send",
        },
      } as unknown as AgentMessage,
    ];

    const result = await sanitizeSessionHistory({
      messages,
      modelApi: "openai-responses",
      provider: "openai",
      sessionManager: mockSessionManager,
      sessionId: TEST_SESSION_ID,
    });

    const first = result[0] as Extract<AgentMessage, { role: "user" }>;
    expect(first.role).toBe("user");
    expect(typeof first.content).toBe("string");
    expect(first.content as string).toContain("[Inter-session message]");
    expect(first.content as string).toContain("sourceSession=agent:main:req");
  });

  it("drops stale assistant usage snapshots kept before latest compaction summary", async () => {
    vi.mocked(helpers.isGoogleModelApi).mockReturnValue(false);

    const messages = [
      { role: "user", content: "old context" },
      {
        role: "assistant",
        content: [{ type: "text", text: "old answer" }],
        stopReason: "stop",
        usage: {
          input: 191_919,
          output: 2_000,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 193_919,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      },
      {
        role: "compactionSummary",
        summary: "compressed",
        tokensBefore: 191_919,
        timestamp: new Date().toISOString(),
      },
    ] as unknown as AgentMessage[];

    const result = await sanitizeSessionHistory({
      messages,
      modelApi: "openai-responses",
      provider: "openai",
      sessionManager: mockSessionManager,
      sessionId: TEST_SESSION_ID,
    });

    const staleAssistant = result.find((message) => message.role === "assistant") as
      | (AgentMessage & { usage?: unknown })
      | undefined;
    expect(staleAssistant).toBeDefined();
    expect(staleAssistant?.usage).toBeUndefined();
  });

  it("preserves fresh assistant usage snapshots created after latest compaction summary", async () => {
    vi.mocked(helpers.isGoogleModelApi).mockReturnValue(false);

    const messages = [
      {
        role: "assistant",
        content: [{ type: "text", text: "pre-compaction answer" }],
        stopReason: "stop",
        usage: {
          input: 120_000,
          output: 3_000,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 123_000,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      },
      {
        role: "compactionSummary",
        summary: "compressed",
        tokensBefore: 123_000,
        timestamp: new Date().toISOString(),
      },
      { role: "user", content: "new question" },
      {
        role: "assistant",
        content: [{ type: "text", text: "fresh answer" }],
        stopReason: "stop",
        usage: {
          input: 1_000,
          output: 250,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 1_250,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      },
    ] as unknown as AgentMessage[];

    const result = await sanitizeSessionHistory({
      messages,
      modelApi: "openai-responses",
      provider: "openai",
      sessionManager: mockSessionManager,
      sessionId: TEST_SESSION_ID,
    });

    const assistants = result.filter((message) => message.role === "assistant") as Array<
      AgentMessage & { usage?: unknown }
    >;
    expect(assistants).toHaveLength(2);
    expect(assistants[0]?.usage).toBeUndefined();
    expect(assistants[1]?.usage).toBeDefined();
  });

  it("keeps reasoning-only assistant messages for openai-responses", async () => {
    setNonGoogleModelApi();

    const messages = [
      { role: "user", content: "hello" },
      {
        role: "assistant",
        stopReason: "aborted",
        content: [
          {
            type: "thinking",
            thinking: "reasoning",
            thinkingSignature: "sig",
          },
        ],
      },
    ] as unknown as AgentMessage[];

    const result = await sanitizeSessionHistory({
      messages,
      modelApi: "openai-responses",
      provider: "openai",
      sessionManager: mockSessionManager,
      sessionId: TEST_SESSION_ID,
    });

    expect(result).toHaveLength(2);
    expect(result[1]?.role).toBe("assistant");
  });

  it("does not synthesize tool results for openai-responses", async () => {
    const messages = [
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "call_1", name: "read", arguments: {} }],
      },
    ] as unknown as AgentMessage[];

    const result = await sanitizeSessionHistory({
      messages,
      modelApi: "openai-responses",
      provider: "openai",
      sessionManager: mockSessionManager,
      sessionId: TEST_SESSION_ID,
    });

    expect(result).toHaveLength(1);
    expect(result[0]?.role).toBe("assistant");
  });

  it("drops malformed tool calls missing input or arguments", async () => {
    const messages = [
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "call_1", name: "read" }],
      },
      { role: "user", content: "hello" },
    ] as unknown as AgentMessage[];

    const result = await sanitizeSessionHistory({
      messages,
      modelApi: "openai-responses",
      provider: "openai",
      sessionManager: mockSessionManager,
      sessionId: "test-session",
    });

    expect(result.map((msg) => msg.role)).toEqual(["user"]);
  });

  it("drops malformed tool calls with invalid/overlong names", async () => {
    const messages = [
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "call_bad",
            name: 'toolu_01mvznfebfuu <|tool_call_argument_begin|> {"command"',
            arguments: {},
          },
          { type: "toolCall", id: "call_long", name: `read_${"x".repeat(80)}`, arguments: {} },
        ],
      },
      { role: "user", content: "hello" },
    ] as unknown as AgentMessage[];

    const result = await sanitizeSessionHistory({
      messages,
      modelApi: "openai-responses",
      provider: "openai",
      sessionManager: mockSessionManager,
      sessionId: TEST_SESSION_ID,
    });

    expect(result.map((msg) => msg.role)).toEqual(["user"]);
  });

  it("drops tool calls that are not in the allowed tool set", async () => {
    const messages = [
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "call_1", name: "write", arguments: {} }],
      },
    ] as unknown as AgentMessage[];

    const result = await sanitizeSessionHistory({
      messages,
      modelApi: "openai-responses",
      provider: "openai",
      allowedToolNames: ["read"],
      sessionManager: mockSessionManager,
      sessionId: TEST_SESSION_ID,
    });

    expect(result).toEqual([]);
  });

  it("downgrades orphaned openai reasoning even when the model has not changed", async () => {
    const sessionEntries = [
      makeModelSnapshotEntry({
        provider: "openai",
        modelApi: "openai-responses",
        modelId: "gpt-5.2-codex",
      }),
    ];
    const sessionManager = makeInMemorySessionManager(sessionEntries);
    const messages = makeReasoningAssistantMessages({ thinkingSignature: "json" });

    const result = await sanitizeWithOpenAIResponses({
      sanitizeSessionHistory,
      messages,
      modelId: "gpt-5.2-codex",
      sessionManager,
    });

    expect(result).toEqual([]);
  });

  it("downgrades orphaned openai reasoning when the model changes too", async () => {
    const { sessionManager, messages, modelId } = makeSnapshotChangedOpenAIReasoningScenario();

    const result = await sanitizeWithOpenAIResponses({
      sanitizeSessionHistory,
      messages,
      modelId,
      sessionManager,
    });

    expect(result).toEqual([]);
  });

  it("drops orphaned toolResult entries when switching from openai history to anthropic", async () => {
    const sessionEntries = [
      makeModelSnapshotEntry({
        provider: "openai",
        modelApi: "openai-responses",
        modelId: "gpt-5.2",
      }),
    ];
    const sessionManager = makeInMemorySessionManager(sessionEntries);
    const messages = [
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "tool_abc123", name: "read", arguments: {} }],
      },
      {
        role: "toolResult",
        toolCallId: "tool_abc123",
        toolName: "read",
        content: [{ type: "text", text: "ok" }],
      } as unknown as AgentMessage,
      { role: "user", content: "continue" },
      {
        role: "toolResult",
        toolCallId: "tool_01VihkDRptyLpX1ApUPe7ooU",
        toolName: "read",
        content: [{ type: "text", text: "stale result" }],
      } as unknown as AgentMessage,
    ] as unknown as AgentMessage[];

    const result = await sanitizeSessionHistory({
      messages,
      modelApi: "anthropic-messages",
      provider: "anthropic",
      modelId: "claude-opus-4-6",
      sessionManager,
      sessionId: TEST_SESSION_ID,
    });

    expect(result.map((msg) => msg.role)).toEqual(["assistant", "toolResult", "user"]);
    expect(
      result.some(
        (msg) =>
          msg.role === "toolResult" &&
          (msg as { toolCallId?: string }).toolCallId === "tool_01VihkDRptyLpX1ApUPe7ooU",
      ),
    ).toBe(false);
  });

  it("drops assistant thinking blocks for github-copilot models", async () => {
    setNonGoogleModelApi();

    const messages = [
      { role: "user", content: "hello" },
      {
        role: "assistant",
        content: [
          {
            type: "thinking",
            thinking: "internal",
            thinkingSignature: "reasoning_text",
          },
          { type: "text", text: "hi" },
        ],
      },
    ] as unknown as AgentMessage[];

    const result = await sanitizeGithubCopilotHistory({ messages });
    const assistant = getAssistantMessage(result);
    expect(assistant.content).toEqual([{ type: "text", text: "hi" }]);
  });

  it("preserves assistant turn when all content is thinking blocks (github-copilot)", async () => {
    setNonGoogleModelApi();

    const messages = [
      { role: "user", content: "hello" },
      {
        role: "assistant",
        content: [
          {
            type: "thinking",
            thinking: "some reasoning",
            thinkingSignature: "reasoning_text",
          },
        ],
      },
      { role: "user", content: "follow up" },
    ] as unknown as AgentMessage[];

    const result = await sanitizeGithubCopilotHistory({ messages });

    // Assistant turn should be preserved (not dropped) to maintain turn alternation
    expect(result).toHaveLength(3);
    const assistant = getAssistantMessage(result);
    expect(assistant.content).toEqual([{ type: "text", text: "" }]);
  });

  it("preserves tool_use blocks when dropping thinking blocks (github-copilot)", async () => {
    setNonGoogleModelApi();

    const messages = [
      { role: "user", content: "read a file" },
      {
        role: "assistant",
        content: [
          {
            type: "thinking",
            thinking: "I should use the read tool",
            thinkingSignature: "reasoning_text",
          },
          { type: "toolCall", id: "tool_123", name: "read", arguments: { path: "/tmp/test" } },
          { type: "text", text: "Let me read that file." },
        ],
      },
    ] as unknown as AgentMessage[];

    const result = await sanitizeGithubCopilotHistory({ messages });
    const types = getAssistantContentTypes(result);
    expect(types).toContain("toolCall");
    expect(types).toContain("text");
    expect(types).not.toContain("thinking");
  });

  it("does not drop thinking blocks for non-copilot providers", async () => {
    setNonGoogleModelApi();

    const messages = [
      { role: "user", content: "hello" },
      {
        role: "assistant",
        content: [
          {
            type: "thinking",
            thinking: "internal",
            thinkingSignature: "some_sig",
          },
          { type: "text", text: "hi" },
        ],
      },
    ] as unknown as AgentMessage[];

    const result = await sanitizeSessionHistory({
      messages,
      modelApi: "anthropic-messages",
      provider: "anthropic",
      modelId: "claude-opus-4-6",
      sessionManager: makeMockSessionManager(),
      sessionId: TEST_SESSION_ID,
    });

    const types = getAssistantContentTypes(result);
    expect(types).toContain("thinking");
  });

  it("does not drop thinking blocks for non-claude copilot models", async () => {
    setNonGoogleModelApi();

    const messages = [
      { role: "user", content: "hello" },
      {
        role: "assistant",
        content: [
          {
            type: "thinking",
            thinking: "internal",
            thinkingSignature: "some_sig",
          },
          { type: "text", text: "hi" },
        ],
      },
    ] as unknown as AgentMessage[];

    const result = await sanitizeGithubCopilotHistory({ messages, modelId: "gpt-5.2" });
    const types = getAssistantContentTypes(result);
    expect(types).toContain("thinking");
  });
});
