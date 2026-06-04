import { describe, expect, it } from "vitest";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type Model,
} from "../../llm-core/src/index.js";
import { runAgentLoop } from "./agent-loop.js";
import type { AgentEvent, AgentLoopConfig, AgentTool } from "./types.js";

const usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const model = {
  id: "test-model",
  name: "test model",
  api: "test",
  provider: "test",
  baseUrl: "",
  reasoning: false,
  input: [],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 0,
  maxTokens: 0,
} satisfies Model;

function createConfig(): AgentLoopConfig {
  return {
    model,
    convertToLlm: (messages) =>
      messages.flatMap((message) =>
        message.role === "user" || message.role === "assistant" || message.role === "toolResult"
          ? [message]
          : [],
      ),
    shouldStopAfterTurn: () => true,
  };
}

function streamToolCall(toolName: string) {
  const stream = createAssistantMessageEventStream();
  const message = {
    role: "assistant",
    content: [{ type: "toolCall", id: "call-1", name: toolName, arguments: {} }],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage,
    stopReason: "toolUse",
    timestamp: 0,
  } satisfies AssistantMessage;
  stream.push({ type: "done", reason: "toolUse", message });
  return stream;
}

function createReadableTool(): AgentTool {
  return {
    name: "safe_tool",
    label: "Safe tool",
    description: "safe tool",
    parameters: { type: "object", properties: {} },
    async execute() {
      return { content: [{ type: "text", text: "ok" }], details: {} };
    },
  };
}

describe("runAgentLoop tool validation", () => {
  it("skips unreadable sibling tool names when preparing a requested tool call", async () => {
    const hostileTool = {
      get name(): string {
        throw new Error("tool name exploded");
      },
      label: "Hostile",
      description: "hostile sibling",
      parameters: { type: "object", properties: {} },
      async execute() {
        return { content: [{ type: "text", text: "bad" }], details: {} };
      },
    } as AgentTool;
    const events: AgentEvent[] = [];

    await runAgentLoop(
      [{ role: "user", content: "call it", timestamp: 0 }],
      {
        systemPrompt: "",
        messages: [],
        tools: [hostileTool, createReadableTool()],
      },
      createConfig(),
      (event) => {
        events.push(event);
      },
      undefined,
      () => streamToolCall("safe_tool"),
    );

    const toolEnd = events.find(
      (event) => event.type === "tool_execution_end" && event.toolName === "safe_tool",
    );
    expect(toolEnd).toMatchObject({
      type: "tool_execution_end",
      toolCallId: "call-1",
      isError: false,
    });
  });
});
