import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { SessionManager } from "@mariozechner/pi-coding-agent";
import { describe, expect, it } from "vitest";
import {
  sanitizeAntigravityThinkingBlocks,
  sanitizeSessionHistory,
} from "./pi-embedded-runner/google.js";

type AssistantThinking = { type?: string; thinking?: string; thinkingSignature?: string };

function getAssistantMessage(out: AgentMessage[]) {
  const assistant = out.find((msg) => (msg as { role?: string }).role === "assistant") as
    | { content?: AssistantThinking[] }
    | undefined;
  if (!assistant) {
    throw new Error("Expected assistant message in sanitized history");
  }
  return assistant;
}

async function sanitizeGoogleAssistantWithContent(content: unknown[]) {
  const sessionManager = SessionManager.inMemory();
  const input = [
    {
      role: "user",
      content: "hi",
    },
    {
      role: "assistant",
      content,
    },
  ] as unknown as AgentMessage[];

  const out = await sanitizeSessionHistory({
    messages: input,
    modelApi: "google-antigravity",
    sessionManager,
    sessionId: "session:google",
  });

  return getAssistantMessage(out);
}

async function sanitizeSimpleSession(params: {
  modelApi: string;
  sessionId: string;
  content: unknown[];
  modelId?: string;
}) {
  const sessionManager = SessionManager.inMemory();
  const input = [
    {
      role: "user",
      content: "hi",
    },
    {
      role: "assistant",
      content: params.content,
    },
  ] as unknown as AgentMessage[];

  return sanitizeSessionHistory({
    messages: input,
    modelApi: params.modelApi,
    modelId: params.modelId,
    sessionManager,
    sessionId: params.sessionId,
  });
}

