import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { createAssistantMessageEventStream } from "../../llm-core/src/utils/event-stream.js";
import { agentLoop, agentLoopContinue } from "./agent-loop.js";
import type { Message, Model } from "./llm.js";
import type { AgentContext, AgentEvent, AgentLoopConfig, AgentMessage, StreamFn } from "./types.js";

const model: Model = {
  id: "test-model",
  name: "Test Model",
  api: "test-api",
  provider: "test-provider",
  baseUrl: "https://example.test",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1000,
  maxTokens: 1000,
};

const config: AgentLoopConfig = {
  model,
  convertToLlm: (messages) => messages as Message[],
};

const failingStreamFn: StreamFn = async () => {
  throw new Error("provider exploded");
};

async function collectEvents(stream: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of stream) {
    events.push(event);
  }
  return events;
}

function expectTerminalFailure(events: AgentEvent[], result: AgentMessage[]): void {
  expect(events.map((event) => event.type)).toContain("agent_end");
  expect(result).toHaveLength(1);
  expect(result[0]).toMatchObject({
    role: "assistant",
    stopReason: "error",
    errorMessage: "provider exploded",
  });
}

describe("agentLoop EventStream failures", () => {
  it("ends the public stream when a new prompt run rejects", async () => {
    const stream = agentLoop(
      [{ role: "user", content: "hello", timestamp: 1 }],
      { systemPrompt: "", messages: [] },
      config,
      undefined,
      failingStreamFn,
    );

    const events = await collectEvents(stream);
    const result = await stream.result();

    expectTerminalFailure(events, result);
  });

  it("ends the public stream when a continue run rejects", async () => {
    const context: AgentContext = {
      systemPrompt: "",
      messages: [{ role: "user", content: "hello", timestamp: 1 }],
    };
    const stream = agentLoopContinue(context, config, undefined, failingStreamFn);

    const events = await collectEvents(stream);
    const result = await stream.result();

    expectTerminalFailure(events, result);
  });
});

describe("agentLoop tool metadata", () => {
  it("emits terminal fallback metadata on tool execution start", async () => {
    const assistantMessage = {
      role: "assistant",
      api: "test-api",
      provider: "test-provider",
      model: "test-model",
      content: [
        {
          type: "toolCall",
          id: "tool-call-1",
          name: "status_probe",
          arguments: {},
        },
      ],
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "toolUse",
      timestamp: 1,
    } satisfies Extract<AgentMessage, { role: "assistant" }>;
    const finalMessage = {
      ...assistantMessage,
      content: [{ type: "text", text: "Status: healthy" }],
      stopReason: "stop",
    } satisfies Extract<AgentMessage, { role: "assistant" }>;
    let callCount = 0;
    const streamFn: StreamFn = async () => {
      const stream = createAssistantMessageEventStream();
      callCount += 1;
      queueMicrotask(() => {
        const message = callCount === 1 ? assistantMessage : finalMessage;
        const reason = callCount === 1 ? "toolUse" : "stop";
        stream.push({ type: "start", partial: message });
        stream.push({ type: "done", reason, message });
      });
      return stream;
    };
    const context: AgentContext = {
      systemPrompt: "",
      messages: [],
      tools: [
        {
          name: "status_probe",
          label: "Status Probe",
          description: "Read status.",
          parameters: Type.Object({}),
          terminalResultFallback: { mode: "safe_text", prefix: "Status:" },
          execute: async () => ({
            content: [{ type: "text", text: "healthy" }],
            details: { status: "ok" },
          }),
          toolContext: {} as never,
        },
      ],
    };

    const stream = agentLoop(
      [{ role: "user", content: "check status", timestamp: 1 }],
      context,
      config,
      undefined,
      streamFn,
    );

    const events = await collectEvents(stream);

    expect(
      events.find(
        (event): event is Extract<AgentEvent, { type: "tool_execution_start" }> =>
          event.type === "tool_execution_start",
      ),
    ).toMatchObject({
      toolCallId: "tool-call-1",
      toolName: "status_probe",
      terminalResultFallback: { mode: "safe_text", prefix: "Status:" },
    });
  });
});
