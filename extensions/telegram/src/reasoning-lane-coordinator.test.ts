import { describe, expect, it } from "vitest";
import {
  splitTelegramReasoningText,
  stripReasoningTagsForInterleaved,
} from "./reasoning-lane-coordinator.js";

describe("stripReasoningTagsForInterleaved", () => {
  it("unwraps think tags, keeping the inner content as plain text", () => {
    expect(stripReasoningTagsForInterleaved("<think>planning</think>Done")).toBe("planningDone");
  });

  it("keeps content from multiple/closing tag variants without leaving raw tags", () => {
    const out = stripReasoningTagsForInterleaved("<thinking>a</thinking> b <thought>c</thought>");
    expect(out).toBe("a b c");
    expect(out).not.toMatch(/<\/?(?:think|thinking|thought)/u);
  });

  it("is a no-op for tag-free text (interactive backend thinking_delta)", () => {
    expect(stripReasoningTagsForInterleaved("clean reasoning text")).toBe("clean reasoning text");
  });

  it("preserves literal tags inside inline code (they are content, not markers)", () => {
    const text = "Use `<think>x</think>` literally.";
    expect(stripReasoningTagsForInterleaved(text)).toBe(text);
  });
});

describe("splitTelegramReasoningText", () => {
  it("splits real tagged reasoning and answer", () => {
    expect(splitTelegramReasoningText("<think>example</think>Done")).toEqual({
      reasoningText: "Thinking\n\n_example_",
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
    expect(splitTelegramReasoningText("  <thi")).toStrictEqual({});
  });

  it("keeps visible Thinking-prefixed answers in the answer lane", () => {
    const text = "Thinking...\nI'll check that now";
    expect(splitTelegramReasoningText(text)).toEqual({
      answerText: text,
    });
  });
});
