/**
 * Per-invocation tool-result taint through the assistant turn: a result-level
 * `resultContentSource` wins over the tool's static marker, and either marks
 * the turn tainted for subsequent memory writes.
 */
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { captureAgentLoop, collectEvents } from "./agent-loop.test-support.js";
import {
  type AssistantMessage,
  type Context,
  createAssistantMessageEventStream,
  type Message,
  type Model,
} from "./llm.js";
import type { AgentLoopConfig, AgentMessage, AgentTool, StreamFn } from "./types.js";

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

function makeTool(name: string, executed: string[]): AgentTool {
  return {
    name,
    label: name,
    description: name,
    parameters: Type.Object({}, { additionalProperties: false }),
    execute: async () => {
      executed.push(name);
      return {
        content: [{ type: "text", text: `${name} result` }],
        details: { name },
      };
    },
  };
}

function makeAssistantMessage(content: AssistantMessage["content"]): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: content.some((item) => item.type === "toolCall") ? "toolUse" : "stop",
    timestamp: 1,
  };
}

function createTurnSequenceStream(turns: AssistantMessage["content"][]): StreamFn {
  let turnIndex = 0;
  return (_activeModel: Model, _context: Context) => {
    const content = turns[turnIndex];
    turnIndex += 1;
    if (!content) {
      throw new Error(`unexpected provider request ${turnIndex}`);
    }
    const stream = createAssistantMessageEventStream();
    queueMicrotask(() => {
      const message = makeAssistantMessage(content);
      stream.push({
        type: "done",
        reason: message.stopReason === "toolUse" ? "toolUse" : "stop",
        message,
      });
      stream.end();
    });
    return stream;
  };
}

describe("agentLoop tool-result taint", () => {
  it.each([
    { resultSource: "network" as const, toolSource: undefined, tainted: true },
    { resultSource: undefined, toolSource: "network" as const, tainted: true },
    { resultSource: undefined, toolSource: undefined, tainted: false },
  ])(
    "persists per-invocation $resultSource and static $toolSource tool-result taint through the assistant turn",
    async ({ resultSource, toolSource, tainted }) => {
      const tool: AgentTool = {
        ...makeTool("fetch", []),
        ...(toolSource ? { resultContentSource: toolSource } : {}),
        execute: async () => ({
          content: [{ type: "text", text: "fetch result" }],
          details: { name: "fetch" },
          ...(resultSource ? { resultContentSource: resultSource } : {}),
        }),
      };
      const streamFn = createTurnSequenceStream([
        [{ type: "toolCall", id: "call-fetch", name: tool.name, arguments: {} }],
        [{ type: "text", text: "stored result" }],
      ]);

      const run = captureAgentLoop(
        [{ role: "user", content: "fetch", timestamp: 1 }],
        { systemPrompt: "", messages: [], tools: [tool] },
        config,
        undefined,
        streamFn,
      );
      await collectEvents(run);
      const messages = await run.result;
      const toolResult = messages.find((message) => message.role === "toolResult");
      const assistant = messages.findLast(
        (message): message is AssistantMessage => message.role === "assistant",
      );
      const metadata = (message: AgentMessage | undefined) =>
        message ? (message as unknown as Record<string, unknown>)["__openclaw"] : undefined;

      expect(metadata(toolResult)).toEqual(
        tainted ? { resultContentSource: "network" } : undefined,
      );
      expect(metadata(assistant)).toEqual(tainted ? { turnTainted: true } : undefined);
    },
  );
});

describe("agentLoop tool-result taint under result patching", () => {
  it("keeps network taint when an afterToolCall hook replaces the displayed result", async () => {
    const originalResult = {
      content: [{ type: "text" as const, text: "sent" }],
      details: { phase: "original" },
      resultContentSource: "network" as const,
    };
    const tool: AgentTool = {
      name: "patched",
      label: "patched",
      description: "patched",
      parameters: Type.Object({}, { additionalProperties: false }),
      execute: async () => originalResult,
    };
    const streamFn = createTurnSequenceStream([
      [{ type: "toolCall", id: "call-patched", name: tool.name, arguments: {} }],
    ]);

    const run = captureAgentLoop(
      [{ role: "user", content: "run", timestamp: 1 }],
      { systemPrompt: "", messages: [], tools: [tool] },
      {
        ...config,
        afterToolCall: async () => ({ details: { phase: "patched" }, terminate: true }),
      },
      undefined,
      streamFn,
    );
    await collectEvents(run);
    const messages = await run.result;
    const toolResult = messages.find((message) => message.role === "toolResult");
    const metadata = (toolResult as unknown as Record<string, unknown>)["__openclaw"];

    expect(toolResult).toMatchObject({
      content: originalResult.content,
      details: { phase: "patched" },
    });
    expect(metadata).toEqual({ resultContentSource: "network" });
  });
});
