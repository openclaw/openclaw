import { describe, expect, it } from "vitest";
import {
  buildAssistantEvents,
  buildFailedResponseEvents,
  buildReasoningAndAssistantEvents,
  buildReasoningOnlyEvents,
} from "./mock-openai-events.js";
import { expectSlots } from "./server.fixtures.test-support.js";

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

  it("indexes a reasoning-only output on its first slot", () => {
    expectSlots(buildReasoningOnlyEvents("thinking", "reasoning-only"), ["reasoning-only"]);
  });

  it("preserves an explicit answer ID after the reasoning slot", () => {
    expectSlots(
      buildReasoningAndAssistantEvents({
        reasoningId: "reasoning-before-answer",
        answerId: "reasoned-answer",
        answerText: "reasoned final",
      }),
      ["reasoning-before-answer", "reasoned-answer"],
    );
  });
});
