import { describe, expect, it } from "vitest";
import type { StreamEvent } from "./mock-openai-contracts.js";
import {
  buildAssistantEvents,
  buildAssistantThenToolCallEvents,
  buildFailedResponseEvents,
  buildReasoningAndAssistantEvents,
  buildReasoningOnlyEvents,
} from "./mock-openai-events.js";

function readOutputItemSlots(events: StreamEvent[]) {
  return events
    .filter(
      (event) =>
        event.type === "response.output_item.added" || event.type === "response.output_item.done",
    )
    .map((event) => [event.type, event.item.id, event.output_index]);
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
    expect(events.some((event) => event.type === "response.output_text.delta")).toBe(false);
  });

  it("keeps each streamed assistant on its own indexed slot", () => {
    const events = buildAssistantEvents([
      {
        id: "first-answer",
        streamDeltas: ["first"],
        text: "first",
      },
      {
        id: "second-answer",
        streamDeltas: ["second"],
        text: "second",
      },
    ]);

    expect(readOutputItemSlots(events)).toEqual([
      ["response.output_item.added", "first-answer", 0],
      ["response.output_item.done", "first-answer", 0],
      ["response.output_item.added", "second-answer", 1],
      ["response.output_item.done", "second-answer", 1],
    ]);
    expect(
      events
        .filter((event) => event.type === "response.output_text.delta")
        .map((event) => {
          if (event.type !== "response.output_text.delta") {
            throw new Error("expected a response text delta");
          }
          return {
            itemId: event.item_id,
            outputIndex: event.output_index,
          };
        }),
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

    expect(readOutputItemSlots(events)).toEqual([
      ["response.output_item.added", "assistant-before-tool", 0],
      ["response.output_item.done", "assistant-before-tool", 0],
      ["response.output_item.added", expect.any(String), 1],
      ["response.output_item.done", expect.any(String), 1],
    ]);
    expect(events.find((event) => event.type === "response.function_call_arguments.delta")).toEqual(
      {
        type: "response.function_call_arguments.delta",
        item_id: expect.any(String),
        output_index: 1,
        delta: JSON.stringify({ path: "README.md" }),
      },
    );
    expect(
      events
        .filter(
          (event) =>
            event.type === "response.output_item.added" ||
            event.type === "response.output_item.done",
        )
        .map((event) => event.item)
        .filter((item) => item.type === "message"),
    ).toEqual([
      expect.objectContaining({ id: "assistant-before-tool", phase: "commentary" }),
      expect.objectContaining({ id: "assistant-before-tool", phase: "commentary" }),
    ]);
    const completed = events.find((event) => event.type === "response.completed");
    expect(completed?.response.output[0]).toEqual(
      expect.objectContaining({ id: "assistant-before-tool", phase: "commentary" }),
    );
  });

  it("indexes reasoning before the streamed assistant answer", () => {
    const events = buildReasoningAndAssistantEvents({
      reasoningId: "reasoning-before-answer",
      answerId: "reasoned-answer",
      answerText: "reasoned final",
    });

    expect(readOutputItemSlots(events)).toEqual([
      ["response.output_item.added", "reasoning-before-answer", 0],
      ["response.output_item.done", "reasoning-before-answer", 0],
      ["response.output_item.added", "reasoned-answer", 1],
      ["response.output_item.done", "reasoned-answer", 1],
    ]);
  });

  it("indexes a reasoning-only output on its first slot", () => {
    expect(readOutputItemSlots(buildReasoningOnlyEvents("thinking", "reasoning-only"))).toEqual([
      ["response.output_item.added", "reasoning-only", 0],
      ["response.output_item.done", "reasoning-only", 0],
    ]);
  });
});
