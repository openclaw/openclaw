import { describe, expect, it } from "vitest";
import {
  buildMarkdownCardWithTables,
  hasMarkdownTables,
  mdTableToFeishuTable,
  parseTableRow,
  splitTextAndTables,
} from "./markdown-card.js";

describe("parseTableRow", () => {
  it("parses a standard table row with leading/trailing pipes", () => {
    expect(parseTableRow("| a | b | c |")).toEqual(["a", "b", "c"]);
  });

  it("handles extra whitespace in cells", () => {
    expect(parseTableRow("|  foo  |  bar  |")).toEqual(["foo", "bar"]);
  });

  it("handles row without leading pipe", () => {
    expect(parseTableRow("a | b | c |")).toEqual(["a", "b", "c"]);
  });

  it("handles row without trailing pipe", () => {
    expect(parseTableRow("| a | b | c")).toEqual(["a", "b", "c"]);
  });
});

describe("mdTableToFeishuTable", () => {
  it("converts a basic 2-column table", () => {
    const table = ["| Name | Age |", "|------|-----|", "| Alice | 30 |", "| Bob | 25 |"].join("\n");

    const result = mdTableToFeishuTable(table);
    expect(result).not.toBeNull();
    expect(result!.tag).toBe("table");
    expect(result!.page_size).toBe(2);
    expect((result!.columns as any[])[0].display_name).toBe("Name");
    expect((result!.columns as any[])[1].display_name).toBe("Age");
    expect((result!.rows as any[])[0].col_0).toBe("Alice");
    expect((result!.rows as any[])[0].col_1).toBe("30");
    expect((result!.rows as any[])[1].col_0).toBe("Bob");
    expect((result!.rows as any[])[1].col_1).toBe("25");
  });

  it("returns null for text with fewer than 3 lines", () => {
    expect(mdTableToFeishuTable("| a |\n|---|")).toBeNull();
  });

  it("handles missing cells gracefully (fills empty string)", () => {
    const table = ["| A | B | C |", "|---|---|---|", "| x |"].join("\n");

    const result = mdTableToFeishuTable(table);
    expect(result).not.toBeNull();
    const rows = result!.rows as any[];
    expect(rows[0].col_0).toBe("x");
    expect(rows[0].col_1).toBe("");
    expect(rows[0].col_2).toBe("");
  });

  it("sets proper header_style with grey background and bold", () => {
    const table = ["| H1 | H2 |", "|----|----|", "| v1 | v2 |"].join("\n");

    const result = mdTableToFeishuTable(table);
    expect(result).not.toBeNull();
    const style = result!.header_style as any;
    expect(style.background_style).toBe("grey");
    expect(style.bold).toBe(true);
    expect(style.text_align).toBe("center");
  });

  it("caps page_size at 10 for large tables", () => {
    const rows = Array.from({ length: 15 }, (_, i) => `| r${i} | v${i} |`);
    const table = ["| A | B |", "|---|---|", ...rows].join("\n");

    const result = mdTableToFeishuTable(table);
    expect(result).not.toBeNull();
    expect(result!.page_size).toBe(10);
    // All rows are still present in the data
    expect((result!.rows as any[]).length).toBe(15);
  });
});

