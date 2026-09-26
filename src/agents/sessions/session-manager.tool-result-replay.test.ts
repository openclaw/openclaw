import { streamAnthropic } from "@openclaw/ai/internal/anthropic";
import { describe, expect, it } from "vitest";
import type { Context, Message, Model } from "../../llm/types.js";
import type { AgentMessage } from "../runtime/index.js";
import { createZeroUsageFixture } from "../test-helpers/usage-fixtures.js";
import { parseSessionEntries, SessionManager } from "./session-manager.js";

function replayContext(role: "assistant" | "toolResult", content: unknown) {
  const messages = [
    { role: "user", content: "run lookup", timestamp: 1 },
    {
      role: "assistant",
      provider: "anthropic",
      api: "anthropic-messages",
      model: "claude-sonnet-4-6",
      stopReason: role === "assistant" ? "stop" : "toolUse",
      timestamp: 2,
      usage: createZeroUsageFixture(),
      content:
        role === "assistant"
          ? content
          : [{ type: "toolCall", id: "call_1", name: "lookup", arguments: {} }],
    },
    ...(role === "toolResult"
      ? [{ role, toolCallId: "call_1", toolName: "lookup", content, isError: false, timestamp: 3 }]
      : []),
  ];
  const entries = [
    { type: "session", version: 3, id: "replay-session", cwd: "/tmp/tool-result-replay" },
    ...messages.map((message, index) => ({
      type: "message",
      id: `message-${index}`,
      parentId: index === 0 ? null : `message-${index - 1}`,
      timestamp: "2026-07-01T00:00:00.000Z",
      message,
    })),
  ];
  const jsonl = entries.map((entry) => JSON.stringify(entry)).join("\n");
  return SessionManager.fromEntries(parseSessionEntries(jsonl)).buildSessionContext();
}

async function anthropicPayload(context: { messages: AgentMessage[] }): Promise<unknown> {
  const messages = context.messages.filter(
    (message): message is Message =>
      message.role === "user" || message.role === "assistant" || message.role === "toolResult",
  );
  const model: Model<"anthropic-messages"> = {
    id: "claude-sonnet-4-6",
    name: "Claude Sonnet 4.6",
    provider: "anthropic",
    api: "anthropic-messages",
    baseUrl: "https://api.anthropic.com",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 4096,
  };
  let capturedPayload: unknown;
  const stream = streamAnthropic(model, { messages } satisfies Context, {
    apiKey: "sk-ant-provider",
    onPayload: (payload) => {
      capturedPayload = payload;
      throw new Error("stop before network");
    },
  });
  await stream.result();
  return capturedPayload;
}

describe("SessionManager tool-result replay", () => {
  it("replays string assistant JSONL content as Anthropic assistant text", async () => {
    const context = replayContext("assistant", "assistant replay text");
    const assistant = context.messages.find((message) => message.role === "assistant");
    expect(assistant?.content).toEqual([{ type: "text", text: "assistant replay text" }]);

    const payload = (await anthropicPayload(context)) as {
      messages: Array<{
        role: string;
        content: string | Array<{ type?: unknown; text?: unknown }>;
      }>;
    };
    const assistantPayload = payload.messages.find((message) => message.role === "assistant");
    expect(assistantPayload?.content).toEqual([{ type: "text", text: "assistant replay text" }]);
  });

  it("replays string tool-result JSONL content as Anthropic tool text", async () => {
    const context = replayContext("toolResult", "lookup result text");
    const toolResult = context.messages.find((message) => message.role === "toolResult");
    expect(toolResult?.content).toEqual([{ type: "text", text: "lookup result text" }]);

    const payload = (await anthropicPayload(context)) as {
      messages: Array<{ role: string; content: Array<{ type?: unknown; content?: unknown }> }>;
    };
    const toolResultBlock = payload.messages
      .flatMap((message) => message.content)
      .find((block) => block.type === "tool_result");
    expect(toolResultBlock?.content).toBe("lookup result text");
  });

  it("replays object tool-result JSONL content as structured Anthropic tool text", async () => {
    const content = { output: "status card text" };
    const context = replayContext("toolResult", content);
    const toolResult = context.messages.find((message) => message.role === "toolResult");
    expect(toolResult?.content).toEqual([content]);

    const payload = (await anthropicPayload(context)) as {
      messages: Array<{ role: string; content: Array<{ type?: unknown; content?: unknown }> }>;
    };
    const toolResultBlock = payload.messages
      .flatMap((message) => message.content)
      .find((block) => block.type === "tool_result");
    expect(String(toolResultBlock?.content)).toContain("status card text");
  });
});
