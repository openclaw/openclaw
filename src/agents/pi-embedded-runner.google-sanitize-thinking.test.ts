import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { SessionManager } from "@mariozechner/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { sanitizeSessionHistory } from "./pi-embedded-runner/google.js";

type AssistantContentBlock = {
  type?: string;
  text?: string;
  thinking?: string;
  thinkingSignature?: string;
  thought_signature?: string;
  thoughtSignature?: string;
  id?: string;
  name?: string;
  arguments?: unknown;
};

function getAssistantMessage(out: AgentMessage[]) {
  const assistant = out.find((msg) => (msg as { role?: string }).role === "assistant") as
    | { content?: AssistantContentBlock[] }
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
  provider?: string;
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
    provider: params.provider,
    modelId: params.modelId,
    sessionManager,
    sessionId: params.sessionId,
  });
}

function geminiThoughtSignatureInput() {
  return [
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
  ];
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

  it("converts unsigned thinking blocks to text for Antigravity Claude", async () => {
    const out = await sanitizeSimpleSession({
      modelApi: "google-antigravity",
      modelId: "anthropic/claude-3.5-sonnet",
      sessionId: "session:antigravity-claude",
      content: [{ type: "thinking", thinking: "reasoning" }],
    });

    const assistant = out.find((msg) => (msg as { role?: string }).role === "assistant") as {
      content?: Array<{ type?: string; text?: string }>;
    };
    expect(assistant.content).toEqual([{ type: "text", text: "reasoning" }]);
  });

  it("maps base64 signatures to thinkingSignature for Antigravity Claude", async () => {
    const out = await sanitizeSimpleSession({
      modelApi: "google-antigravity",
      modelId: "anthropic/claude-3.5-sonnet",
      sessionId: "session:antigravity-claude",
      content: [{ type: "thinking", thinking: "reasoning", signature: "c2ln" }],
    });

    const assistant = getAssistantMessage(out);
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
    const out = await sanitizeSimpleSession({
      modelApi: "openrouter",
      provider: "openrouter",
      modelId: "google/gemini-1.5-pro",
      sessionId: "session:openrouter-gemini",
      content: geminiThoughtSignatureInput(),
    });

    const assistant = getAssistantMessage(out);
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

  it("strips non-base64 thought signatures for native Google Gemini", async () => {
    const out = await sanitizeSimpleSession({
      modelApi: "google-generative-ai",
      provider: "google",
      modelId: "gemini-2.0-flash",
      sessionId: "session:google-gemini",
      content: geminiThoughtSignatureInput(),
    });

    const assistant = getAssistantMessage(out);
    expect(assistant.content).toEqual([
      { type: "text", text: "hello" },
      { type: "thinking", thinking: "ok", thought_signature: "c2ln" },
      {
        type: "toolCall",
        id: "call1",
        name: "read",
        arguments: { path: "/tmp/foo" },
      },
      {
        type: "toolCall",
        id: "call2",
        name: "read",
        arguments: { path: "/tmp/bar" },
        thoughtSignature: "c2ln",
      },
    ]);
  });

  it("keeps mixed signed/unsigned thinking blocks for Google models", async () => {
    const assistant = await sanitizeGoogleAssistantWithContent([
      { type: "thinking", thinking: "signed", thinkingSignature: "sig" },
      { type: "thinking", thinking: "unsigned" },
    ]);
    expect(assistant.content?.map((block) => block.type)).toEqual(["thinking", "thinking"]);
    expect(assistant.content?.[0]?.thinking).toBe("signed");
    expect(assistant.content?.[1]?.thinking).toBe("unsigned");
  });

  it("keeps empty thinking blocks for Google models", async () => {
    const assistant = await sanitizeGoogleAssistantWithContent([
      { type: "thinking", thinking: "   " },
    ]);
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
