import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { SessionManager } from "@mariozechner/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as helpers from "./pi-embedded-helpers.js";
import {
  makeInMemorySessionManager,
  makeModelSnapshotEntry,
  makeReasoningAssistantMessages,
} from "./pi-embedded-runner.sanitize-session-history.test-harness.js";

type SanitizeSessionHistory =
  typeof import("./pi-embedded-runner/google.js").sanitizeSessionHistory;
let sanitizeSessionHistory: SanitizeSessionHistory;

vi.mock("./pi-embedded-helpers.js", async () => {
  const actual = await vi.importActual("./pi-embedded-helpers.js");
  return {
    ...actual,
    isGoogleModelApi: vi.fn(),
    sanitizeSessionMessagesImages: vi.fn().mockImplementation(async (msgs) => msgs),
  };
});

function now() {
  return Date.now();
}

function makeOpenAIResponsesAssistantMessage(params: {
  stopReason: "stop" | "toolUse" | "aborted";
  content: unknown[];
}): AgentMessage {
  return {
    role: "assistant",
    api: "openai-responses",
    provider: "openai",
    model: "gpt-5.2",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: params.stopReason,
    timestamp: now(),
    content: params.content,
  } as unknown as AgentMessage;
}

function makeToolResult(params: {
  toolCallId: string;
  toolName: string;
  text: string;
}): AgentMessage {
  return {
    role: "toolResult",
    toolCallId: params.toolCallId,
    toolName: params.toolName,
    content: [{ type: "text", text: params.text }],
    isError: false,
    timestamp: now(),
  } as unknown as AgentMessage;
}