describe("sanitizeSessionHistory (google thinking)", () => {
  it("keeps thinking blocks without signatures for Google models", async () => {
    const assistant = await sanitizeGoogleAssistantWithContent([
      { type: "thinking", thinking: "reasoning" },
    ]);
    expect(assistant.content?.map((block) => block.type)).toEqual(["thinking"]);
    expect(assistant.content?.[0]?.thinking).toBe("reasoning");
  });

  it("keeps thinking blocks with signatures for Google models", async () => {
    const assistant = await sanitizeGoogleAssistantWithContent([
      { type: "thinking", thinking: "reasoning", thinkingSignature: "sig" },
    ]);
    expect(assistant.content?.map((block) => block.type)).toEqual(["thinking"]);
    expect(assistant.content?.[0]?.thinking).toBe("reasoning");
    expect(assistant.content?.[0]?.thinkingSignature).toBe("sig");
  });

  it("keeps thinking blocks with Anthropic-style signatures for Google models", async () => {
    const assistant = await sanitizeGoogleAssistantWithContent([
      { type: "thinking", thinking: "reasoning", signature: "sig" },
    ]);
    expect(assistant.content?.map((block) => block.type)).toEqual(["thinking"]);
    expect(assistant.content?.[0]?.thinking).toBe("reasoning");
  });

  it("drops unsigned thinking blocks for Antigravity Claude", async () => {
    const out = await sanitizeSimpleSession({
      modelApi: "google-antigravity",
      modelId: "anthropic/claude-3.5-sonnet",
      sessionId: "session:antigravity-claude",
      content: [{ type: "thinking", thinking: "reasoning" }],
    });

    const assistant = out.find((msg) => (msg as { role?: string }).role === "assistant");
    expect(assistant).toBeUndefined();
  });

  it("maps base64 signatures to thinkingSignature for Antigravity Claude", async () => {
    const sessionManager = SessionManager.inMemory();
    const input = [
      {
        role: "user",
        content: "hi",
      },
      {
        role: "assistant",
        content: [{ type: "thinking", thinking: "reasoning", signature: "c2ln" }],
      },
    ] as unknown as AgentMessage[];

    const out = await sanitizeSessionHistory({
      messages: input,
      modelApi: "google-antigravity",
      modelId: "anthropic/claude-3.5-sonnet",
      sessionManager,
      sessionId: "session:antigravity-claude",
    });

    const assistant = out.find((msg) => (msg as { role?: string }).role === "assistant") as {
      content?: Array<{ type?: string; thinking?: string; thinkingSignature?: string }>;
    };
    expect(assistant.content?.map((block) => block.type)).toEqual(["thinking"]);
    expect(assistant.content?.[0]?.thinking).toBe("reasoning");
    expect(assistant.content?.[0]?.thinkingSignature).toBe("c2ln");
  });

  it("preserves order for mixed assistant content", async () => {
    const sessionManager = SessionManager.inMemory();
    const input = [
      {
        role: "user",
        content: "hi",
      },
      {
        role: "assistant",
        content: [
          { type: "text", text: "hello" },
          { type: "thinking", thinking: "internal note" },
          { type: "text", text: "world" },
        ],
      },
    ] as unknown as AgentMessage[];

    const out = await sanitizeSessionHistory({
      messages: input,
      modelApi: "google-antigravity",
      sessionManager,
      sessionId: "session:google-mixed",
    });

    const assistant = out.find((msg) => (msg as { role?: string }).role === "assistant") as {
      content?: Array<{ type?: string; text?: string; thinking?: string }>;
    };
    expect(assistant.content?.map((block) => block.type)).toEqual(["text", "thinking", "text"]);
    expect(assistant.content?.[1]?.thinking).toBe("internal note");
  });

  it("strips non-base64 thought signatures for OpenRouter Gemini", async () => {
    const sessionManager = SessionManager.inMemory();
    const input = [
      {
        role: "user",
        content: "hi",
      },
      {
        role: "assistant",
        content: [
          { type: "text", text: "hello", thought_signature: "msg_abc123" },
          { type: "thinking", thinking: "ok", thought_signature: "c2ln" },
          {
            type: "toolCall",
            id: "call_1",
            name: "read",
            arguments: { path: "/tmp/foo" },
            thoughtSignature: '{"id":1}',
          },
          {
            type: "toolCall",
            id: "call_2",
            name: "read",
            arguments: { path: "/tmp/bar" },
            thoughtSignature: "c2ln",
          },
        ],
      },
    ] as unknown as AgentMessage[];

    const out = await sanitizeSessionHistory({
      messages: input,
      modelApi: "openrouter",
      provider: "openrouter",
      modelId: "google/gemini-1.5-pro",
      sessionManager,
      sessionId: "session:openrouter-gemini",
    });

    const assistant = out.find((msg) => (msg as { role?: string }).role === "assistant") as {
      content?: Array<{
        type?: string;
        thought_signature?: string;
        thoughtSignature?: string;
        thinking?: string;
      }>;
    };
    expect(assistant.content).toEqual([
      { type: "text", text: "hello" },
      { type: "thinking", thinking: "ok", thought_signature: "c2ln" },
      {
        type: "toolCall",
        id: "call_1",
        name: "read",
        arguments: { path: "/tmp/foo" },
      },
      {
        type: "toolCall",
        id: "call_2",
        name: "read",
        arguments: { path: "/tmp/bar" },
        thoughtSignature: "c2ln",
      },
    ]);
  });

  it("keeps mixed signed/unsigned thinking blocks for Google models", async () => {
    const sessionManager = SessionManager.inMemory();
    const input = [
      {
        role: "user",
        content: "hi",
      },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "signed", thinkingSignature: "sig" },
          { type: "thinking", thinking: "unsigned" },
        ],
      },
    ] as unknown as AgentMessage[];

    const out = await sanitizeSessionHistory({
      messages: input,
      modelApi: "google-antigravity",
      sessionManager,
      sessionId: "session:google-mixed-signatures",
    });

    const assistant = out.find((msg) => (msg as { role?: string }).role === "assistant") as {
      content?: Array<{ type?: string; thinking?: string }>;
    };
    expect(assistant.content?.map((block) => block.type)).toEqual(["thinking", "thinking"]);
    expect(assistant.content?.[0]?.thinking).toBe("signed");
    expect(assistant.content?.[1]?.thinking).toBe("unsigned");
  });

  it("keeps empty thinking blocks for Google models", async () => {
    const sessionManager = SessionManager.inMemory();
    const input = [
      {
        role: "user",
        content: "hi",
      },
      {
        role: "assistant",
        content: [{ type: "thinking", thinking: "   " }],
      },
    ] as unknown as AgentMessage[];

    const out = await sanitizeSessionHistory({
      messages: input,
      modelApi: "google-antigravity",
      sessionManager,
      sessionId: "session:google-empty",
    });

    const assistant = out.find((msg) => (msg as { role?: string }).role === "assistant") as {
      content?: Array<{ type?: string; thinking?: string }>;
    };
    expect(assistant?.content?.map((block) => block.type)).toEqual(["thinking"]);
  });

  it("keeps thinking blocks for non-Google models", async () => {
    const out = await sanitizeSimpleSession({
      modelApi: "openai",
      sessionId: "session:openai",
      content: [{ type: "thinking", thinking: "reasoning" }],
    });

    const assistant = out.find((msg) => (msg as { role?: string }).role === "assistant") as {
      content?: Array<{ type?: string }>;
    };
    expect(assistant.content?.map((block) => block.type)).toEqual(["thinking"]);
  });

  it("sanitizes tool call ids for Google APIs", async () => {
    const sessionManager = SessionManager.inMemory();
    const longId = `call_${"a".repeat(60)}`;
    const input = [
      {
        role: "assistant",
        content: [{ type: "toolCall", id: longId, name: "read", arguments: {} }],
      },
      {
        role: "toolResult",
        toolCallId: longId,
        toolName: "read",
        content: [{ type: "text", text: "ok" }],
      },
    ] as unknown as AgentMessage[];

    const out = await sanitizeSessionHistory({
      messages: input,
      modelApi: "google-antigravity",
      sessionManager,
      sessionId: "session:google",
    });

    const assistant = out.find(
      (msg) => (msg as { role?: unknown }).role === "assistant",
    ) as Extract<AgentMessage, { role: "assistant" }>;
    const toolCall = assistant.content?.[0] as { id?: string };
    expect(toolCall.id).toBeDefined();
    expect(toolCall.id?.length).toBeLessThanOrEqual(40);

    const toolResult = out.find(
      (msg) => (msg as { role?: unknown }).role === "toolResult",
    ) as Extract<AgentMessage, { role: "toolResult" }>;
    expect(toolResult.toolCallId).toBe(toolCall.id);
  });
});

