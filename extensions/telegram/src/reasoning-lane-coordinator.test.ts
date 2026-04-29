import { describe, expect, it } from "vitest";
import { splitTelegramReasoningText } from "./reasoning-lane-coordinator.js";

describe("splitTelegramReasoningText", () => {
  it("splits real tagged reasoning and answer", () => {
    expect(splitTelegramReasoningText("<think>example</think>Done")).toEqual({
      reasoningText: "Reasoning:\n_example_",
      answerText: "Done",
    });
  });

  it("ignores literal think tags inside inline code", () => {
    const text = "Use `<think>example</think>` literally.";
    expect(splitTelegramReasoningText(text)).toEqual({
      answerText: text,
    });
  });

  it("ignores literal think tags inside fenced code", () => {
    const text = "```xml\n<think>example</think>\n```";
    expect(splitTelegramReasoningText(text)).toEqual({
      answerText: text,
    });
  });

  it("does not emit partial reasoning tag prefixes", () => {
    expect(splitTelegramReasoningText("  <thi")).toEqual({});
  });

  it("does not emit answer text while a closing tag is still arriving character by character", () => {
    // Without the `strippedAnswer !== text` guard, the raw tag text would leak into the answer lane.
    const result = splitTelegramReasoningText("<think>reasoning</think");
    expect(result.answerText).toBeUndefined();
  });

  it("emits both reasoning and answer text once the closing tag is complete", () => {
    expect(splitTelegramReasoningText("<think>reasoning</think>Answer")).toEqual({
      reasoningText: "Reasoning:\n_reasoning_",
      answerText: "Answer",
    });
  });
});
