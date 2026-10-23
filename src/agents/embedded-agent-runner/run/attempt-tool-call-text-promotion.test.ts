import { expect, it } from "vitest";
import {
  assistantMessage,
  collectPromotionEvents,
  messageContent,
  record,
  commandText,
  createPromotionStream,
} from "./attempt-tool-call-text-promotion.test-support.js";

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

  const events = await collectPromotionEvents(stream);
  const result = record(await stream.result(), "result message");

  expect(
    events
      .filter((event) => event.type === "text_delta")
      .map((event) => event.delta)
      .join(""),
  ).toBe(rawText);
  expect(events.some((event) => String(event.type).startsWith("toolcall_"))).toBe(false);
  expect(record(events.at(-1)?.message, "done message").content).toEqual([
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

  const result = record(await stream.result(), "result message");
  const events = await collectPromotionEvents(stream);
  const resultToolCall = record(messageContent(result)[0], "result tool call");
  const lifecycle = events.filter((event) => String(event.type).startsWith("toolcall_"));
  const doneToolCall = record(messageContent(events.at(-1)?.message)[0], "done tool call");
  expect(doneToolCall.id).toBe(resultToolCall.id);
  expect(lifecycle).toHaveLength(3);
  for (const event of lifecycle) {
    expect(record(messageContent(event.partial)[0], "partial tool call").id).toBe(
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

  const events = await collectPromotionEvents(stream);
  const result = record(await stream.result(), "result message");

  expect(events.map((event) => event.type)).toEqual([
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
  expect(
    [events[1], events[4], events[5]].map((event) => record(event, "indexed event").contentIndex),
  ).toEqual([0, 1, 2]);
  expect(result.content).toEqual([
    expect.objectContaining({ type: "toolCall", name: "exec", arguments: { command: "pwd" } }),
    expect.objectContaining({ type: "thinking" }),
    expect.objectContaining({ type: "toolCall", name: "exec", arguments: { command: "whoami" } }),
  ]);
});
