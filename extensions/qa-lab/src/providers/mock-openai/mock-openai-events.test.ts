import { describe, expect, it } from "vitest";
import type { StreamEvent } from "./mock-openai-contracts.js";
import {
  buildAssistantEvents,
  buildAssistantThenToolCallEvents,
  buildFailedResponseEvents,
  buildReasoningAndAssistantEvents,
  buildReasoningOnlyEvents,
} from "./mock-openai-events.js";

function outputItems(events: StreamEvent[]) {
  return events.filter(
    (event) =>
      event.type === "response.output_item.added" || event.type === "response.output_item.done",
  );
}

function expectSlots(events: StreamEvent[], ids: unknown[]) {
  expect(
    outputItems(events).map((event) => [event.type, event.item.id, event.output_index]),
  ).toEqual(
    ids.flatMap((id, index) => [
      ["response.output_item.added", id, index],
      ["response.output_item.done", id, index],
    ]),
  );
}

describe("mock OpenAI Responses output item slots", () => {
  it("emits the provider no-details failure used by repeated-request recovery QA", () => {
    const events = buildFailedResponseEvents();
    expect(events).toEqual([
      expect.objectContaining({ type: "response.created" }),
      expect.objectContaining({
        type: "response.failed",
        response: expect.not.objectContaining({ error: expect.anything() }),
      }),
    ]);
  });

  it("keeps each streamed assistant on its own indexed slot", () => {
    const events = buildAssistantEvents(
      ["first", "second"].map((text) => ({ id: `${text}-answer`, streamDeltas: [text], text })),
    );
    expectSlots(events, ["first-answer", "second-answer"]);
    expect(
      events
        .filter((event) => event.type === "response.output_text.delta")
        .map((event) => ({ itemId: event.item_id, outputIndex: event.output_index })),
    ).toEqual([
      { itemId: "first-answer", outputIndex: 0 },
      { itemId: "second-answer", outputIndex: 1 },
    ]);
  });

  it("assigns separate assistant and function-call slots", () => {
    const events = buildAssistantThenToolCallEvents(
      {
        id: "assistant-before-tool",
        phase: "commentary",
        streamDeltas: ["looking up"],
        text: "looking up",
      },
      "read",
      { path: "README.md" },
    );

    expectSlots(events, ["assistant-before-tool", expect.any(String)]);
    expect(events.find((event) => event.type === "response.function_call_arguments.delta")).toEqual(
      {
        type: "response.function_call_arguments.delta",
        item_id: expect.any(String),
        output_index: 1,
        delta: JSON.stringify({ path: "README.md" }),
      },
    );
    const assistant = expect.objectContaining({ id: "assistant-before-tool", phase: "commentary" });
    expect(
      outputItems(events)
        .map((event) => event.item)
        .filter((item) => item.type === "message"),
    ).toEqual([assistant, assistant]);
    const completed = events.find((event) => event.type === "response.completed");
    expect(completed?.response.output[0]).toEqual(assistant);
  });

  it("indexes reasoning before the streamed assistant answer", () => {
    const events = buildReasoningAndAssistantEvents({
      reasoningId: "reasoning-before-answer",
      answerId: "reasoned-answer",
      answerText: "reasoned final",
    });

    expectSlots(events, ["reasoning-before-answer", "reasoned-answer"]);
  });

  it("indexes a reasoning-only output on its first slot", () => {
    expectSlots(buildReasoningOnlyEvents("thinking", "reasoning-only"), ["reasoning-only"]);
  });
});
