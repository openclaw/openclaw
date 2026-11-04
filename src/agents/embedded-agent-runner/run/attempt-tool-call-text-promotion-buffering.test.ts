import { expect, it, vi } from "vitest";
import {
  assistantMessage,
  collectPromotionEvents,
  record,
  commandText,
  createPromotionStream,
  wrapPromotionStream,
} from "./attempt-tool-call-text-promotion.test-support.js";

it.each([0, 1])("buffers tool text around thinking at content index %s", async (thinkingIndex) => {
  const rawToolText = commandText("pwd");
  const thinking = { type: "thinking", thinking: "Need shell state." };
  const text = { type: "text", text: rawToolText };
  const resultMessage = assistantMessage(thinkingIndex === 0 ? [thinking, text] : [text, thinking]);
  const stream = await createPromotionStream({
    events: [
      { type: "text_delta", contentIndex: 1 - thinkingIndex, delta: rawToolText },
      {
        type: "thinking_delta",
        contentIndex: thinkingIndex,
        delta: thinking.thinking,
        partial: { content: structuredClone(resultMessage.content) },
      },
      { type: "done", reason: "stop", message: resultMessage },
    ],
    resultMessage,
  });
  const events = await collectPromotionEvents(stream);
  const toolEvents = ["toolcall_start", "toolcall_delta", "toolcall_end"];
  expect(events.map((event) => event.type)).toEqual([
    "start",
    ...(thinkingIndex === 0
      ? ["thinking_delta", ...toolEvents]
      : [...toolEvents, "thinking_delta"]),
    "done",
  ]);
  const thinkingEvent = record(events[thinkingIndex === 0 ? 1 : 4], "thinking event");
  expect(thinkingEvent.contentIndex).toBe(thinkingIndex);
  const promoted = expect.objectContaining({
    type: "toolCall",
    name: "exec",
    arguments: { command: "pwd" },
  });
  expect(record(thinkingEvent.partial, "thinking partial").content).toEqual(
    thinkingIndex === 0 ? [thinking, promoted] : [promoted, thinking],
  );
  expect(JSON.stringify(events)).not.toContain(rawToolText);
});

it("closes the underlying stream iterator when consumers stop early", async () => {
  const returnIterator = vi.fn(async () => ({ done: true, value: undefined }));
  const nextIterator = vi
    .fn()
    .mockResolvedValueOnce({ done: false, value: { type: "start", partial: { content: [] } } })
    .mockResolvedValue({ done: true, value: undefined });
  const baseFn = vi.fn(() => ({
    async result() {
      return { role: "assistant", content: [], stopReason: "stop" };
    },
    [Symbol.asyncIterator]() {
      return {
        next: nextIterator,
        return: returnIterator,
      };
    },
  }));
  const stream = await wrapPromotionStream(baseFn);
  const iterator = stream[Symbol.asyncIterator]();

  expect(await iterator.next()).toEqual({
    done: false,
    value: { type: "start", partial: { content: [] } },
  });
  await iterator.return?.();

  expect(returnIterator).toHaveBeenCalledTimes(1);
});

it("fails closed on buffered known-tool text before terminal errors", async () => {
  const rawToolText = "[tool:exec]";
  const errorEvent = { type: "error", error: new Error("stream failed") };
  const stream = await createPromotionStream({
    events: [{ type: "text_delta", contentIndex: 0, delta: rawToolText }, errorEvent],
    resultMessage: { role: "assistant", content: [], stopReason: "stop" },
  });

  expect(await collectPromotionEvents(stream)).toEqual([errorEvent]);
});
