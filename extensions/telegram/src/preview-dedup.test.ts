import { describe, expect, it } from "vitest";
import {
  buildPreviewDedupeTextSet,
  isPreviewStreamedText,
  normalizePreviewDedupeText,
} from "./preview-dedup.js";

describe("normalizePreviewDedupeText", () => {
  it("returns empty string for undefined or whitespace-only input", () => {
    expect(normalizePreviewDedupeText(undefined)).toBe("");
    expect(normalizePreviewDedupeText("")).toBe("");
    expect(normalizePreviewDedupeText("   \n\t  ")).toBe("");
  });

  it("collapses any whitespace run to a single space and trims edges", () => {
    expect(normalizePreviewDedupeText("  hi   there  ")).toBe("hi there");
    expect(normalizePreviewDedupeText("a\nb\tc")).toBe("a b c");
    expect(normalizePreviewDedupeText("multi\n\nblock")).toBe("multi block");
  });
});

describe("buildPreviewDedupeTextSet", () => {
  it("returns an empty set when the input is empty", () => {
    expect(buildPreviewDedupeTextSet(undefined).size).toBe(0);
    expect(buildPreviewDedupeTextSet("").size).toBe(0);
    expect(buildPreviewDedupeTextSet("   ").size).toBe(0);
  });

  it("contains the normalized whole text and each paragraph block", () => {
    const set = buildPreviewDedupeTextSet("First block\n\nSecond block");
    expect(set.has("First block Second block")).toBe(true);
    expect(set.has("First block")).toBe(true);
    expect(set.has("Second block")).toBe(true);
  });

  it("treats three or more newlines as a single block boundary", () => {
    const set = buildPreviewDedupeTextSet("A\n\n\n\nB");
    expect(set.has("A")).toBe(true);
    expect(set.has("B")).toBe(true);
  });

  it("does not split on a single newline (those stay inside one block)", () => {
    const set = buildPreviewDedupeTextSet("line1\nline2");
    expect(set.has("line1 line2")).toBe(true);
    expect(set.has("line1")).toBe(false);
    expect(set.has("line2")).toBe(false);
  });
});

describe("isPreviewStreamedText", () => {
  it("returns false when the preview dedupe set is empty", () => {
    expect(isPreviewStreamedText("anything", new Set())).toBe(false);
  });

  it("returns false for empty/undefined candidate", () => {
    const set = buildPreviewDedupeTextSet("First block\n\nSecond block");
    expect(isPreviewStreamedText(undefined, set)).toBe(false);
    expect(isPreviewStreamedText("", set)).toBe(false);
    expect(isPreviewStreamedText("   ", set)).toBe(false);
  });

  it("matches an individual block from a multi-block preview", () => {
    const set = buildPreviewDedupeTextSet("First block\n\nSecond block");
    expect(isPreviewStreamedText("First block", set)).toBe(true);
    expect(isPreviewStreamedText("Second block", set)).toBe(true);
  });

  it("matches whole-preview text", () => {
    const set = buildPreviewDedupeTextSet("First block\n\nSecond block");
    expect(isPreviewStreamedText("First block Second block", set)).toBe(true);
  });

  it("ignores incidental whitespace differences", () => {
    const set = buildPreviewDedupeTextSet("Hello   world");
    expect(isPreviewStreamedText("Hello world", set)).toBe(true);
    expect(isPreviewStreamedText("  Hello world  ", set)).toBe(true);
    expect(isPreviewStreamedText("Hello\nworld", set)).toBe(true);
  });

  it("does not suppress unrelated short text just because it appears inside preview", () => {
    const set = buildPreviewDedupeTextSet("Working on item 3");
    expect(isPreviewStreamedText("3", set)).toBe(false);
    expect(isPreviewStreamedText("item", set)).toBe(false);
    expect(isPreviewStreamedText("Working", set)).toBe(false);
  });

  it("returns false for a final that differs from any preview block", () => {
    const set = buildPreviewDedupeTextSet("Working...");
    expect(isPreviewStreamedText("Done.", set)).toBe(false);
  });
});
