import { describe, expect, it } from "vitest";
import { isMessagingToolDuplicate, normalizeTextForComparison } from "./messaging-dedupe.js";

describe("normalizeTextForComparison", () => {
  it.each([
    { emoji: "❤️", label: "an emoji presentation selector" },
    { emoji: "👨‍👩‍👧‍👦", label: "zero-width joiners in a family emoji" },
    { emoji: "❤️‍🔥", label: "combined presentation selectors and joiners" },
  ])("removes $label", ({ emoji }) => {
    expect(normalizeTextForComparison(`Please ${emoji} confirm delivery.`)).toBe(
      "please confirm delivery.",
    );
  });
});

describe("isMessagingToolDuplicate", () => {
  it.each([
    {
      input: "Please ❤️ confirm delivery.",
      sentText: "Please confirm delivery.",
    },
    {
      input: "Please confirm delivery.",
      sentText: "Please 👨‍👩‍👧‍👦 confirm delivery.",
    },
  ])("suppresses replies that differ only by compound emoji", ({ input, sentText }) => {
    expect(isMessagingToolDuplicate(input, [sentText])).toBe(true);
  });
});
