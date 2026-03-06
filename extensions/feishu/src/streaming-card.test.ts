import { describe, expect, it } from "vitest";
import { mergeStreamingText } from "./streaming-card.js";

describe("mergeStreamingText", () => {
  it("merges suffix/prefix overlaps without duplicating visible text", () => {
    expect(mergeStreamingText("I check", "cked again, and the conclusion is the same.")).toBe(
      "I checked again, and the conclusion is the same.",
    );
  });

  it("replaces ambiguous non-overlapping partials instead of blindly appending", () => {
    expect(
      mergeStreamingText("I checked", "I reviewed it again, and the conclusion is the same."),
    ).toBe("I reviewed it again, and the conclusion is the same.");
  });
});
