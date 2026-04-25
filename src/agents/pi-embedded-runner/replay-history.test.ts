import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { describe, expect, it } from "vitest";
import { normalizeAssistantReplayContent } from "./replay-history.js";

const FALLBACK_TEXT = "[assistant turn failed before producing content]";

function bedrockAssistant(content: unknown): AgentMessage {
  return {
    role: "assistant",
    content,
    api: "bedrock-converse-stream",
    provider: "amazon-bedrock",
    model: "anthropic.claude-3-haiku-20240307-v1:0",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "error",
    timestamp: 0,
  } as unknown as AgentMessage;
}

function userMessage(text: string): AgentMessage {
  return { role: "user", content: text, timestamp: 0 } as unknown as AgentMessage;
}

function openclawTranscriptAssistant(model: "delivery-mirror" | "gateway-injected"): AgentMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text: "channel mirror" }],
    api: "openai-responses",
    provider: "openclaw",
    model,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: 0,
  } as unknown as AgentMessage;
}

describe("normalizeAssistantReplayContent", () => {
  it("converts assistant content: [] to a non-empty sentinel text block", () => {
    const messages = [userMessage("hello"), bedrockAssistant([])];
    const out = normalizeAssistantReplayContent(messages);
    expect(out).not.toBe(messages);
    const repaired = out[1] as AgentMessage & { content: { type: string; text: string }[] };
    expect(repaired.content).toEqual([{ type: "text", text: FALLBACK_TEXT }]);
  });

  it("wraps legacy string assistant content as a single text block (regression)", () => {
    const messages = [userMessage("hi"), bedrockAssistant("plain string content")];
    const out = normalizeAssistantReplayContent(messages);
    const wrapped = out[1] as AgentMessage & { content: { type: string; text: string }[] };
    expect(wrapped.content).toEqual([{ type: "text", text: "plain string content" }]);
  });

  it("filters openclaw delivery-mirror and gateway-injected assistant messages from replay", () => {
    const messages = [
      userMessage("hello"),
      openclawTranscriptAssistant("delivery-mirror"),
      bedrockAssistant([{ type: "text", text: "real reply" }]),
      openclawTranscriptAssistant("gateway-injected"),
    ];
    const out = normalizeAssistantReplayContent(messages);
    expect(out).toHaveLength(2);
    expect((out[0] as { role: string }).role).toBe("user");
    expect((out[1] as { provider: string }).provider).toBe("amazon-bedrock");
  });

  it("returns the original array reference when nothing needs to change", () => {
    const messages = [userMessage("hello"), bedrockAssistant([{ type: "text", text: "fine" }])];
    const out = normalizeAssistantReplayContent(messages);
    expect(out).toBe(messages);
  });
});
