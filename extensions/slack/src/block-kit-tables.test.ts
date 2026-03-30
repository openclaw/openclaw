import { describe, expect, it } from "vitest";
import {
  markdownTableToSlackTableBlock,
  renderSlackTableFallbackText,
} from "./block-kit-tables.js";

describe("markdownTableToSlackTableBlock", () => {
  it("caps rows and columns to Slack's limits", () => {
    const table = {
      headers: Array.from({ length: 25 }, (_, index) => `H${index}`),
      rows: Array.from({ length: 120 }, () =>
        Array.from({ length: 25 }, (_, index) => `V${index}`),
      ),
    };

    const block = markdownTableToSlackTableBlock(table);

    expect(block.column_settings).toHaveLength(20);
    // header + 98 data rows + 1 indicator = 100 (within Slack's limit)
    expect(block.rows).toHaveLength(100);
    expect(block.rows[0]).toHaveLength(20);

    // Last row should be the truncation indicator (both rows and columns)
    // 120 input - 98 shown = 22 truncated rows, 25 - 20 = 5 truncated columns
    const lastRow = block.rows[block.rows.length - 1];
    expect(lastRow?.[0]?.text).toBe("+22 more rows, +5 more columns");
    expect(lastRow?.[1]?.text).toBe("");
  });

  it("shows column truncation indicator when columns exceed limit", () => {
    const table = {
      headers: Array.from({ length: 25 }, (_, i) => `H${i}`),
      rows: [Array.from({ length: 25 }, (_, i) => `V${i}`)],
    };

    const block = markdownTableToSlackTableBlock(table);

    // 1 header + 1 data + 1 indicator = 3
    expect(block.rows).toHaveLength(3);
    const lastRow = block.rows[block.rows.length - 1];
    expect(lastRow?.[0]?.text).toBe("+5 more columns");
  });

  it("does not add truncation indicator when rows fit within limit", () => {
    const table = {
      headers: ["A", "B"],
      rows: [
        ["1", "2"],
        ["3", "4"],
      ],
    };

    const block = markdownTableToSlackTableBlock(table);

    // 1 header + 2 data rows = 3
    expect(block.rows).toHaveLength(3);
    // No truncation indicator
    expect(block.rows[block.rows.length - 1]?.[0]?.text).toBe("3");
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
      rows: Array.from({ length: 120 }, () =>
        Array.from({ length: 25 }, (_, index) => `V${index}`),
      ),
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

  it("includes truncation indicator when rows exceed limit", () => {
    const rendered = renderSlackTableFallbackText({
      headers: ["Name", "Value"],
      rows: Array.from({ length: 110 }, (_, index) => [`item-${index}`, `${index}`]),
    });

    expect(rendered).toContain("+10 more rows");
  });
});
