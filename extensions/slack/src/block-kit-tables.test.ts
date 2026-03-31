import { describe, expect, it } from "vitest";
import {
  markdownTableToSlackTableBlock,
  renderSlackTableFallbackText,
} from "./block-kit-tables.js";

describe("markdownTableToSlackTableBlock", () => {
  it("caps rows and columns to Slack's limits", () => {
    const table = {
      headers: Array.from({ length: 25 }, (_, index) => `H${index}`),
      rows: Array.from({ length: 120 }, () => Array.from({ length: 25 }, (_, index) => `V${index}`)),
    };

    const block = markdownTableToSlackTableBlock(table);

    expect(block.column_settings).toHaveLength(20);
    expect(block.rows).toHaveLength(100);
    expect(block.rows[0]).toHaveLength(20);
  });
});

describe("renderSlackTableFallbackText", () => {
  it("matches the block helper's empty-header behavior", () => {
    const rendered = renderSlackTableFallbackText({
      headers: ["", ""],
      rows: [["A", "1"]],
    });

    expect(rendered).not.toContain("|  |  |");
    expect(rendered).toContain("| A | 1 |");
  });

  it("applies the same row and column caps as the block helper", () => {
    const rendered = renderSlackTableFallbackText({
      headers: Array.from({ length: 25 }, (_, index) => `H${index}`),
      rows: Array.from({ length: 120 }, () => Array.from({ length: 25 }, (_, index) => `V${index}`)),
    });

    const lines = rendered.split("\n");
    expect(lines.length).toBeGreaterThan(1);
    expect(rendered.length).toBeLessThanOrEqual(4000);
    expect(lines[0]?.split("|").length ?? 0).toBeLessThanOrEqual(22);
  });

  it("truncates extremely wide cells to keep fallback rendering bounded", () => {
    const rendered = renderSlackTableFallbackText({
      headers: ["A"],
      rows: [["x".repeat(5000)]],
    });

    expect(rendered.length).toBeLessThanOrEqual(4000);
    expect(rendered).toContain("...");
  });

  it("does not depend on spread Math.max over huge row arrays", () => {
    const rendered = renderSlackTableFallbackText({
      headers: ["A"],
      rows: Array.from({ length: 5000 }, (_, index) => [`row-${index}`]),
    });

    expect(rendered.length).toBeLessThanOrEqual(4000);
    expect(rendered).toContain("row-0");
  });
});
