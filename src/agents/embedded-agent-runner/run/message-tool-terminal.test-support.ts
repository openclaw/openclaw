import type { AssistantMessage, Model } from "openclaw/plugin-sdk/llm";
import { Agent, type AgentTool } from "../../runtime/index.js";
import { createQueuedAssistantStream } from "../../test-helpers/assistant-event-stream.test-support.js";
import { createZeroUsageFixture } from "../../test-helpers/usage-fixtures.js";
import { installMessageToolTerminalHook } from "./message-tool-terminal.js";

export function createTerminalTestModel(): Model {
  return {
    id: "test-model",
    name: "Test Model",
    api: "openai-responses",
    provider: "test-provider",
    baseUrl: "https://example.test",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1_000,
    maxTokens: 1_000,
  };
}

const terminalModel = createTerminalTestModel();

export function terminalResponse(
  content: AssistantMessage["content"],
  stopReason: "toolUse" | "error" | "stop",
  overrides: Partial<AssistantMessage> = {},
) {
  const message: AssistantMessage = {
    role: "assistant",
    api: terminalModel.api,
    provider: terminalModel.provider,
    model: terminalModel.id,
    usage: createZeroUsageFixture(),
    timestamp: 0,
    content,
    stopReason,
    ...overrides,
  };
  return createQueuedAssistantStream((push) => {
    if (stopReason === "error") {
      push({ type: "error", reason: "error", error: message });
    } else {
      push({ type: "done", reason: stopReason, message });
    }
  });
}

export function terminalToolCall(name: string, id: string, args: Record<string, unknown> = {}) {
  return { type: "toolCall" as const, name, id, arguments: args };
}

export function terminalMessageAgent(
  tools: AgentTool[],
  step: (request: number) => ReturnType<typeof terminalResponse>,
  afterToolCall: Agent["afterToolCall"],
) {
  const counts = { requests: 0, deliveries: 0 };
  const agent = new Agent({
    initialState: { model: terminalModel, tools },
    streamFn: () => step(++counts.requests),
  });
  agent.afterToolCall = afterToolCall;
  installMessageToolTerminalHook({
    agent,
    sourceReplyDeliveryMode: "automatic",
    onDeliveredSourceReply: () => {
      counts.deliveries += 1;
    },
  });
  return { agent, counts };
}