describe("splitTextAndTables", () => {
  it("returns a single markdown element for text without tables", () => {
    const result = splitTextAndTables("Hello **world**");
    expect(result).toEqual([{ tag: "markdown", content: "Hello **world**" }]);
  });

  it("returns an empty markdown element for empty text", () => {
    const result = splitTextAndTables("");
    expect(result).toEqual([{ tag: "markdown", content: "" }]);
  });

  it("converts a standalone table to a table component", () => {
    const text = "| A | B |\n|---|---|\n| 1 | 2 |\n";
    const result = splitTextAndTables(text);
    expect(result).toHaveLength(1);
    expect(result[0].tag).toBe("table");
  });

  it("splits text + table + text into 3 elements", () => {
    const text = [
      "Here is a summary:",
      "",
      "| Name | Score |",
      "|------|-------|",
      "| Alice | 95 |",
      "| Bob | 87 |",
      "",
      "That's all!",
    ].join("\n");

    const result = splitTextAndTables(text);
    expect(result).toHaveLength(3);
    expect(result[0].tag).toBe("markdown");
    expect((result[0].content as string).trim()).toBe("Here is a summary:");
    expect(result[1].tag).toBe("table");
    expect(result[2].tag).toBe("markdown");
    expect((result[2].content as string).trim()).toBe("That's all!");
  });

  it("does NOT convert tables inside fenced code blocks", () => {
    const text = [
      "Example table syntax:",
      "",
      "```md",
      "| A | B |",
      "|---|---|",
      "| 1 | 2 |",
      "```",
      "",
      "End.",
    ].join("\n");

    const result = splitTextAndTables(text);
    // Everything stays as markdown — no table component
    expect(result).toHaveLength(1);
    expect(result[0].tag).toBe("markdown");
    expect(result[0].content as string).toContain("```md");
    expect(result[0].content as string).toContain("| A | B |");
  });

  it("converts real table but preserves table inside code block", () => {
    const text = [
      "Here is example code:",
      "",
      "```",
      "| X | Y |",
      "|---|---|",
      "| a | b |",
      "```",
      "",
      "And here is a real table:",
      "",
      "| Name | Score |",
      "|------|-------|",
      "| Alice | 95 |",
    ].join("\n");

    const result = splitTextAndTables(text);
    // Should have: markdown (with code block), table (real table)
    const markdownElements = result.filter((e) => e.tag === "markdown");
    const tableElements = result.filter((e) => e.tag === "table");
    expect(tableElements).toHaveLength(1);
    // The code block content should be in a markdown element
    const codeBlockMd = markdownElements.find((e) => (e.content as string).includes("```"));
    expect(codeBlockMd).toBeDefined();
  });

  it("preserves leading whitespace in non-table segments", () => {
    const text = "    indented code block\n    second line\n";
    const result = splitTextAndTables(text);
    expect(result).toHaveLength(1);
    expect(result[0].tag).toBe("markdown");
    // Leading spaces should be preserved
    expect(result[0].content as string).toContain("    indented code block");
  });

  it("handles multiple tables in one text", () => {
    const text = [
      "Table 1:",
      "| A | B |",
      "|---|---|",
      "| 1 | 2 |",
      "",
      "Table 2:",
      "| C | D |",
      "|---|---|",
      "| 3 | 4 |",
    ].join("\n");

    const result = splitTextAndTables(text);
    // Should be: markdown, table, markdown, table
    expect(result).toHaveLength(4);
    expect(result[0].tag).toBe("markdown");
    expect(result[1].tag).toBe("table");
    expect(result[2].tag).toBe("markdown");
    expect(result[3].tag).toBe("table");
  });
});

describe("hasMarkdownTables", () => {
  it("returns true when text contains a table", () => {
    const text = "| A | B |\n|---|---|\n| 1 | 2 |\n";
    expect(hasMarkdownTables(text)).toBe(true);
  });

  it("returns false for text without tables", () => {
    expect(hasMarkdownTables("Hello world\n\nNo tables here")).toBe(false);
  });

  it("returns false for pipe characters that are not tables", () => {
    expect(hasMarkdownTables("a | b but not a table")).toBe(false);
  });
});

describe("buildMarkdownCardWithTables", () => {
  it("produces Card JSON 2.0 structure", () => {
    const card = buildMarkdownCardWithTables("Hello");
    expect(card.schema).toBe("2.0");
    expect(card.config).toEqual({ wide_screen_mode: true });
    expect((card.body as any).elements).toBeDefined();
  });

  it("converts tables to native table components in the card body", () => {
    const text = [
      "Results:",
      "",
      "| Test | Status |",
      "|------|--------|",
      "| Unit | Pass |",
      "| E2E | Fail |",
      "",
      "Done.",
    ].join("\n");

    const card = buildMarkdownCardWithTables(text);
    const elements = (card.body as any).elements;
    expect(elements).toHaveLength(3);
    expect(elements[0].tag).toBe("markdown");
    expect((elements[0].content as string).trim()).toBe("Results:");
    expect(elements[1].tag).toBe("table");
    expect(elements[1].columns[0].display_name).toBe("Test");
    expect(elements[1].columns[1].display_name).toBe("Status");
    expect(elements[2].tag).toBe("markdown");
    expect((elements[2].content as string).trim()).toBe("Done.");
  });

  it("keeps plain markdown as-is when no tables present", () => {
    const card = buildMarkdownCardWithTables("**Bold** and `code`");
    const elements = (card.body as any).elements;
    expect(elements).toHaveLength(1);
    expect(elements[0]).toEqual({ tag: "markdown", content: "**Bold** and `code`" });
  });
});
