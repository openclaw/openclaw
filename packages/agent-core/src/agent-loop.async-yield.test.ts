import { createAssistantMessageEventStream } from "@openclaw/ai/event-stream";
import type { AssistantMessage, Context, Model, ToolCall } from "@openclaw/llm-core";
import { Type } from "typebox";
import { expect, it, vi } from "vitest";
import { createRequesterYieldCallback } from "../../../src/agents/openclaw-tools.requester-yield.js";
import { isToolResultError } from "../../../src/agents/tool-result-error.js";
import { createSessionsYieldTool } from "../../../src/agents/tools/sessions-yield-tool.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import { runAgentLoop } from "./agent-loop.js";
import type { AgentMessage, AgentTool, StreamFn } from "./types.js";

const model: Model = {
  id: "async-model",
  name: "Async Model",
  api: "test-api",
  provider: "test-provider",
  baseUrl: "https://example.test",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1000,
  maxTokens: 1000,
};
function assistant(content: AssistantMessage["content"], responseId: string): AssistantMessage {
  return {
    role: "assistant",
    content,
    responseId,
    stopReason: "stop",
    api: model.api,
    provider: model.provider,
    model: model.id,
    timestamp: 1,
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
}

it.each([
  { priorResult: "completed", asyncYield: true },
  { priorResult: "pending", asyncYield: true },
  { priorResult: "completed", asyncYield: false },
  { priorResult: "observed", asyncYield: true },
] as const)(
  "delivers $priorResult async output before yielding (async yield: $asyncYield)",
  async ({ priorResult, asyncYield }) => {
    const controller = new AbortController();
    const lookupStarted = createDeferred();
    const lookupRelease = createDeferred();
    const lookupPersisted = createDeferred();
    const firstYieldPersisted = createDeferred();
    const first = createAssistantMessageEventStream();
    const second = createAssistantMessageEventStream();
    const inputs: Context["messages"][] = [];
    const persisted: AgentMessage[] = [];
    const lookupCall: ToolCall = {
      type: "toolCall",
      id: "lookup",
      name: "lookup",
      arguments: {},
      async: true,
    };
    const yieldCall: ToolCall = {
      type: "toolCall",
      id: "yield-first",
      name: "sessions_yield",
      arguments: { waitFor: "message" },
      ...(asyncYield ? { async: true } : {}),
    };
    const lookup: AgentTool = {
      name: "lookup",
      label: "lookup",
      description: "lookup",
      parameters: Type.Object({}),
      execute: async () => {
        lookupStarted.resolve();
        await lookupRelease.promise;
        return { content: [{ type: "text", text: "already completed" }], details: {} };
      },
    };
    const claimYield = vi.fn(
      createRequesterYieldCallback({
        requesterSessionKey: "agent:diagnostic:subagent:child",
        requesterAgentId: "diagnostic",
      }),
    );
    const onYield = vi.fn(() => {
      controller.abort(new Error("sessions_yield"));
      const active = inputs.length === 1 ? first : second;
      active.push({
        type: "error",
        reason: "aborted",
        error: {
          ...assistant([], "yielded"),
          stopReason: "aborted",
          errorMessage: "sessions_yield",
        },
      });
      active.end();
    });
    const yieldTool = createSessionsYieldTool({
      sessionId: "diagnostic-child",
      claimYield,
      onYield,
    });
    const streamFn: StreamFn = (_model, context) => {
      inputs.push(structuredClone(context.messages));
      if (inputs.length === 1) {
        return first;
      }
      const nextCall = { ...yieldCall, id: "yield-next", async: true as const };
      second.push({ type: "start", partial: assistant([], "second") });
      second.push({
        type: "toolcall_end",
        contentIndex: 0,
        toolCall: nextCall,
        partial: assistant([nextCall], "second"),
      });
      return second;
    };
    const run = runAgentLoop(
      [{ role: "user", content: "Inspect then wait", timestamp: 0 }],
      { systemPrompt: "", messages: [], tools: [lookup, yieldTool] },
      {
        model,
        convertToLlm: (messages) => messages as Context["messages"],
        // Mirror the production session hook that classifies structured tool errors.
        afterToolCall: async ({ result }) => ({ isError: isToolResultError(result) }),
      },
      (event) => {
        if (event.type !== "message_end") {
          return;
        }
        persisted.push(event.message);
        if (event.message.role === "toolResult") {
          if (event.message.toolCallId === "lookup") {
            lookupPersisted.resolve();
          }
          if (event.message.toolCallId === "yield-first") {
            firstYieldPersisted.resolve();
          }
        }
      },
      controller.signal,
      streamFn,
    );
    try {
      first.push({ type: "start", partial: assistant([], "first") });
      first.push({
        type: "toolcall_end",
        contentIndex: 0,
        toolCall: lookupCall,
        partial: assistant([lookupCall], "first"),
      });
      await lookupStarted.promise;
      if (priorResult !== "pending") {
        lookupRelease.resolve();
        await lookupPersisted.promise;
      }
      if (priorResult !== "observed") {
        first.push({
          type: "toolcall_end",
          contentIndex: 1,
          toolCall: yieldCall,
          partial: assistant([lookupCall, yieldCall], "first"),
        });
        if (!asyncYield) {
          first.push({
            type: "done",
            reason: "toolUse",
            message: { ...assistant([lookupCall, yieldCall], "first"), stopReason: "toolUse" },
          });
          first.end();
        }
        await firstYieldPersisted.promise;
        expect(claimYield).not.toHaveBeenCalled();
        expect(onYield).not.toHaveBeenCalled();
        expect(persisted).toContainEqual(
          expect.objectContaining({
            role: "toolResult",
            toolCallId: "yield-first",
            isError: false,
            details: expect.objectContaining({ status: "deferred" }),
          }),
        );
        if (priorResult === "pending") {
          expect(
            persisted.some(
              (message) => message.role === "toolResult" && message.toolCallId === "lookup",
            ),
          ).toBe(false);
          lookupRelease.resolve();
          await lookupPersisted.promise;
        }
      }
      if (asyncYield) {
        first.push({
          type: "done",
          reason: "stop",
          message: assistant(
            priorResult === "observed" ? [lookupCall] : [lookupCall, yieldCall],
            "first",
          ),
        });
        first.end();
      }
      await run;
      expect(claimYield).toHaveBeenCalledTimes(1);
      expect(onYield).toHaveBeenCalledTimes(1);
      expect(inputs).toHaveLength(2);
      expect(inputs[1]).toContainEqual(
        expect.objectContaining({
          role: "toolResult",
          toolCallId: "lookup",
          isError: false,
          content: [{ type: "text", text: "already completed" }],
        }),
      );
    } finally {
      lookupRelease.resolve();
      controller.abort();
      for (const response of [first, second]) {
        response.end({ ...assistant([], "cleanup"), stopReason: "aborted" });
      }
      await run;
    }
  },
);
