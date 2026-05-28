import { describe, expect, it } from "vitest";
import { agentLoop, agentLoopContinue } from "./agent-loop.js";
import {
  EventStream,
  type AssistantMessage,
  type AssistantMessageEvent,
  type Message,
  type Model,
} from "./llm.js";
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

const emptyUsage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const failingStreamFn: StreamFn = async () => {
  throw new Error("provider exploded");
};

function assistantMessage(content: AssistantMessage["content"]): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: "test-api",
    provider: "test-provider",
    model: "test-model",
    stopReason: "stop",
    timestamp: 2,
    usage: emptyUsage,
  };
}

function streamEvents(events: AssistantMessageEvent[]): StreamFn {
  return async () => {
    const stream = new EventStream<AssistantMessageEvent, AssistantMessage>(
      (event) => event.type === "done" || event.type === "error",
      (event) => (event.type === "done" ? event.message : event.error),
    );
    queueMicrotask(() => {
      for (const event of events) {
        stream.push(event);
      }
    });
    return stream;
  };
}

function assistantText(message: AgentMessage | undefined): string {
  if (!message || message.role !== "assistant") {
    return "";
  }
  return message.content.map((part) => (part.type === "text" ? part.text : "")).join("");
}

function assistantToolName(message: AgentMessage | undefined): string {
  if (!message || message.role !== "assistant") {
    return "";
  }
  return message.content.find((part) => part.type === "toolCall")?.name ?? "";
}

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

  it("accumulates lightweight text delta partials for message updates", async () => {
    const finalMessage = assistantMessage([{ type: "text", text: "Hello" }]);
    const stream = agentLoop(
      [{ role: "user", content: "hello", timestamp: 1 }],
      { systemPrompt: "", messages: [] },
      config,
      undefined,
      streamEvents([
        { type: "start", partial: assistantMessage([]) },
        {
          type: "text_start",
          contentIndex: 0,
          partial: assistantMessage([{ type: "text", text: "" }]),
        },
        { type: "text_delta", contentIndex: 0, delta: "Hel", partial: assistantMessage([]) },
        { type: "text_delta", contentIndex: 0, delta: "lo", partial: assistantMessage([]) },
        { type: "text_end", contentIndex: 0, content: "Hello", partial: finalMessage },
        { type: "done", reason: "stop", message: finalMessage },
      ]),
    );

    const events = await collectEvents(stream);
    const updates = events.filter((event) => event.type === "message_update");

    expect(updates.map((event) => assistantText(event.message))).toEqual([
      "",
      "Hel",
      "Hello",
      "Hello",
    ]);
  });

  it("preserves tool-call state across lightweight tool-call deltas", async () => {
    const toolCall = { type: "toolCall" as const, id: "call-1", name: "search", arguments: {} };
    const finalMessage = assistantMessage([]);
    const stream = agentLoop(
      [{ role: "user", content: "hello", timestamp: 1 }],
      { systemPrompt: "", messages: [] },
      config,
      undefined,
      streamEvents([
        { type: "start", partial: assistantMessage([]) },
        { type: "toolcall_start", contentIndex: 0, partial: assistantMessage([toolCall]) },
        { type: "toolcall_delta", contentIndex: 0, delta: '{"q"', partial: assistantMessage([]) },
        {
          type: "toolcall_delta",
          contentIndex: 0,
          delta: ':"openclaw"}',
          partial: assistantMessage([]),
        },
        { type: "done", reason: "stop", message: finalMessage },
      ]),
    );

    const events = await collectEvents(stream);
    const updates = events.filter((event) => event.type === "message_update");

    expect(updates.map((event) => assistantToolName(event.message))).toEqual([
      "search",
      "search",
      "search",
    ]);
  });
});
