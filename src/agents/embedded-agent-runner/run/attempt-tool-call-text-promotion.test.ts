import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { describe, expect, it } from "vitest";
import { collectStreamEvents } from "./attempt-stream.test-helpers.js";
import {
  assistantMessage,
  commandText,
  createPromotionStream,
} from "./attempt-tool-call-text-promotion.test-support.js";

const requireRecord = createRequireRecord("object", "expected-label");

describe("wrapStreamFnPromoteStandaloneTextToolCalls", () => {
  it("preserves a fenced allowed-tool example in live and terminal output", async () => {
    const parts = ["`", "``json\n", "[re", 'ad]\n{"path":"example.txt"}\n[/read]\n', "```"];
    const rawText = parts.join("");
    const createMessage = () => assistantMessage([{ type: "text", text: rawText }]);
    const stream = await createPromotionStream(
      {
        events: [
          ...parts.map((delta) => ({ type: "text_delta", contentIndex: 0, delta })),
          { type: "text_end", contentIndex: 0, content: rawText },
          { type: "done", reason: "stop", message: createMessage() },
        ],
        resultMessage: createMessage(),
      },
      "read",
    );

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
    const createMessage = () => assistantMessage([{ type: "text", text: rawToolText }]);
    const stream = await createPromotionStream({
      events: [
        { type: "text_delta", contentIndex: 0, delta: rawToolText },
        { type: "done", reason: "stop", message: createMessage() },
      ],
      resultMessage: createMessage(),
    });

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
    const firstRawToolText = commandText("pwd");
    const secondRawToolText = commandText("whoami");
    const resultMessage = assistantMessage([
      { type: "text", text: firstRawToolText },
      { type: "thinking", thinking: "Need one more check." },
      { type: "text", text: secondRawToolText },
    ]);
    const stream = await createPromotionStream({
      events: [
        { type: "text_delta", contentIndex: 0, delta: firstRawToolText },
        {
          type: "thinking_delta",
          contentIndex: 1,
          delta: "Need one more check.",
          partial: { content: structuredClone(resultMessage.content) },
        },
        { type: "text_delta", contentIndex: 2, delta: secondRawToolText },
        { type: "done", reason: "stop", message: resultMessage },
      ],
      resultMessage,
    });

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
    expect(result.content).toEqual([
      expect.objectContaining({ type: "toolCall", name: "exec", arguments: { command: "pwd" } }),
      expect.objectContaining({ type: "thinking" }),
      expect.objectContaining({ type: "toolCall", name: "exec", arguments: { command: "whoami" } }),
    ]);
  });
});
