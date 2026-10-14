// Coverage for promoting standalone text tool calls into structured events.

import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { describe, expect, it, vi } from "vitest";
import {
  collectStreamEvents,
  createFakeStream,
  type FakeWrappedStream,
} from "./attempt-stream.test-helpers.js";
import { wrapStreamFnPromoteStandaloneTextToolCalls } from "./attempt-tool-call-text-promotion.js";

const requireRecord = createRequireRecord("object", "expected-label");

describe("wrapStreamFnPromoteStandaloneTextToolCalls", () => {
  it("preserves a fenced allowed-tool example in live and terminal output", async () => {
    const parts = ["`", "``json\n", "[re", 'ad]\n{"path":"example.txt"}\n[/read]\n', "```"];
    const rawText = parts.join("");
    const createMessage = () => ({
      role: "assistant",
      content: [{ type: "text", text: rawText }],
      stopReason: "stop",
    });
    const baseFn = vi.fn(() =>
      createFakeStream({
        events: [
          ...parts.map((delta) => ({ type: "text_delta", contentIndex: 0, delta })),
          { type: "text_end", contentIndex: 0, content: rawText },
          { type: "done", reason: "stop", message: createMessage() },
        ],
        resultMessage: createMessage(),
      }),
    );
    const wrapped = wrapStreamFnPromoteStandaloneTextToolCalls(baseFn as never, new Set(["read"]));
    const stream = (await Promise.resolve(
      wrapped({} as never, {} as never, {} as never),
    )) as FakeWrappedStream;

    const events = (await collectStreamEvents(stream)).map((event) =>
      requireRecord(event, "event"),
    );
    const result = requireRecord(await stream.result(), "result message");

    expect(
      events
        .filter((event) => event.type === "text_delta")
        .map((event) => event.delta)
        .join(""),
    ).toBe(rawText);
    expect(events.some((event) => String(event.type).startsWith("toolcall_"))).toBe(false);
    expect(requireRecord(events.at(-1)?.message, "done message").content).toEqual([
      { type: "text", text: rawText },
    ]);
    expect(result.content).toEqual([{ type: "text", text: rawText }]);
  });

  it("reuses promoted ids across cloned result and done messages", async () => {
    const rawToolText = "<function=exec></function>";
    const createMessage = () => ({
      role: "assistant",
      content: [{ type: "text", text: rawToolText }],
      stopReason: "stop",
    });
    const baseFn = vi.fn(() =>
      createFakeStream({
        events: [
          { type: "text_delta", contentIndex: 0, delta: rawToolText },
          { type: "done", reason: "stop", message: createMessage() },
        ],
        resultMessage: createMessage(),
      }),
    );
    const wrapped = wrapStreamFnPromoteStandaloneTextToolCalls(baseFn as never, new Set(["exec"]));
    const stream = (await Promise.resolve(
      wrapped({} as never, {} as never, {} as never),
    )) as FakeWrappedStream;

    const result = requireRecord(await stream.result(), "result message");
    const events = await collectStreamEvents(stream);
    const resultToolCall = requireRecord((result.content as unknown[])[0], "result tool call");
    const done = requireRecord(events.at(-1), "done event");
    const doneMessage = requireRecord(done.message, "done message");
    const doneToolCall = requireRecord((doneMessage.content as unknown[])[0], "done tool call");
    const lifecycle = events
      .map((event) => requireRecord(event, "event"))
      .filter((event) => String(event.type).startsWith("toolcall_"));

    expect(doneToolCall.id).toBe(resultToolCall.id);
    expect(lifecycle).toHaveLength(3);
    for (const event of lifecycle) {
      const partial = requireRecord(event.partial, "tool-call partial");
      expect(requireRecord((partial.content as unknown[])[0], "partial tool call").id).toBe(
        resultToolCall.id,
      );
    }
  });

  it("preserves intervening thinking when promoting multiple text blocks", async () => {
    const firstRawToolText = [
      "[tool:exec]",
      "<parameter=command>",
      "pwd",
      "</parameter>",
      "</function>",
    ].join("\n");
    const secondRawToolText = [
      "[tool:exec]",
      "<parameter=command>",
      "whoami",
      "</parameter>",
      "</function>",
    ].join("\n");
    const resultMessage = {
      role: "assistant",
      content: [
        { type: "text", text: firstRawToolText },
        { type: "thinking", thinking: "Need one more check." },
        { type: "text", text: secondRawToolText },
      ],
      stopReason: "stop",
    };
    const baseFn = vi.fn(() =>
      createFakeStream({
        events: [
          { type: "text_delta", contentIndex: 0, delta: firstRawToolText },
          {
            type: "thinking_delta",
            contentIndex: 1,
            delta: "Need one more check.",
            partial: {
              content: [
                { type: "text", text: firstRawToolText },
                { type: "thinking", thinking: "Need one more check." },
                { type: "text", text: secondRawToolText },
              ],
            },
          },
          { type: "text_delta", contentIndex: 2, delta: secondRawToolText },
          { type: "done", reason: "stop", message: resultMessage },
        ],
        resultMessage,
      }),
    );
    const wrapped = wrapStreamFnPromoteStandaloneTextToolCalls(baseFn as never, new Set(["exec"]));
    const stream = (await Promise.resolve(
      wrapped({} as never, {} as never, {} as never),
    )) as FakeWrappedStream;

    const events = await collectStreamEvents(stream);
    const result = requireRecord(await stream.result(), "result message");

    expect(events.map((event) => requireRecord(event, "event").type)).toEqual([
      "start",
      "toolcall_start",
      "toolcall_delta",
      "toolcall_end",
      "thinking_delta",
      "toolcall_start",
      "toolcall_delta",
      "toolcall_end",
      "done",
    ]);
    expect(requireRecord(events[4], "thinking event").contentIndex).toBe(1);
    expect(requireRecord(events[1], "first toolcall start").contentIndex).toBe(0);
    expect(requireRecord(events[5], "second toolcall start").contentIndex).toBe(2);
    expect((result.content as Array<Record<string, unknown>>).map((block) => block.type)).toEqual([
      "toolCall",
      "thinking",
      "toolCall",
    ]);
    expect(requireRecord((result.content as unknown[])[0], "first tool call")).toMatchObject({
      name: "exec",
      arguments: { command: "pwd" },
    });
    expect(requireRecord((result.content as unknown[])[2], "second tool call")).toMatchObject({
      name: "exec",
      arguments: { command: "whoami" },
    });
  });
});
