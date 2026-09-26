// Agent Core tests cover argument-validation rejections in whole-batch tool admission.
import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import { captureAgentLoop, collectEvents } from "./agent-loop.test-support.js";
import { attachInternalToolBatchLifecycle } from "./internal-hooks.js";
import {
  type AssistantMessage,
  createAssistantMessageEventStream,
  type Message,
  type Model,
} from "./llm.js";
import type {
  AgentEvent,
  AgentLoopConfig,
  AgentTool,
  InternalToolBatchCall,
  StreamFn,
} from "./types.js";

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

function createTurnSequenceStream(turns: AssistantMessage["content"][]): StreamFn {
  let turnIndex = 0;
  return () => {
    const content = turns[turnIndex++] ?? [{ type: "text", text: "done" }];
    const message: AssistantMessage = {
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
    const stream = createAssistantMessageEventStream();
    queueMicrotask(() => {
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

function makeTool(name: string, executed: string[], required = false): AgentTool {
  return {
    name,
    label: name,
    description: name,
    parameters: required
      ? Type.Object({ path: Type.String() }, { additionalProperties: false })
      : Type.Object({}, { additionalProperties: false }),
    execute: async () => {
      executed.push(name);
      return { content: [{ type: "text", text: `${name} result` }], details: { name } };
    },
  };
}

describe("agentLoop argument-validation admission", () => {
  it("admits argument-validation failures so a repeated rejected call reaches loop recovery", async () => {
    const executed: string[] = [];
    const admittedCalls: InternalToolBatchCall[][] = [];
    const events = await collectEvents(
      captureAgentLoop(
        [{ role: "user", content: "run", timestamp: 1 }],
        { systemPrompt: "", messages: [], tools: [makeTool("edit", executed, true)] },
        {
          ...config,
          beforeToolBatch: async ({ calls }) => {
            admittedCalls.push(calls);
            const first = calls[0];
            return first
              ? {
                  intervention: {
                    kind: "critical-tool-loop",
                    toolCallId: first.toolCall.id,
                    toolName: first.toolCall.name,
                    actionKey: "edit:same-action",
                    detector: "generic_repeat",
                    count: 20,
                    reason: "CRITICAL: edit is looping",
                  },
                }
              : undefined;
          },
        },
        undefined,
        createTurnSequenceStream([
          [{ type: "toolCall", id: "invalid-1", name: "edit", arguments: {} }],
          [{ type: "text", text: "recovered" }],
        ]),
      ),
    );

    expect(admittedCalls).toEqual([
      [
        {
          toolCall: expect.objectContaining({ id: "invalid-1", name: "edit" }),
          args: {},
          validationFailure: {
            content: [{ type: "text", text: expect.stringContaining("path") }],
            details: {},
          },
        },
      ],
    ]);
    expect(executed).toEqual([]);
    expect(
      events.flatMap((event) =>
        event.type === "message_end" && event.message.role === "toolResult" ? [event.message] : [],
      ),
    ).toMatchObject([
      {
        toolCallId: "invalid-1",
        isError: true,
        details: { status: "blocked", deniedReason: "tool-loop" },
      },
    ]);
    expect(
      events.filter((event) => event.type === "message_end" && event.message.role === "assistant"),
    ).toHaveLength(2);
  });

  it.each(["parallel", "sequential"] as const)(
    "commits a rejected %s call at its assistant-order launch position",
    async (toolExecution) => {
      const executed: string[] = [];
      const committed: Array<{ toolCallId: string; args: unknown }> = [];
      const releaseSkippedCalls = vi.fn();
      const events: AgentEvent[] = await collectEvents(
        captureAgentLoop(
          [{ role: "user", content: "run", timestamp: 1 }],
          {
            systemPrompt: "",
            messages: [],
            tools: [makeTool("first", executed), makeTool("edit", executed, true)],
          },
          {
            ...config,
            toolExecution,
            beforeToolBatch: async () =>
              attachInternalToolBatchLifecycle(
                {},
                {
                  commitReadyCalls: (calls) => committed.push(...calls),
                  releaseSkippedCalls,
                },
              ),
          },
          undefined,
          createTurnSequenceStream([
            [
              { type: "toolCall", id: "valid-before", name: "first", arguments: {} },
              { type: "toolCall", id: "rejected", name: "edit", arguments: {} },
              { type: "toolCall", id: "valid-after", name: "first", arguments: {} },
            ],
          ]),
        ),
      );

      expect(committed).toEqual([
        { toolCallId: "valid-before", args: {} },
        { toolCallId: "rejected", args: {} },
        { toolCallId: "valid-after", args: {} },
      ]);
      expect(releaseSkippedCalls).not.toHaveBeenCalled();
      expect(executed).toEqual(["first", "first"]);
      expect(
        events.flatMap((event) =>
          event.type === "message_end" && event.message.role === "toolResult"
            ? [[event.message.toolCallId, event.message.isError]]
            : [],
        ),
      ).toEqual([
        ["valid-before", false],
        ["rejected", true],
        ["valid-after", false],
      ]);
    },
  );
});
