import { describe, expect, it } from "vitest";
import { buildAdaptiveCardTable, splitTextAndTables } from "./adaptive-card-table.js";

describe("buildAdaptiveCardTable", () => {
  it("builds an Adaptive Card with Table element from table metadata", () => {
    const card = buildAdaptiveCardTable({
      headers: ["Name", "Age", "City"],
      rows: [
        ["Alice", "30", "NYC"],
        ["Bob", "25", "LA"],
      ],
      placeholderOffset: 0,
    });

    expect(card.type).toBe("AdaptiveCard");
    expect(card.version).toBe("1.5");
    expect(card.body).toHaveLength(1);

    const table = card.body[0] as Record<string, unknown>;
    expect(table.type).toBe("Table");
    expect(table.firstRowAsHeader).toBe(true);
    expect(table.showGridLines).toBe(true);

    const columns = table.columns as unknown[];
    expect(columns).toHaveLength(3);

    const rows = table.rows as Array<{ type: string; cells: unknown[] }>;
    expect(rows).toHaveLength(3);
    expect(rows[0]?.type).toBe("TableRow");
    expect(rows[0]?.style).toBe("accent");

    const headerCells = rows[0]?.cells as Array<{ items: Array<{ text: string }> }>;
    expect(headerCells[0]?.items[0]?.text).toBe("Name");
    expect(headerCells[1]?.items[0]?.text).toBe("Age");
    expect(headerCells[2]?.items[0]?.text).toBe("City");

    const dataCells = rows[1]?.cells as Array<{ items: Array<{ text: string }> }>;
    expect(dataCells[0]?.items[0]?.text).toBe("Alice");
    expect(dataCells[1]?.items[0]?.text).toBe("30");
    expect(dataCells[2]?.items[0]?.text).toBe("NYC");
  });

  it("handles empty cells gracefully", () => {
    const card = buildAdaptiveCardTable({
      headers: ["Key", "Value"],
      rows: [
        ["foo", ""],
        ["", "bar"],
      ],
      placeholderOffset: 0,
    });

    const rows = (card.body[0] as Record<string, unknown>).rows as Array<{
      cells: Array<{ items: Array<{ text: string }> }>;
    }>;
    expect(rows[1]?.cells[1]?.items[0]?.text).toBe(" ");
    expect(rows[2]?.cells[0]?.items[0]?.text).toBe(" ");
  });
});

describe("splitTextAndTables", () => {
  it("returns text-only segment when no tables present", () => {
    const result = splitTextAndTables("Hello world", []);
    expect(result).toEqual([{ kind: "text", text: "Hello world" }]);
  });

  it("returns empty array for empty text with no tables", () => {
    const result = splitTextAndTables("", []);
    expect(result).toEqual([]);
  });

  it("splits text around a single table", () => {
    const text = "Before\n\nAfter";
    const table = { headers: ["A"], rows: [["1"]], placeholderOffset: 8 };
    const result = splitTextAndTables(text, [table]);

    expect(result).toHaveLength(3);
    expect(result[0]).toEqual({ kind: "text", text: "Before" });
    expect(result[1]).toEqual({ kind: "table", table });
    expect(result[2]).toEqual({ kind: "text", text: "After" });
  });

  it("handles table at the beginning of text", () => {
    const text = "After the table";
    const table = { headers: ["X"], rows: [["y"]], placeholderOffset: 0 };
    const result = splitTextAndTables(text, [table]);

    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ kind: "table", table });
    expect(result[1]).toEqual({ kind: "text", text: "After the table" });
  });

  it("handles table at the end of text", () => {
    const text = "Before the table";
    const table = { headers: ["X"], rows: [["y"]], placeholderOffset: 16 };
    const result = splitTextAndTables(text, [table]);

    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ kind: "text", text: "Before the table" });
    expect(result[1]).toEqual({ kind: "table", table });
  });

  it("handles multiple consecutive tables", () => {
    const text = "Intro\n\nMiddle\n\nEnd";
    const tables = [
      { headers: ["A"], rows: [["1"]], placeholderOffset: 7 },
      { headers: ["B"], rows: [["2"]], placeholderOffset: 14 },
    ];
    const result = splitTextAndTables(text, tables);

    expect(result).toHaveLength(5);
    expect(result[0]).toEqual({ kind: "text", text: "Intro" });
    expect(result[1]).toEqual({ kind: "table", table: tables[0] });
    expect(result[2]).toEqual({ kind: "text", text: "Middle" });
    expect(result[3]).toEqual({ kind: "table", table: tables[1] });
    expect(result[4]).toEqual({ kind: "text", text: "End" });
  });
});
