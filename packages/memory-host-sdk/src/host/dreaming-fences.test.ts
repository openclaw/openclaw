import { describe, expect, it } from "vitest";
import {
  blankDreamingFencedRanges,
  isDreamingFenceMarkerLine,
  lineRangeOverlapsDreamingFence,
} from "./dreaming-fences.js";

const NOTE_LINES = [
  "Real memory line.",
  "<!-- openclaw:dreaming:light:start -->",
  "Dream scratch one.",
  "Dream scratch two.",
  "<!-- openclaw:dreaming:light:end -->",
  "Another real line.",
];

describe("isDreamingFenceMarkerLine", () => {
  it("matches start and end markers for any phase and nothing else", () => {
    expect(isDreamingFenceMarkerLine("<!-- openclaw:dreaming:light:start -->")).toBe(true);
    expect(isDreamingFenceMarkerLine("<!--openclaw:dreaming:rem:end-->")).toBe(true);
    expect(isDreamingFenceMarkerLine("prefix <!-- openclaw:dreaming:deep:start --> suffix")).toBe(
      true,
    );
    expect(isDreamingFenceMarkerLine("Dream scratch one.")).toBe(false);
    expect(isDreamingFenceMarkerLine("<!-- openclaw:other:light:start -->")).toBe(false);
  });
});

describe("lineRangeOverlapsDreamingFence", () => {
  it("detects overlap with fenced content and marker lines only", () => {
    expect(lineRangeOverlapsDreamingFence(NOTE_LINES, 1, 1)).toBe(false);
    expect(lineRangeOverlapsDreamingFence(NOTE_LINES, 2, 2)).toBe(true);
    expect(lineRangeOverlapsDreamingFence(NOTE_LINES, 3, 4)).toBe(true);
    expect(lineRangeOverlapsDreamingFence(NOTE_LINES, 5, 5)).toBe(true);
    expect(lineRangeOverlapsDreamingFence(NOTE_LINES, 6, 6)).toBe(false);
    expect(lineRangeOverlapsDreamingFence(NOTE_LINES, 1, 6)).toBe(true);
  });

  it("clamps out-of-bounds ranges and handles empty input", () => {
    expect(lineRangeOverlapsDreamingFence(NOTE_LINES, 0, 99)).toBe(true);
    expect(lineRangeOverlapsDreamingFence([], 1, 1)).toBe(false);
  });
});

describe("blankDreamingFencedRanges", () => {
  it("blanks fenced lines while preserving line numbers", () => {
    const blanked = blankDreamingFencedRanges(NOTE_LINES.join("\n"));
    expect(blanked.split("\n")).toEqual([
      "Real memory line.",
      "",
      "",
      "",
      "",
      "Another real line.",
    ]);
  });

  it("returns content without fences unchanged", () => {
    const content = "# Notes\nNothing managed here.\n";
    expect(blankDreamingFencedRanges(content)).toBe(content);
  });

  it("blanks an unclosed fence through the end of the content", () => {
    const content = ["real", "<!-- openclaw:dreaming:rem:start -->", "scratch"].join("\n");
    expect(blankDreamingFencedRanges(content)).toBe(["real", "", ""].join("\n"));
  });

  it("blanks fences whose markers use different casing", () => {
    const content = [
      "real",
      "<!-- OpenClaw:Dreaming:Light:Start -->",
      "scratch",
      "<!-- OPENCLAW:DREAMING:LIGHT:END -->",
      "kept",
    ].join("\n");
    expect(blankDreamingFencedRanges(content)).toBe(["real", "", "", "", "kept"].join("\n"));
  });

  it("keeps CRLF line endings on surviving lines", () => {
    const content =
      "real\r\n<!-- openclaw:dreaming:light:start -->\r\nscratch\r\n<!-- openclaw:dreaming:light:end -->\r\nkept\r\n";
    expect(blankDreamingFencedRanges(content)).toBe("real\r\n\n\n\nkept\r\n");
  });
});
