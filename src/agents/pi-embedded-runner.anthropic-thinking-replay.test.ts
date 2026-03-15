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

function isAbortError(error: unknown): boolean {
  return (
    (error instanceof Error && error.name === "AbortError") ||
    (typeof error === "object" &&
      error !== null &&
      "name" in error &&
      (error as { name?: unknown }).name === "AbortError")
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
  try {
    // The stream is pre-aborted on purpose; this test only needs the constructed payload from onPayload.
    await stream.result();
  } catch (error) {
    if (!isAbortError(error)) {
      throw error;
    }
  }
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

async function getReplayableMessages(sessionFile: string) {
  return getReplayableMessagesForTarget(sessionFile, {
    modelApi: "anthropic-messages",
    provider: "anthropic",
    modelId: "claude-sonnet-4-6",
  });
}

async function getReplayableMessagesForTarget(
  sessionFile: string,
  target: {
    modelApi: string;
    provider: string;
    modelId: string;
  },
) {
  const reopened = SessionManager.open(sessionFile);
  const context = reopened.buildSessionContext();
  const replayable = await sanitizeSessionHistory({
    messages: context.messages,
    modelApi: target.modelApi,
    provider: target.provider,
    modelId: target.modelId,
    sessionManager: reopened,
    sessionId: "test-session",
  });
  const validated = shouldValidateAnthropicReplayTarget(target)
    ? validateAnthropicTurns(replayable)
    : replayable;
  return validated.filter(isLlmMessage);
}

function shouldValidateAnthropicReplayTarget(target: {
  modelApi: string;
  provider: string;
  modelId: string;
}): boolean {
  return target.provider === "anthropic" || target.modelApi === "anthropic-messages";
}

describe("anthropic thinking replay", () => {
  it("drops duplicated delivery-mirror assistant shadows before replay so thinking signatures stay intact", async () => {
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

    const replayable = await getReplayableMessages(sessionFile);

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

  it("keeps gateway-injected assistant entries in replay history", async () => {
    const sessionFile = path.join(tempRoot, `session-${Date.now()}-gateway.jsonl`);

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
      content: [{ type: "text", text: "partial reply" }],
    });
    sessionManager.appendMessage({
      role: "assistant",
      api: "openai-responses",
      provider: "openclaw",
      model: "gateway-injected",
      usage: ZERO_USAGE,
      stopReason: "stop",
      timestamp: Date.now(),
      content: [{ type: "text", text: "resume from here" }],
    });
    sessionManager.appendMessage({
      role: "user",
      content: "continue",
      timestamp: Date.now(),
    });

    const replayable = await getReplayableMessages(sessionFile);

    expect(replayable.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "assistant",
      "user",
    ]);
    expect(replayable[2]).toMatchObject({
      role: "assistant",
      provider: "openclaw",
      model: "gateway-injected",
      content: [{ type: "text", text: "resume from here" }],
    });
  });

  it("keeps delivery-mirror assistant entries when they are the only assistant history", async () => {
    const sessionFile = path.join(tempRoot, `session-${Date.now()}-mirror-only.jsonl`);

    const sessionManager = SessionManager.open(sessionFile);
    sessionManager.appendMessage({
      role: "user",
      content: "hello",
      timestamp: Date.now(),
    });
    sessionManager.appendMessage({
      role: "assistant",
      api: "openai-responses",
      provider: "openclaw",
      model: "delivery-mirror",
      usage: ZERO_USAGE,
      stopReason: "stop",
      timestamp: Date.now(),
      content: [{ type: "text", text: "persisted outbound reply" }],
    });
    sessionManager.appendMessage({
      role: "user",
      content: "continue",
      timestamp: Date.now(),
    });

    const replayable = await getReplayableMessages(sessionFile);

    expect(replayable.map((message) => message.role)).toEqual(["user", "assistant", "user"]);
    expect(replayable[1]).toMatchObject({
      role: "assistant",
      provider: "openclaw",
      model: "delivery-mirror",
      content: [{ type: "text", text: "persisted outbound reply" }],
    });
  });

  it("keeps delivery-mirror assistant entries for non-anthropic replay", async () => {
    const sessionFile = path.join(tempRoot, `session-${Date.now()}-openai.jsonl`);

    const sessionManager = SessionManager.open(sessionFile);
    sessionManager.appendMessage({
      role: "user",
      content: "hello",
      timestamp: Date.now(),
    });
    sessionManager.appendMessage({
      role: "assistant",
      api: "openai-responses",
      provider: "openclaw",
      model: "delivery-mirror",
      usage: ZERO_USAGE,
      stopReason: "stop",
      timestamp: Date.now(),
      content: [{ type: "text", text: "persisted outbound reply" }],
    });
    sessionManager.appendMessage({
      role: "user",
      content: "continue",
      timestamp: Date.now(),
    });

    const replayable = await getReplayableMessagesForTarget(sessionFile, {
      modelApi: "openai-responses",
      provider: "openai",
      modelId: "gpt-5.2",
    });

    expect(replayable.map((message) => message.role)).toEqual(["user", "assistant", "user"]);
    expect(replayable[1]).toMatchObject({
      role: "assistant",
      provider: "openclaw",
      model: "delivery-mirror",
      content: [{ type: "text", text: "persisted outbound reply" }],
    });
  });
});
