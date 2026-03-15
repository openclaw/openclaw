import { describe, expect, it } from "vitest";
import type { MarkdownTableData } from "../../../src/markdown/ir.js";
import { markdownTableToBlockKit, markdownTablesToBlockKitAttachment } from "./block-kit-tables.js";

describe("markdownTableToBlockKit", () => {
  it("converts a simple table to Block Kit format", () => {
    const table: MarkdownTableData = {
      headers: ["Name", "Age"],
      rows: [
        ["Alice", "30"],
        ["Bob", "25"],
      ],
      placeholderOffset: 0,
    };

    const result = markdownTableToBlockKit(table);

    expect(result.type).toBe("table");
    expect(result.column_settings).toEqual([{ is_wrapped: true }, { is_wrapped: true }]);
    expect(result.rows).toHaveLength(3); // header + 2 data rows
    expect(result.rows[0]).toEqual([
      { type: "raw_text", text: "Name" },
      { type: "raw_text", text: "Age" },
    ]);
    expect(result.rows[1]).toEqual([
      { type: "raw_text", text: "Alice" },
      { type: "raw_text", text: "30" },
    ]);
    expect(result.rows[2]).toEqual([
      { type: "raw_text", text: "Bob" },
      { type: "raw_text", text: "25" },
    ]);
  });

  it("handles empty table", () => {
    const table: MarkdownTableData = {
      headers: [],
      rows: [],
      placeholderOffset: 0,
    };

    const result = markdownTableToBlockKit(table);
    expect(result.rows).toEqual([]);
    expect(result.column_settings).toEqual([]);
  });

  it("pads rows with fewer columns than headers", () => {
    const table: MarkdownTableData = {
      headers: ["A", "B", "C"],
      rows: [["1"]],
      placeholderOffset: 0,
    };

    const result = markdownTableToBlockKit(table);
    expect(result.rows[1]).toEqual([
      { type: "raw_text", text: "1" },
      { type: "raw_text", text: "" },
      { type: "raw_text", text: "" },
    ]);
  });

  it("handles rows with more columns than headers", () => {
    const table: MarkdownTableData = {
      headers: ["A"],
      rows: [["1", "2", "3"]],
      placeholderOffset: 0,
    };

    const result = markdownTableToBlockKit(table);
    // Column count should be max of headers and rows
    expect(result.column_settings).toHaveLength(3);
    expect(result.rows[0]).toHaveLength(3); // header row padded
    expect(result.rows[1]).toHaveLength(3);
  });
});

describe("markdownTablesToBlockKitAttachment", () => {
  it("wraps tables in a single attachment when under limit", () => {
    const tables: MarkdownTableData[] = [
      { headers: ["X"], rows: [["1"]], placeholderOffset: 0 },
      { headers: ["Y"], rows: [["2"]], placeholderOffset: 10 },
    ];

    const result = markdownTablesToBlockKitAttachment(tables);
    expect(result).toHaveLength(1);
    expect(result[0]?.blocks).toHaveLength(2);
  });

  it("splits tables across attachments when exceeding 50-block limit", () => {
    const tables: MarkdownTableData[] = Array.from({ length: 75 }, (_, i) => ({
      headers: [`Col${i}`],
      rows: [[`val${i}`]],
      placeholderOffset: i * 10,
    }));

    const result = markdownTablesToBlockKitAttachment(tables);
    expect(result).toHaveLength(2);
    expect(result[0]?.blocks).toHaveLength(50);
    expect(result[1]?.blocks).toHaveLength(25);
  });

  it("returns empty array for no tables", () => {
    expect(markdownTablesToBlockKitAttachment([])).toEqual([]);
  });
});
