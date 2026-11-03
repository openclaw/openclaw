import { describe, expect, it } from "vitest";
import { collect } from "../../../../test/helpers/async-iterable.js";
import type { AssistantMessageEvent } from "../types.js";
import { assistantStream } from "./stream.test-support.js";

function fixture() {
  const { message, stream } = assistantStream([{ type: "text", text: "Hello world" }]);
  const append = (delta: string) => {
    const event = { type: "text_delta", contentIndex: 0, delta } as const;
    stream.push(event);
    return event;
  };
  return { message, stream, append };
}

describe("queued assistant text appends", () => {
  it("coalesces unread text without mutation and freezes it at each terminal state", async () => {
    for (const terminal of ["done", "end", "error"] as const) {
      const { message, stream, append } = fixture();
      const result = terminal === "error" ? { ...message, stopReason: "error" as const } : message;
      const start = { type: "start", partial: message } as const;
      stream.push(start);
      const first = append("Hello");
      append(" ");
      append("world");
      const last: AssistantMessageEvent[] =
        terminal === "end"
          ? []
          : terminal === "done"
            ? [{ type: "done", reason: "stop", message }]
            : [{ type: "error", reason: "error", error: result }];
      last.forEach((event) => stream.push(event));
      if (terminal === "end") {
        stream.end(result);
      }
      append("discarded");
      if (terminal === "error") {
        stream.end();
      }
      expect(await collect(stream)).toEqual([
        start,
        { type: "text_delta", contentIndex: 0, delta: "Hello world" },
        ...last,
      ]);
      expect(first.delta).toBe("Hello");
      await expect(stream.result()).resolves.toBe(result);
    }
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
      expected.push({ type: "text_delta", contentIndex: 0, delta: "ab" }, boundary);
    }
    append("c");
    append("d");
    stream.end(message);
    expect(await collect(stream)).toEqual([
      ...expected,
      { type: "text_delta", contentIndex: 0, delta: "cd" },
    ]);
  });
});
