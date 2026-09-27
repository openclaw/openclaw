import { describe, expect, it } from "vitest";
import type { AssistantMessage, AssistantMessageEvent } from "../types.js";
import { AssistantMessageEventStream } from "./event-stream.js";

function fixture() {
  const message: AssistantMessage = {
    role: "assistant",
    content: [{ type: "text", text: "Hello world" }],
    api: "openai-responses",
    provider: "synthetic",
    model: "text-fixture",
    stopReason: "stop",
    timestamp: 1,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
  const stream = new AssistantMessageEventStream();
  const append = (delta: string, contentIndex = 0) => {
    const event = { type: "text_delta", contentIndex, delta } as const;
    stream.push(event);
    return event;
  };
  return { message, stream, append };
}

async function collect(stream: AssistantMessageEventStream) {
  const events: AssistantMessageEvent[] = [];
  for await (const event of stream) {
    events.push(event);
  }
  return events;
}

describe("queued assistant text appends", () => {
  it("combines unread appends without changing producer-owned events or text bytes", async () => {
    const { message, stream, append } = fixture();
    stream.push({ type: "start", partial: message });
    const first = append("Hello");
    append(" ");
    append("world");
    stream.push({ type: "done", reason: "stop", message });
    expect(await collect(stream)).toEqual([
      { type: "start", partial: message },
      { type: "text_delta", contentIndex: 0, delta: "Hello world" },
      { type: "done", reason: "stop", message },
    ]);
    expect(first.delta).toBe("Hello");
    await expect(stream.result()).resolves.toBe(message);
  });

  it("delivers a waiting first token immediately and never rewrites consumed events", async () => {
    const { message, stream, append } = fixture();
    const iterator = stream[Symbol.asyncIterator]();
    const waiting = iterator.next();
    append("Hello");
    const first = await waiting;
    append(" ");
    append("world");
    const second = await iterator.next();
    expect(first.value).toEqual({ type: "text_delta", contentIndex: 0, delta: "Hello" });
    expect(second.value).toEqual({ type: "text_delta", contentIndex: 0, delta: " world" });
    append("!");
    stream.end(message);
    expect(await iterator.next()).toEqual({
      value: { type: "text_delta", contentIndex: 0, delta: "!" },
      done: false,
    });
    expect(await iterator.next()).toEqual({ value: undefined, done: true });
  });

  it("preserves snapshot replacements, content indices, and reasoning/tool boundaries", async () => {
    const { message, stream, append } = fixture();
    const boundaries: AssistantMessageEvent[] = [
      { type: "text_delta", contentIndex: 0, delta: "", partial: message },
      { type: "text_delta", contentIndex: 1, delta: "other block" },
      { type: "text_start", contentIndex: 0, partial: message },
      { type: "text_end", contentIndex: 0, content: "replacement", partial: message },
      { type: "thinking_delta", contentIndex: 1, delta: "reasoning", partial: message },
      { type: "toolcall_delta", contentIndex: 2, delta: "{}", partial: message },
      { type: "start", partial: message },
    ];
    const expected: AssistantMessageEvent[] = [];
    for (const boundary of boundaries) {
      append("a");
      append("b");
      stream.push(boundary);
      append("c");
      append("d");
      const end: AssistantMessageEvent = {
        type: "text_end",
        contentIndex: 0,
        content: "abcd",
        partial: message,
      };
      stream.push(end);
      expected.push(
        { type: "text_delta", contentIndex: 0, delta: "ab" },
        boundary,
        { type: "text_delta", contentIndex: 0, delta: "cd" },
        end,
      );
    }
    stream.end(message);
    expect(await collect(stream)).toEqual(expected);
  });

  it("freezes unread text when the producer ends with an explicit result", async () => {
    const { message, stream, append } = fixture();
    append("Hello");
    append(" world");
    stream.end(message);
    append("discarded");
    expect(await collect(stream)).toEqual([
      { type: "text_delta", contentIndex: 0, delta: "Hello world" },
    ]);
    await expect(stream.result()).resolves.toBe(message);
  });

  it.each(["error", "aborted"] as const)(
    "drains prior text before %s and rejects later pushes",
    async (reason) => {
      const { message, stream, append } = fixture();
      append("Hello");
      append(" world");
      const error: AssistantMessage = { ...message, stopReason: reason };
      stream.push({ type: "error", reason, error });
      append("discarded");
      stream.end();
      expect(await collect(stream)).toEqual([
        { type: "text_delta", contentIndex: 0, delta: "Hello world" },
        { type: "error", reason, error },
      ]);
      await expect(stream.result()).resolves.toBe(error);
    },
  );
});
