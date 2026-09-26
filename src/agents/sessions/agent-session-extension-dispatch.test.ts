import { describe, expect, it, vi } from "vitest";
import type { Model } from "../../llm/types.js";
import { createAssistantMessageEventStream } from "../../llm/utils/event-stream.js";
import {
  createAssistant,
  createTestSession,
  registerAgentSessionLoopTestLifecycle,
  streamMocks,
} from "./agent-session-loop-correctness.test-support.js";
import { createResourceLoader } from "./agent-session-loop-resource-loader.test-support.js";

registerAgentSessionLoopTestLifecycle();

function streamAnswer(model: Model) {
  const stream = createAssistantMessageEventStream();
  const message = createAssistant(model, [{ type: "text", text: "abc" }]);
  stream.push({ type: "start", partial: { ...message, content: [] } });
  stream.push({
    type: "text_start",
    contentIndex: 0,
    partial: { ...message, content: [{ type: "text", text: "" }] },
  });
  for (const delta of "abc") {
    stream.push({ type: "text_delta", contentIndex: 0, delta });
  }
  stream.push({ type: "done", reason: "stop", message });
  stream.end();
  return stream;
}

describe("AgentSession text extension dispatch", () => {
  it.each(["none", "unrelated", "empty"])(
    "delivers updates without extension dispatch when handlers are %s",
    async (mode) => {
      const handlers = new Map<string, Array<(...args: unknown[]) => Promise<unknown>>>();
      if (mode === "unrelated") {
        handlers.set("turn_start", [async () => undefined]);
      } else if (mode === "empty") {
        handlers.set("message_update", []);
      }
      streamMocks.streamSimple.mockImplementation(streamAnswer);
      const { session } = await createTestSession({
        resourceLoader: createResourceLoader(handlers),
      });
      const dispatch = vi.spyOn(session.extensionRunner, "emit");
      const deltas: string[] = [];
      session.subscribe((event) => {
        if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
          deltas.push(event.assistantMessageEvent.delta);
        }
      });

      await session.prompt("answer");

      expect(deltas).toEqual(["a", "b", "c"]);
      expect(session.messages.at(-1)).toMatchObject({ content: [{ type: "text", text: "abc" }] });
      expect(dispatch.mock.calls.filter(([event]) => event.type === "message_update")).toEqual([]);
    },
  );

  it("observes live handler registration and awaits handlers inside write settlement", async () => {
    const handlers = new Map<string, Array<(...args: unknown[]) => Promise<unknown>>>([
      ["message_update", []],
    ]);
    let settling = false;
    const observed: string[] = [];
    streamMocks.streamSimple.mockImplementation(streamAnswer);
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
