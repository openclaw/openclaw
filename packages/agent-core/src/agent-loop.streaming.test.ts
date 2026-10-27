import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { runAgentLoop } from "./agent-loop.js";
import {
  captureAgentLoop,
  collectEvents,
  config,
  makeAssistantMessage,
  makeCall,
  makeTool,
  reply,
  user,
} from "./agent-loop.test-support.js";
import { type AssistantMessage, createAssistantMessageEventStream, type Context } from "./llm.js";
import type { AgentEvent, StreamFn } from "./types.js";

describe("agentLoop streaming updates", () => {
  it.each([false, true])(
    "rebuilds text-delta snapshots (explicit undefined partial: %s)",
    async (explicitPartial) => {
      const firstDeltaConsumed = createDeferred();
      const streamFn: StreamFn = () => {
        const stream = createAssistantMessageEventStream();
        const startMessage = makeAssistantMessage([]);
        const finalMessage = makeAssistantMessage([{ type: "text", text: "Hello world" }]);
        stream.push({ type: "start", partial: startMessage });
        stream.push({
          type: "text_start",
          contentIndex: 0,
          partial: { ...startMessage, content: [] },
        });
        stream.push({
          type: "text_delta",
          contentIndex: 0,
          delta: "Hello",
          ...(explicitPartial ? { partial: undefined } : {}),
        });
        void firstDeltaConsumed.promise.then(() => {
          stream.push({
            type: "text_delta",
            contentIndex: 0,
            delta: " world",
            ...(explicitPartial ? { partial: undefined } : {}),
          });
          stream.push({
            type: "text_end",
            contentIndex: 0,
            content: "Hello world",
            partial: finalMessage,
          });
          stream.push({ type: "done", reason: "stop", message: finalMessage });
        });
        return stream;
      };
      const events: AgentEvent[] = [];
      await runAgentLoop(
        [user("hello")],
        { systemPrompt: "", messages: [] },
        config,
        (event) => {
          events.push(event);
          if (
            event.type === "message_update" &&
            event.assistantMessageEvent.type === "text_delta"
          ) {
            firstDeltaConsumed.resolve();
          }
        },
        undefined,
        streamFn,
      );
      const deltas = events.filter(
        (event): event is Extract<AgentEvent, { type: "message_update" }> =>
          event.type === "message_update" && event.assistantMessageEvent.type === "text_delta",
      );
      expect(deltas).toHaveLength(2);
      expect(deltas.map((event) => event.message)).toMatchObject([
        { role: "assistant", content: [{ type: "text", text: "Hello" }] },
        { role: "assistant", content: [{ type: "text", text: "Hello world" }] },
      ]);
      for (const event of deltas) {
        expect(Object.isFrozen(event.message)).toBe(true);
        expect(Reflect.set(event.message, "stopReason", "error")).toBe(false);
        if (explicitPartial) {
          expect(event.assistantMessageEvent).toHaveProperty("partial", event.message);
          if (event.assistantMessageEvent.type === "text_delta") {
            expect(event.assistantMessageEvent.partial).toBe(event.message);
          }
        } else {
          expect(event.assistantMessageEvent).not.toHaveProperty("partial");
        }
      }
    },
  );

  it("does not execute tool calls from a max-token-truncated assistant turn", async () => {
    const execute = vi.fn(async () => ({ content: [], details: {} }));
    const contexts: Context[] = [];
    const streamFn: StreamFn = (_model, context) => {
      contexts.push(context);
      if (contexts.length > 1) {
        return reply(makeAssistantMessage([{ type: "text", text: "continued" }]));
      }
      const call = makeCall("sessions_spawn", "call-truncated-spawn");
      const message: AssistantMessage = {
        ...makeAssistantMessage([{ type: "text", text: "spawning" }, call]),
        stopReason: "length",
      };
      const stream = createAssistantMessageEventStream();
      stream.push({ type: "start", partial: { ...message, content: [] } });
      stream.push({ type: "toolcall_start", contentIndex: 1, partial: message });
      stream.push({ type: "toolcall_end", contentIndex: 1, toolCall: call, partial: message });
      stream.push({ type: "done", reason: "length", message });
      return stream;
    };
    const run = captureAgentLoop(
      [user()],
      { systemPrompt: "", messages: [], tools: [{ ...makeTool("sessions_spawn"), execute }] },
      {
        ...config,
        getFollowUpMessages: async () => (contexts.length === 1 ? [user("continue", 2)] : []),
      },
      undefined,
      streamFn,
    );
    const events = await collectEvents(run);
    const messages = await run.result;
    const emitted = events.find(
      (event): event is Extract<AgentEvent, { type: "message_end" }> =>
        event.type === "message_end" &&
        event.message.role === "assistant" &&
        event.message.stopReason === "length",
    );
    expect(execute).not.toHaveBeenCalled();
    expect(events.some((event) => event.type === "tool_execution_start")).toBe(false);
    expect(messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
    ]);
    expect(emitted).toBeDefined();
    for (const message of [messages[1], emitted?.message, contexts[1]?.messages[1]]) {
      expect(message).toMatchObject({ role: "assistant", stopReason: "length" });
      expect(message).not.toMatchObject({
        content: expect.arrayContaining([expect.objectContaining({ type: "toolCall" })]),
      });
    }
  });
});