describe("sanitizeAntigravityThinkingBlocks (transformContext path)", () => {
  it("strips unsigned thinking blocks from accumulated tool-call context", () => {
    // Simulates the context that accumulates during an agent loop:
    // user turn → assistant with unsigned thinking + tool call → tool result → assistant again
    const messages: AgentMessage[] = [
      { role: "user", content: "read /tmp/file and summarize" },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "I should read the file first" },
          { type: "toolCall", id: "call_1", name: "read", arguments: { path: "/tmp/file" } },
        ],
      },
      {
        role: "toolResult",
        toolCallId: "call_1",
        toolName: "read",
        content: [{ type: "text", text: "file contents" }],
      },
    ];

    const out = sanitizeAntigravityThinkingBlocks(messages);

    // Unsigned thinking block should be stripped; toolCall preserved.
    const assistant = out.find((m) => m.role === "assistant") as {
      content?: Array<{ type?: string }>;
    };
    expect(assistant.content?.map((b) => b.type)).toEqual(["toolCall"]);
    // Non-assistant messages unchanged.
    expect(out.filter((m) => m.role !== "assistant")).toHaveLength(2);
  });

  it("preserves signed thinking blocks in accumulated context", () => {
    const messages: AgentMessage[] = [
      { role: "user", content: "hello" },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "reasoning", thinkingSignature: "c2lnbmF0dXJl" },
          { type: "text", text: "response" },
        ],
      },
    ];

    const out = sanitizeAntigravityThinkingBlocks(messages);

    // Should be unchanged (same reference).
    expect(out).toBe(messages);
  });

  it("normalizes signature field variants to thinkingSignature", () => {
    const messages: AgentMessage[] = [
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: [{ type: "thinking", thinking: "thought", signature: "c2ln" }],
      },
    ];

    const out = sanitizeAntigravityThinkingBlocks(messages);

    const assistant = out.find((m) => m.role === "assistant") as {
      content?: Array<{ type?: string; thinkingSignature?: string; signature?: string }>;
    };
    expect(assistant.content?.[0]?.thinkingSignature).toBe("c2ln");
  });

  it("drops assistant messages entirely when only content is unsigned thinking", () => {
    const messages: AgentMessage[] = [
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: [{ type: "thinking", thinking: "internal only" }],
      },
      { role: "user", content: "hello again" },
    ];

    const out = sanitizeAntigravityThinkingBlocks(messages);

    // The all-unsigned assistant message should be dropped entirely.
    expect(out.filter((m) => m.role === "assistant")).toHaveLength(0);
    expect(out).toHaveLength(2);
  });

  it("returns same array reference when no changes needed", () => {
    const messages: AgentMessage[] = [
      { role: "user", content: "hi" },
      { role: "assistant", content: [{ type: "text", text: "hello" }] },
    ];

    const out = sanitizeAntigravityThinkingBlocks(messages);

    expect(out).toBe(messages);
  });
});
