import MarkdownIt from "markdown-it";
import { describe, expect, it } from "vitest";
import { formatMemoryBlock, normalizeMemoryBlockText, parseMemoryBlocks } from "./memory-blocks.js";

describe("memory block markdown format", () => {
  it("parses and formats semantic block separators", () => {
    const blocks = parseMemoryBlocks(
      ["Raw", "---", "Still raw", "", "----", "", "Use pnpm.", "", "----"].join("\n"),
    );

    expect(blocks).toEqual([
      {
        startLine: 1,
        endLine: 3,
        lineNumbers: [1, 2, 3],
        text: "Raw\n---\nStill raw",
      },
      {
        startLine: 7,
        endLine: 7,
        lineNumbers: [7],
        text: "Use pnpm.",
      },
    ]);
    expect(parseMemoryBlocks(["----", "", "----"].join("\n"))).toEqual([]);
    expect(parseMemoryBlocks(["----", "", "Unclosed"].join("\n"))).toEqual([
      {
        startLine: 3,
        endLine: 3,
        lineNumbers: [3],
        text: "Unclosed",
      },
    ]);
    expect(formatMemoryBlock(" Remember qmd safety. ")).toBe("Remember qmd safety.\n\n----\n");
    expect(normalizeMemoryBlockText("alpha\n----\nbeta")).toBe("alpha\n---\nbeta");
    expect(new MarkdownIt().render("---\n")).toBe("<hr>\n");
  });
});