describe("sanitizeSessionHistory", () => {
  const mockSessionManager = {
    getEntries: vi.fn().mockReturnValue([]),
    appendCustomEntry: vi.fn(),
  } as unknown as SessionManager;

  const mockMessages: AgentMessage[] = [{ role: "user", content: "hello", timestamp: now() }];

  beforeEach(async () => {
    vi.resetAllMocks();
    vi.mocked(helpers.sanitizeSessionMessagesImages).mockImplementation(async (msgs) => msgs);
    ({ sanitizeSessionHistory } = await import("./pi-embedded-runner/google.js"));
  });

  it("sanitizes tool call ids for Google model APIs", async () => {
    vi.mocked(helpers.isGoogleModelApi).mockReturnValue(true);

    await sanitizeSessionHistory({
      messages: mockMessages,
      modelApi: "google-generative-ai",
      provider: "google-vertex",
      sessionManager: mockSessionManager,
      sessionId: "test-session",
    });

    expect(helpers.sanitizeSessionMessagesImages).toHaveBeenCalledWith(
      mockMessages,
      "session:history",
      expect.objectContaining({ sanitizeMode: "full", sanitizeToolCallIds: true }),
    );
  });

  it("sanitizes tool call ids with strict9 for Mistral models", async () => {
    vi.mocked(helpers.isGoogleModelApi).mockReturnValue(false);

    await sanitizeSessionHistory({
      messages: mockMessages,
      modelApi: "openai-responses",
      provider: "openrouter",
      modelId: "mistralai/devstral-2512:free",
      sessionManager: mockSessionManager,
      sessionId: "test-session",
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
    vi.mocked(helpers.isGoogleModelApi).mockReturnValue(false);

    await sanitizeSessionHistory({
      messages: mockMessages,
      modelApi: "anthropic-messages",
      provider: "anthropic",
      sessionManager: mockSessionManager,
      sessionId: "test-session",
    });

    expect(helpers.sanitizeSessionMessagesImages).toHaveBeenCalledWith(
      mockMessages,
      "session:history",
      expect.objectContaining({ sanitizeMode: "full", sanitizeToolCallIds: true }),
    );
  });

  it("sanitizes tool call ids for openai-responses while keeping images-only mode", async () => {
    vi.mocked(helpers.isGoogleModelApi).mockReturnValue(false);

    await sanitizeSessionHistory({
      messages: mockMessages,
      modelApi: "openai-responses",
      provider: "openai",
      sessionManager: mockSessionManager,
      sessionId: "test-session",
    });

    expect(helpers.sanitizeSessionMessagesImages).toHaveBeenCalledWith(
      mockMessages,
      "session:history",
      expect.objectContaining({
        sanitizeMode: "images-only",
        sanitizeToolCallIds: false,
        preserveSignatures: false,
      }),
    );
  });

  it("annotates inter-session user messages before context sanitization", async () => {
    vi.mocked(helpers.isGoogleModelApi).mockReturnValue(false);

    const messages: AgentMessage[] = [
      {
        role: "user",
        content: "forwarded instruction",
        timestamp: now(),
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
      sessionId: "test-session",
    });

    const first = result[0] as Extract<AgentMessage, { role: "user" }>;
    expect(first.role).toBe("user");
    expect(typeof first.content).toBe("string");
    expect(first.content as string).toContain("[Inter-session message]");
    expect(first.content as string).toContain("sourceSession=agent:main:req");
  });

  it("keeps reasoning-only assistant messages for openai-responses", async () => {
    vi.mocked(helpers.isGoogleModelApi).mockReturnValue(false);

    const messages: AgentMessage[] = [
      { role: "user", content: "hello", timestamp: now() },
      makeOpenAIResponsesAssistantMessage({
        stopReason: "aborted",
        content: [
          {
            type: "thinking",
            thinking: "reasoning",
            thinkingSignature: "sig",
          },
        ],
      }),
    ];

    const result = await sanitizeSessionHistory({
      messages,
      modelApi: "openai-responses",
      provider: "openai",
      sessionManager: mockSessionManager,
      sessionId: "test-session",
    });

    expect(result).toHaveLength(2);
    expect(result[1]?.role).toBe("assistant");
  });

  it("does not synthesize tool results for openai-responses", async () => {
    const messages: AgentMessage[] = [
      makeOpenAIResponsesAssistantMessage({
        stopReason: "toolUse",
        content: [{ type: "toolCall", id: "call_1", name: "read", arguments: {} }],
      }),
    ];

    const result = await sanitizeSessionHistory({
      messages,
      modelApi: "openai-responses",
      provider: "openai",
      sessionManager: mockSessionManager,
      sessionId: "test-session",
    });

    expect(result).toHaveLength(1);
    expect(result[0]?.role).toBe("assistant");
  });

  it("drops malformed tool calls missing input or arguments", async () => {
    const malformedAssistant = makeOpenAIResponsesAssistantMessage({
      stopReason: "toolUse",
      content: [{ type: "toolCall", id: "call_1", name: "read" } as unknown],
    });

    const messages: AgentMessage[] = [
      malformedAssistant,
      { role: "user", content: "hello", timestamp: now() } as unknown as AgentMessage,
    ];

    const result = await sanitizeSessionHistory({
      messages,
      modelApi: "openai-responses",
      provider: "openai",
      sessionManager: mockSessionManager,
      sessionId: "test-session",
    });

    expect(result.map((msg) => msg.role)).toEqual(["user"]);
  });

  it("downgrades orphan openai reasoning even when the model has not changed", async () => {
    const sessionEntries = [
      makeModelSnapshotEntry({
        provider: "openai",
        modelApi: "openai-responses",
        modelId: "gpt-5.2-codex",
      }),
    ];
    const sessionManager = makeInMemorySessionManager(sessionEntries);
    const messages = makeReasoningAssistantMessages({ thinkingSignature: "json" });

    const result = await sanitizeSessionHistory({
      messages,
      modelApi: "openai-responses",
      provider: "openai",
      modelId: "gpt-5.2-codex",
      sessionManager,
      sessionId: "test-session",
    });

    expect(result).toEqual([]);
  });

  it("downgrades orphan openai reasoning when the model changes", async () => {
    const sessionEntries = [
      makeModelSnapshotEntry({
        provider: "anthropic",
        modelApi: "anthropic-messages",
        modelId: "claude-3-7",
      }),
    ];
    const sessionManager = makeInMemorySessionManager(sessionEntries);
    const messages = makeReasoningAssistantMessages({ thinkingSignature: "object" });

    const result = await sanitizeSessionHistory({
      messages,
      modelApi: "openai-responses",
      provider: "openai",
      modelId: "gpt-5.2-codex",
      sessionManager,
      sessionId: "test-session",
    });

    expect(result).toEqual([]);
  });

  it("drops reasoning signatures followed only by toolCall producers", async () => {
    const messages: AgentMessage[] = [
      makeOpenAIResponsesAssistantMessage({
        stopReason: "toolUse",
        content: [
          {
            type: "thinking",
            thinking: "internal reasoning",
            thinkingSignature: JSON.stringify({ id: "rs_test", type: "reasoning" }),
          },
          { type: "toolCall", id: "call_1", name: "read", arguments: {} },
        ],
      }),
      makeToolResult({ toolCallId: "call_1", toolName: "read", text: "ok" }),
    ];

    const result = await sanitizeSessionHistory({
      messages,
      modelApi: "openai-responses",
      provider: "openai",
      sessionManager: mockSessionManager,
      sessionId: "test-session",
    });

    const assistant = result.find(
      (message): message is Extract<AgentMessage, { role: "assistant" }> =>
        message.role === "assistant",
    );

    expect(assistant).toBeDefined();
    if (!assistant || assistant.role !== "assistant") {
      throw new Error("Expected an assistant message in sanitized result");
    }

    expect(
      assistant.content.some(
        (block) =>
          block && typeof block === "object" && (block as { type?: string }).type === "thinking",
      ),
    ).toBe(false);
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

    const messages: AgentMessage[] = [
      makeOpenAIResponsesAssistantMessage({
        stopReason: "toolUse",
        content: [{ type: "toolCall", id: "tool_abc123", name: "read", arguments: {} }],
      }),
      makeToolResult({ toolCallId: "tool_abc123", toolName: "read", text: "ok" }),
      { role: "user", content: "continue", timestamp: now() } as unknown as AgentMessage,
      makeToolResult({
        toolCallId: "tool_01VihkDRptyLpX1ApUPe7ooU",
        toolName: "read",
        text: "stale result",
      }),
    ];

    const result = await sanitizeSessionHistory({
      messages,
      modelApi: "anthropic-messages",
      provider: "anthropic",
      modelId: "claude-opus-4-6",
      sessionManager,
      sessionId: "test-session",
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
});
