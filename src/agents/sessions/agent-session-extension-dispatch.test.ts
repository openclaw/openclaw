import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { Model } from "../../llm/types.js";
import { createAssistantMessageEventStream } from "../../llm/utils/event-stream.js";
import {
  createAssistant,
  createAssistantResultStream,
  createTestSession,
  registerAgentSessionLoopTestLifecycle,
  streamMocks,
} from "./agent-session-loop-correctness.test-support.js";
import { createResourceLoader } from "./agent-session-loop-resource-loader.test-support.js";

registerAgentSessionLoopTestLifecycle();

function streamAnswer(model: Model, consumed: readonly Promise<void>[] = []) {
  const stream = createAssistantMessageEventStream();
  const message = createAssistant(model, [{ type: "text", text: "abc" }]);
  stream.push({ type: "start", partial: { ...message, content: [] } });
  stream.push({
    type: "text_start",
    contentIndex: 0,
    partial: { ...message, content: [{ type: "text", text: "" }] },
  });
  void (async () => {
    for (const [index, delta] of ["a", "b", "c"].entries()) {
      stream.push({ type: "text_delta", contentIndex: 0, delta });
      await consumed[index];
    }
    stream.push({ type: "done", reason: "stop", message });
    stream.end();
  })();
  return stream;
}

describe("AgentSession extension dispatch", () => {
  it.each(["none", "unrelated"])(
    "delivers updates without extension dispatch when handlers are %s",
    async (mode) => {
      const handlers = new Map<string, Array<(...args: unknown[]) => Promise<unknown>>>();
      if (mode === "unrelated") {
        handlers.set("turn_start", [async () => undefined]);
      }
      streamMocks.streamSimple.mockImplementation((model) => streamAnswer(model));
      const { session } = await createTestSession({
        resourceLoader: createResourceLoader(handlers),
      });
      const dispatch = vi.spyOn(session.extensionRunner, "emit");
      const messageEnd = vi.spyOn(session.extensionRunner, "emitMessageEnd");
      const deltas: string[] = [];
      session.subscribe((event) => {
        if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
          deltas.push(event.assistantMessageEvent.delta);
        }
      });

      await session.prompt("answer");

      expect(deltas.join("")).toBe("abc");
      expect(session.messages.at(-1)).toMatchObject({ content: [{ type: "text", text: "abc" }] });
      const runtimeEvents = dispatch.mock.calls
        .map(([event]) => event.type)
        .filter((type) => type !== "agent_settled");
      expect(runtimeEvents).toEqual(mode === "unrelated" ? ["turn_start"] : []);
      expect(messageEnd).not.toHaveBeenCalled();
    },
  );

  it("keeps tool delivery and turn indices when handlers register after an unobserved turn", async () => {
    const handlers = new Map<string, Array<(...args: unknown[]) => Promise<unknown>>>([
      ["turn_start", []],
    ]);
    let responses = 0;
    streamMocks.streamSimple.mockImplementation((model) =>
      createAssistantResultStream(
        createAssistant(
          model,
          responses++ === 0
            ? [{ type: "toolCall", id: "call-read", name: "read", arguments: {} }]
            : [{ type: "text", text: "done" }],
          responses === 1 ? "toolUse" : "stop",
        ),
      ),
    );
    const { session } = await createTestSession({
      resourceLoader: createResourceLoader(handlers),
      customTools: [
        {
          name: "read",
          label: "Read",
          description: "Read a synthetic value",
          parameters: Type.Object({}),
          execute: async (_id, _args, _signal, onUpdate) => {
            onUpdate?.({ content: [{ type: "text", text: "reading" }], details: {} });
            return { content: [{ type: "text", text: "value" }], details: {} };
          },
        },
      ],
    });
    const tools: string[] = [];
    const turns: Array<[string, number]> = [];
    const recordTurn = async (event: unknown) => {
      const turn = event as { type: string; turnIndex: number };
      turns.push([turn.type, turn.turnIndex]);
    };
    session.subscribe((event) => {
      if (event.type.startsWith("tool_execution_")) {
        tools.push(event.type);
      }
      if (event.type === "turn_end") {
        handlers.set("turn_start", [recordTurn]);
        handlers.set("turn_end", [recordTurn]);
      }
    });

    await session.prompt("read then answer");
    await session.prompt("answer again");

    expect(tools).toEqual(["tool_execution_start", "tool_execution_update", "tool_execution_end"]);
    expect(turns).toEqual([
      ["turn_start", 1],
      ["turn_end", 1],
      ["turn_start", 0],
      ["turn_end", 0],
    ]);
    expect(session.messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "toolResult",
      "assistant",
      "user",
      "assistant",
    ]);
  });

  it("observes live handler registration and awaits handlers inside write settlement", async () => {
    const handlers = new Map<string, Array<(...args: unknown[]) => Promise<unknown>>>([
      ["message_update", []],
    ]);
    let settling = false;
    const observed: string[] = [];
    const consumed = [createDeferred(), createDeferred(), createDeferred()];
    streamMocks.streamSimple.mockImplementation((model) =>
      streamAnswer(
        model,
        consumed.map(({ promise }) => promise),
      ),
    );
    const { session } = await createTestSession({
      resourceLoader: createResourceLoader(handlers),
      withSessionWriteSettlement: async (run) => {
        settling = true;
        try {
          return await run();
        } finally {
          settling = false;
        }
      },
    });
    session.subscribe((event) => {
      if (event.type !== "message_update" || event.assistantMessageEvent.type !== "text_delta") {
        return;
      }
      const delta = event.assistantMessageEvent.delta;
      observed.push(`listener:${delta}:${settling}`);
      if (delta === "a") {
        handlers.set("message_update", [
          async () => {
            await Promise.resolve();
            observed.push(`handler:${settling}`);
            handlers.delete("message_update");
          },
        ]);
      }
      consumed.shift()?.resolve();
    });

    await session.prompt("answer");

    expect(observed).toEqual([
      "listener:a:false",
      "handler:true",
      "listener:b:true",
      "listener:c:false",
    ]);
  });
});
