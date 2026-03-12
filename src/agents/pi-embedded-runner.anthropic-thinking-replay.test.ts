import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { AssistantMessage, Message, Model, Usage } from "@mariozechner/pi-ai";
import { streamSimple } from "@mariozechner/pi-ai";
import { SessionManager } from "@mariozechner/pi-coding-agent";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { validateAnthropicTurns } from "./pi-embedded-helpers.js";
import { sanitizeSessionHistory } from "./pi-embedded-runner/google.js";

const ZERO_USAGE: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    total: 0,
  },
};

const ANTHROPIC_MODEL: Model<"anthropic-messages"> = {
  id: "claude-sonnet-4-6",
  name: "Claude Sonnet 4.6",
  api: "anthropic-messages",
  provider: "anthropic",
  baseUrl: "https://api.anthropic.com",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200_000,
  maxTokens: 4096,
};

let tempRoot: string;

beforeAll(async () => {
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-anthropic-replay-"));
});

afterAll(async () => {
  await fs.rm(tempRoot, { recursive: true, force: true });
});

function isLlmMessage(message: AgentMessage): message is Message {
  return (
    typeof message === "object" &&
    message !== null &&
    "role" in message &&
    (message.role === "user" || message.role === "assistant" || message.role === "toolResult")
  );
}

async function captureAnthropicPayload(messages: Message[]) {
  const controller = new AbortController();
  controller.abort();
  let payload: Record<string, unknown> | undefined;
  const stream = streamSimple(
    ANTHROPIC_MODEL,
    {
      systemPrompt: "system",
      messages,
    },
    {
      apiKey: "test",
      signal: controller.signal,
      onPayload: (nextPayload) => {
        payload = nextPayload as Record<string, unknown>;
      },
    },
  );
  await stream.result();
  return payload;
}

function getPayloadAssistantMessages(payload: Record<string, unknown> | undefined) {
  const messages = Array.isArray(payload?.messages) ? payload.messages : [];
  return messages.filter(
    (message): message is { role: "assistant"; content: Array<Record<string, unknown>> } =>
      !!message &&
      typeof message === "object" &&
      (message as { role?: unknown }).role === "assistant" &&
      Array.isArray((message as { content?: unknown }).content),
  );
}

describe("anthropic thinking replay", () => {
  it("drops synthetic assistant transcript mirrors before replay so thinking signatures stay intact", async () => {
    const sessionFile = path.join(tempRoot, `session-${Date.now()}.jsonl`);
    const thinkingSignature = "sig-thinking-123";
    const redactedSignature = "sig-redacted-456";
    const signedAnthropicContent: AssistantMessage["content"] = [
      {
        type: "thinking",
        thinking: "internal reasoning",
        thinkingSignature,
      },
      {
        type: "thinking",
        thinking: "[Reasoning redacted]",
        thinkingSignature: redactedSignature,
        redacted: true,
      },
      { type: "text", text: "final answer" },
    ];

    const sessionManager = SessionManager.open(sessionFile);
    sessionManager.appendMessage({
      role: "user",
      content: "hello",
      timestamp: Date.now(),
    });
    sessionManager.appendMessage({
      role: "assistant",
      api: "anthropic-messages",
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      usage: ZERO_USAGE,
      stopReason: "stop",
      timestamp: Date.now(),
      content: signedAnthropicContent,
    });
    sessionManager.appendMessage({
      role: "assistant",
      api: "openai-responses",
      provider: "openclaw",
      model: "delivery-mirror",
      usage: ZERO_USAGE,
      stopReason: "stop",
      timestamp: Date.now(),
      content: [{ type: "text", text: "final answer" }],
    });
    sessionManager.appendMessage({
      role: "user",
      content: "follow up",
      timestamp: Date.now(),
    });

    const reopened = SessionManager.open(sessionFile);
    const context = reopened.buildSessionContext();
    const replayable = validateAnthropicTurns(
      await sanitizeSessionHistory({
        messages: context.messages,
        modelApi: "anthropic-messages",
        provider: "anthropic",
        modelId: "claude-sonnet-4-6",
        sessionManager: reopened,
        sessionId: "test-session",
      }),
    ).filter(isLlmMessage);

    expect(replayable.map((message) => message.role)).toEqual(["user", "assistant", "user"]);
    const payload = await captureAnthropicPayload(replayable);
    const assistantMessages = getPayloadAssistantMessages(payload);

    expect(assistantMessages).toHaveLength(1);
    expect(assistantMessages[0]?.content).toEqual([
      {
        type: "thinking",
        thinking: "internal reasoning",
        signature: thinkingSignature,
      },
      {
        type: "redacted_thinking",
        data: redactedSignature,
      },
      {
        type: "text",
        text: "final answer",
      },
    ]);
  });
});
