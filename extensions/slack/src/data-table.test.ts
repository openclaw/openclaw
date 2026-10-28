import { describe, expect, it } from "vitest";
import {
  buildSlackDataTableBlock,
  countSlackDataTableBlocksCellCharacters,
  countSlackDataTableCellCharacters,
  renderSlackDataTableCompactPlainTextFallback,
  renderSlackDataTableFallbackText,
  renderSlackTableFallbackText,
  SLACK_DATA_TABLE_AGGREGATE_CELL_CHARACTERS_MAX,
} from "./data-table.js";

const rawText = (text: string) => ({ type: "raw_text", text });
const nativeTable = (caption: string, rows: unknown[][]) => ({ type: "data_table", caption, rows });
const rawNumber = (value: number, text: string) => ({ type: "raw_number", value, text });
const richText = (elements: unknown[]) => ({
  type: "rich_text",
  elements: [{ type: "rich_text_section", elements }],
});

describe("Slack data table blocks", () => {
  it.each([false, true])(
    "preserves rich-text dates in table fallback (mrkdwnSafe=%s)",
    (mrkdwnSafe) => {
      expect(
        renderSlackTableFallbackText(
          {
            type: "table",
            rows: [
              [rawText("When")],
              [
                richText([
                  { type: "text", text: "From " },
                  { type: "date", timestamp: 0, format: "{date_num}" },
                  { type: "text", text: " to " },
                  {
                    type: "date",
                    timestamp: 1_700_000_000,
                    format: "{date_short}",
                    fallback: "<tomorrow>",
                  },
                ]),
              ],
            ],
          },
          mrkdwnSafe,
        ),
      ).toBe(
        `When\nFrom 1970-01-01T00:00:00.000Z to ${mrkdwnSafe ? "&lt;tomorrow&gt;" : "<tomorrow>"}`,
      );
    },
  );

  it("maps portable cells to Slack's current native shape", () => {
    expect(
      buildSlackDataTableBlock({
        type: "table",
        caption: "Pipeline report",
        headers: ["Account", "ARR"],
        rows: [
          ["Acme", 125_000],
          ["Globex", 82_000],
        ],
        rowHeaderColumnIndex: 0,
      }),
    ).toEqual({
      type: "data_table",
      caption: "Pipeline report",
      rows: [
        [rawText("Account"), rawText("ARR")],
        [rawText("Acme"), rawNumber(125_000, "125000")],
        [rawText("Globex"), rawNumber(82_000, "82000")],
      ],
      row_header_column_index: 0,
    });
  });

  it("enforces Slack's column, data-row, and aggregate character limits", () => {
    const base = {
      type: "table" as const,
      caption: "Limits",
      headers: ["Value"],
      rows: [["ok"]],
    };
    expect(buildSlackDataTableBlock(base)).toBeDefined();
    expect(
      buildSlackDataTableBlock({
        ...base,
        headers: Array.from({ length: 21 }, (_, index) => `H${String(index)}`),
        rows: [Array.from({ length: 21 }, () => "value")],
      }),
    ).toBeUndefined();
    expect(
      buildSlackDataTableBlock({ ...base, rows: Array.from({ length: 101 }, () => ["value"]) }),
    ).toBeUndefined();
    expect(
      buildSlackDataTableBlock(base, {
        cellCharacterCountOffset: SLACK_DATA_TABLE_AGGREGATE_CELL_CHARACTERS_MAX - 7,
      }),
    ).toBeDefined();
    expect(
      buildSlackDataTableBlock(base, {
        cellCharacterCountOffset: SLACK_DATA_TABLE_AGGREGATE_CELL_CHARACTERS_MAX - 6,
      }),
    ).toBeUndefined();
  });

  it("counts display text across raw tables and reports malformed native tables", () => {
    const table = nativeTable("Values", [[rawText("Name")], [rawNumber(125_000, "$125k")]]);
    expect(countSlackDataTableCellCharacters(table)).toBe(9);
    expect(countSlackDataTableBlocksCellCharacters([{ type: "section" }, table, table])).toBe(18);
    expect(
      countSlackDataTableBlocksCellCharacters([table, nativeTable("Broken", [])]),
    ).toBeUndefined();
  });

  it("extracts complete raw-number and rich-text display values for fallback", () => {
    expect(
      renderSlackDataTableFallbackText({
        type: "data_table",
        caption: "Pipeline report",
        rows: [
          [rawText("Account"), rawText("ARR"), rawText("Owner")],
          [
            rawText("Acme"),
            rawNumber(125_000, "$125k"),
            richText([
              { type: "user", user_id: "U123" },
              { type: "text", text: " ready" },
            ]),
          ],
        ],
        row_header_column_index: 0,
      }),
    ).toBe("Pipeline report (table)\n- Account: Acme; ARR: $125k; Owner: <@U123> ready");
  });

  it("rejects raw native tables outside Slack's documented bounds", () => {
    const rows = Array.from({ length: 100 }, () => [rawText("x")]);
    expect(
      countSlackDataTableCellCharacters(
        nativeTable("At limit", [[rawText("&".repeat(9_900))], ...rows]),
      ),
    ).toBe(10_000);
    const overCharacterLimit = nativeTable("Over limit", [[rawText("&".repeat(9_901))], ...rows]);
    expect(countSlackDataTableCellCharacters(overCharacterLimit)).toBeUndefined();
    expect(renderSlackDataTableCompactPlainTextFallback(overCharacterLimit)).toContain(
      "&".repeat(9_901),
    );

    const overRowLimit = nativeTable("Too many rows", [
      [rawText("Value")],
      ...Array.from({ length: 101 }, (_entry, index) => [rawText(`row-${String(index)}`)]),
    ]);
    expect(countSlackDataTableCellCharacters(overRowLimit)).toBeUndefined();
    expect(renderSlackDataTableCompactPlainTextFallback(overRowLimit)).toContain("row-100");
  });

  it("detects native tables and keeps a caption fallback for malformed raw blocks", () => {
    expect(countSlackDataTableBlocksCellCharacters([{ type: "section" }])).toBe(0);
    expect(countSlackDataTableBlocksCellCharacters([{ type: "data_table" }])).toBeUndefined();
    expect(renderSlackDataTableFallbackText(nativeTable("  Provider table  ", []))).toBe(
      "Provider table",
    );
    const sparseHeader: unknown[] = [];
    sparseHeader.length = 1;
    const malformedTable = nativeTable("Sparse header", [sparseHeader, [rawText("value")]]);
    expect(renderSlackDataTableFallbackText(malformedTable)).toBe("Sparse header");
    expect(renderSlackDataTableCompactPlainTextFallback(malformedTable)).toBe("Sparse header");
    expect(countSlackDataTableCellCharacters(malformedTable)).toBeUndefined();
  });
});
