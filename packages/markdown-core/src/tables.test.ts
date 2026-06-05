import { describe, expect, it } from "vitest";
import { convertMarkdownTables } from "./tables.js";

describe("convertMarkdownTables", () => {
  it("falls back to code rendering for block mode", () => {
    const rendered = convertMarkdownTables("| A | B |\n|---|---|\n| 1 | 2 |", "block");

    expect(rendered).toBe("```\n| A | B |\n| --- | --- |\n| 1 | 2 |\n```");
  });

  it("leaves markdown unchanged for adaptive mode", () => {
    const markdown = "| A | B |\n|---|---|\n| 1 | 2 |";

    expect(convertMarkdownTables(markdown, "adaptive")).toBe(markdown);
  });
});
