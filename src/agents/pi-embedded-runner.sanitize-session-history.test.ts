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
  const mockSessionManager = {
    getEntries: vi.fn().mockReturnValue([]),
    appendCustomEntry: vi.fn(),
  } as unknown as SessionManager;

  const mockMessages: AgentMessage[] = [{ role: "user", content: "hello" }];

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
        sanitizeToolCallIds: true,
        toolCallIdMode: "strict",
      }),
    );
  });

  it("annotates inter-session user messages before context sanitization", async () => {
    vi.mocked(helpers.isGoogleModelApi).mockReturnValue(false);

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
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "call_1", name: "read", arguments: {} }],
      },
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
    const messages: AgentMessage[] = [
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "call_1", name: "read" }],
      },
      { role: "user", content: "hello" },
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

  it("does not downgrade openai reasoning when the model has not changed", async () => {
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

    expect(result).toEqual(messages);
  });

  it("downgrades openai reasoning to text when the model changes", async () => {
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

    // Signed thinking blocks are converted to text on model switch (context preserved).
    expect(result).toHaveLength(1);
    const content = (result[0] as { content: unknown[] }).content;
    expect(content).toHaveLength(1);
    expect((content[0] as { type: string }).type).toBe("text");
    expect((content[0] as { text: string }).text).toBe("reasoning");
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

  it("downgrades signed thinking blocks to text when switching from azure-foundry to copilot", async () => {
    const sessionEntries = [
      makeModelSnapshotEntry({
        provider: "azure-foundry",
        modelApi: "openai-completions",
        modelId: "gpt-52-chat",
      }),
    ];
    const sessionManager = makeInMemorySessionManager(sessionEntries);
    const messages = makeReasoningAssistantMessages({ thinkingSignature: "json" });

    const result = await sanitizeSessionHistory({
      messages,
      modelApi: "openai-completions",
      provider: "github-copilot",
      modelId: "claude-opus-4-6",
      sessionManager,
      sessionId: "test-session",
    });

    // Thinking block should be converted to text, not kept with invalid signature.
    expect(result).toHaveLength(1);
    const content = (result[0] as { content: unknown[] }).content;
    expect(content).toHaveLength(1);
    expect((content[0] as { type: string }).type).toBe("text");
    expect((content[0] as { text: string }).text).toBe("reasoning");
  });

  it("downgrades base64 anthropic signatures when switching to openai-completions", async () => {
    const sessionEntries = [
      makeModelSnapshotEntry({
        provider: "github-copilot",
        modelApi: "openai-completions",
        modelId: "claude-opus-4-6",
      }),
    ];
    const sessionManager = makeInMemorySessionManager(sessionEntries);
    const messages = makeReasoningAssistantMessages({ thinkingSignature: "base64" });

    const result = await sanitizeSessionHistory({
      messages,
      modelApi: "openai-completions",
      provider: "azure-foundry",
      modelId: "deepseek-v3-2",
      sessionManager,
      sessionId: "test-session",
    });

    expect(result).toHaveLength(1);
    const content = (result[0] as { content: unknown[] }).content;
    expect(content).toHaveLength(1);
    expect((content[0] as { type: string }).type).toBe("text");
    expect((content[0] as { text: string }).text).toBe("reasoning");
  });

  it("keeps unsigned thinking blocks when model changes", async () => {
    const sessionEntries = [
      makeModelSnapshotEntry({
        provider: "azure-foundry",
        modelApi: "openai-completions",
        modelId: "gpt-52-chat",
      }),
    ];
    const sessionManager = makeInMemorySessionManager(sessionEntries);
    const messages: AgentMessage[] = [
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "some reasoning" },
          { type: "text", text: "answer" },
        ],
      },
    ] as unknown as AgentMessage[];

    const result = await sanitizeSessionHistory({
      messages,
      modelApi: "openai-completions",
      provider: "github-copilot",
      modelId: "claude-opus-4-6",
      sessionManager,
      sessionId: "test-session",
    });

    const content = (result[0] as { content: unknown[] }).content;
    expect(content).toHaveLength(2);
    expect((content[0] as { type: string }).type).toBe("thinking");
    expect((content[1] as { type: string }).type).toBe("text");
  });

  it("does not downgrade thinking blocks when provider has not changed", async () => {
    const sessionEntries = [
      makeModelSnapshotEntry({
        provider: "github-copilot",
        modelApi: "openai-completions",
        modelId: "claude-opus-4-6",
      }),
    ];
    const sessionManager = makeInMemorySessionManager(sessionEntries);
    const messages = makeReasoningAssistantMessages({ thinkingSignature: "base64" });

    const result = await sanitizeSessionHistory({
      messages,
      modelApi: "openai-completions",
      provider: "github-copilot",
      modelId: "claude-opus-4-6",
      sessionManager,
      sessionId: "test-session",
    });

    // Same model — thinking blocks should be preserved as-is.
    expect(result).toEqual(messages);
  });
});
