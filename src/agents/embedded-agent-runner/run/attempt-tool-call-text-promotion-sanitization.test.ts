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
  it("buffers split XML function markers until final promotion", async () => {
    const rawToolText = commandText("pwd", "<function=exec>");
    const resultMessage = assistantMessage([{ type: "text", text: rawToolText }]);
    const stream = await createPromotionStream({
      events: [
        { type: "text_delta", contentIndex: 0, delta: "<" },
        { type: "text_delta", contentIndex: 0, delta: rawToolText.slice(1) },
        { type: "done", reason: "stop", message: resultMessage },
      ],
      resultMessage,
    });

    const events = await collectStreamEvents(stream);

    expect(events.map((event) => requireRecord(event, "event").type)).toEqual([
      "start",
      "toolcall_start",
      "toolcall_delta",
      "toolcall_end",
      "done",
    ]);
  });

  it("suppresses zero-argument XML text over the byte cap instead of flushing it", async () => {
    const marker = "<function=exec>";
    const rawToolText = `${marker}${"\u00a0".repeat(128_001)}</function>`;
    const resultMessage = assistantMessage([{ type: "text", text: rawToolText }]);
    const stream = await createPromotionStream({
      events: [
        { type: "start", partial: { content: [] } },
        {
          type: "text_start",
          contentIndex: 0,
          partial: { content: [{ type: "text", text: "" }] },
        },
        { type: "text_delta", contentIndex: 0, delta: rawToolText },
        {
          type: "thinking_delta",
          contentIndex: 1,
          delta: "still thinking",
          partial: {
            content: [
              { type: "text", text: rawToolText },
              { type: "thinking", thinking: "still thinking" },
            ],
          },
        },
        { type: "text_end", contentIndex: 0, content: rawToolText },
        { type: "done", reason: "stop", message: resultMessage },
      ],
      resultMessage,
    });

    const events = await collectStreamEvents(stream);
    const result = requireRecord(await stream.result(), "result message");

    expect(events.map((event) => requireRecord(event, "event").type)).toEqual([
      "start",
      "thinking_delta",
      "done",
    ]);
    const thinkingEvent = requireRecord(events[1], "thinking event");
    expect(requireRecord(thinkingEvent.partial, "thinking partial").content).toEqual([
      { type: "text", text: "" },
      { type: "thinking", thinking: "still thinking" },
    ]);
    const doneEvent = requireRecord(events[2], "done event");
    expect(doneEvent.reason).toBe("stop");
    expect(doneEvent.message).toMatchObject({
      role: "assistant",
      content: [],
      stopReason: "stop",
    });
    expect(result).toMatchObject({ role: "assistant", content: [], stopReason: "stop" });
    expect(JSON.stringify(events)).not.toContain(marker);
    expect(JSON.stringify(result)).not.toContain(marker);
  });

  it("scrubs an incomplete named call from stream.result()", async () => {
    const rawToolText = "<function=exec><parameter=command>SECRET";
    const resultMessage = assistantMessage([{ type: "text", text: rawToolText }]);
    const stream = await createPromotionStream({ events: [], resultMessage });

    const result = requireRecord(await stream.result(), "result message");

    expect(result).toEqual({ role: "assistant", content: [], stopReason: "stop" });
  });

  it("scrubs mixed under-cap calls from pre-iteration results and multi-block done events", async () => {
    const rawCall = "<function=exec></function>";
    const visibleText = "Visible answer after the leaked call.";
    const rawText = `${rawCall}\n${visibleText}`;
    const createMessage = () =>
      assistantMessage([
        { type: "text", text: rawCall },
        { type: "text", text: visibleText },
      ]);
    const stream = await createPromotionStream({
      events: [
        { type: "text_delta", contentIndex: 0, delta: rawText },
        { type: "done", reason: "stop", message: createMessage() },
      ],
      resultMessage: createMessage(),
    });

    const result = requireRecord(await stream.result(), "result message");
    const events = await collectStreamEvents(stream);
    const expectedContent = [{ type: "text", text: visibleText }];

    expect(result.content).toEqual(expectedContent);
    expect(events.map((event) => requireRecord(event, "event").type)).toEqual([
      "text_delta",
      "done",
    ]);
    expect(requireRecord(events[0], "text event").delta).toBe(visibleText);
    expect(
      requireRecord(requireRecord(events[1], "done event").message, "done message").content,
    ).toEqual(expectedContent);
    expect(JSON.stringify({ events, result })).not.toContain("<function=exec>");
  });
});
