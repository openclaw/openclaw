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

  describe("finalText option (issue #49104)", () => {
    it("preserves literal <think> mention in final answer text", () => {
      expect(
        splitTelegramReasoningText("use the <think> tag for reasoning", { finalText: true }),
      ).toEqual({
        answerText: "use the <think> tag for reasoning",
      });
    });

    it("strips closed reasoning block and preserves literal mention in final text", () => {
      expect(
        splitTelegramReasoningText("<think>reasoning</think>Answer mentions <think> tag.", {
          finalText: true,
        }),
      ).toEqual({
        reasoningText: "Reasoning:\n_reasoning_",
        answerText: "Answer mentions <think> tag.",
      });
    });

    it("still treats <think> at start as reasoning in final text", () => {
      const result = splitTelegramReasoningText("<think>partial reasoning", { finalText: true });
      expect(result.reasoningText).toContain("partial reasoning");
      expect(result.answerText).toBeUndefined();
    });

    it("truncates literal mention without finalText (backward compat)", () => {
      const result = splitTelegramReasoningText("use the <think> tag for reasoning");
      expect(result.answerText).toBe("use the");
    });
  });
});
