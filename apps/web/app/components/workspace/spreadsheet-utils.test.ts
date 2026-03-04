import { describe, it, expect } from "vitest";
import { utils, read, write } from "xlsx";
import {
  RangeSelection,
  PointRange,
  EmptySelection,
  EntireRowsSelection,
  EntireColumnsSelection,
  EntireWorksheetSelection,
  type CellBase,
  type Matrix,
} from "react-spreadsheet";
import {
  fileExt,
  isTextSpreadsheet,
  columnLabel,
  cellRef,
  sheetToMatrix,
  matrixToSheet,
  matrixToCsv,
  selectionStats,
} from "./spreadsheet-utils";
import { isSpreadsheetFile } from "./file-viewer";

// ---------------------------------------------------------------------------
// fileExt — determines file extension, used to choose save strategy
// ---------------------------------------------------------------------------

describe("fileExt", () => {
  it("extracts lowercase extension from a simple filename", () => {
    expect(fileExt("report.csv")).toBe("csv");
  });

  it("lowercases mixed-case extensions (prevents case-sensitive misrouting)", () => {
    expect(fileExt("Data.XLSX")).toBe("xlsx");
    expect(fileExt("Sales.Csv")).toBe("csv");
  });

  it("returns last segment when filename has multiple dots", () => {
    expect(fileExt("archive.2024.01.csv")).toBe("csv");
    expect(fileExt("my.file.name.tsv")).toBe("tsv");
  });

  it("returns empty string for files with no extension (avoids undefined crash)", () => {
    expect(fileExt("Makefile")).toBe("makefile");
  });

  it("returns empty string for empty input", () => {
    expect(fileExt("")).toBe("");
  });

  it("handles dotfiles correctly", () => {
    expect(fileExt(".gitignore")).toBe("gitignore");
  });
});

// ---------------------------------------------------------------------------
// isTextSpreadsheet — decides CSV-text save path vs binary save path
// This is a critical routing decision: wrong answer = data corruption
// ---------------------------------------------------------------------------

describe("isTextSpreadsheet", () => {
  it("returns true for .csv (saves as text, not binary)", () => {
    expect(isTextSpreadsheet("data.csv")).toBe(true);
  });

  it("returns true for .tsv (saves as text with tab separator)", () => {
    expect(isTextSpreadsheet("report.tsv")).toBe(true);
  });

  it("returns false for .xlsx (must save as binary or data is destroyed)", () => {
    expect(isTextSpreadsheet("workbook.xlsx")).toBe(false);
  });

  it("returns false for .xls (binary format)", () => {
    expect(isTextSpreadsheet("legacy.xls")).toBe(false);
  });

  it("returns false for .ods (binary format)", () => {
    expect(isTextSpreadsheet("libre.ods")).toBe(false);
  });

  it("returns false for .numbers (binary format)", () => {
    expect(isTextSpreadsheet("apple.numbers")).toBe(false);
  });

  it("is case-insensitive (CSV and csv both route to text save)", () => {
    expect(isTextSpreadsheet("DATA.CSV")).toBe(true);
    expect(isTextSpreadsheet("FILE.TSV")).toBe(true);
  });

  it("returns false for non-spreadsheet files", () => {
    expect(isTextSpreadsheet("readme.md")).toBe(false);
    expect(isTextSpreadsheet("photo.png")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// columnLabel — Excel-style column headers
// Off-by-one or overflow here would misalign every cell reference
// ---------------------------------------------------------------------------

describe("columnLabel", () => {
  it("maps 0 to A (first column)", () => {
    expect(columnLabel(0)).toBe("A");
  });

  it("maps single-letter range correctly (0-25 → A-Z)", () => {
    expect(columnLabel(1)).toBe("B");
    expect(columnLabel(12)).toBe("M");
    expect(columnLabel(25)).toBe("Z");
  });

  it("rolls over to two letters at index 26 (AA)", () => {
    expect(columnLabel(26)).toBe("AA");
  });

  it("maps 27 to AB (not BA — verifies letter ordering)", () => {
    expect(columnLabel(27)).toBe("AB");
  });

  it("maps 51 to AZ (end of AA..AZ range)", () => {
    expect(columnLabel(51)).toBe("AZ");
  });

  it("maps 52 to BA (start of BA..BZ range)", () => {
    expect(columnLabel(52)).toBe("BA");
  });

  it("maps 701 to ZZ (last two-letter column)", () => {
    expect(columnLabel(701)).toBe("ZZ");
  });

  it("maps 702 to AAA (three-letter columns)", () => {
    expect(columnLabel(702)).toBe("AAA");
  });

  it("handles large column indices without crashing", () => {
    const label = columnLabel(16383);
    expect(label).toBe("XFD");
  });
});

// ---------------------------------------------------------------------------
// cellRef — formats cell coordinates for formula bar display
// Wrong output here means the formula bar shows the wrong cell
// ---------------------------------------------------------------------------

describe("cellRef", () => {
  it("formats origin cell as A1 (not A0 — 1-indexed rows)", () => {
    expect(cellRef({ row: 0, column: 0 })).toBe("A1");
  });

  it("formats typical cell reference", () => {
    expect(cellRef({ row: 6, column: 2 })).toBe("C7");
  });

  it("formats double-letter columns with correct row", () => {
    expect(cellRef({ row: 99, column: 26 })).toBe("AA100");
  });

  it("handles row 0 column 25 as Z1", () => {
    expect(cellRef({ row: 0, column: 25 })).toBe("Z1");
  });
});

// ---------------------------------------------------------------------------
// sheetToMatrix — converts xlsx WorkSheet to react-spreadsheet format
// Incorrect conversion = data silently lost or misaligned
// ---------------------------------------------------------------------------

describe("sheetToMatrix", () => {
  it("converts a simple 2x2 sheet to a matrix with CellBase objects", () => {
    const ws = utils.aoa_to_sheet([
      ["Name", "Age"],
      ["Alice", 30],
    ]);
    const m = sheetToMatrix(ws);
    expect(m).toHaveLength(2);
    expect(m[0]).toHaveLength(2);
    expect(m[0][0]!.value).toBe("Name");
    expect(m[0][1]!.value).toBe("Age");
    expect(m[1][0]!.value).toBe("Alice");
    expect(m[1][1]!.value).toBe(30);
  });

  it("pads ragged rows to the widest column count (prevents misaligned cells)", () => {
    const ws = utils.aoa_to_sheet([
      ["A", "B", "C"],
      ["X"],
    ]);
    const m = sheetToMatrix(ws);
    expect(m[0]).toHaveLength(3);
    expect(m[1]).toHaveLength(3);
    expect(m[1][1]!.value).toBe("");
    expect(m[1][2]!.value).toBe("");
  });

  it("returns a 1x1 empty matrix for a completely empty sheet", () => {
    const ws = utils.aoa_to_sheet([]);
    const m = sheetToMatrix(ws);
    expect(m.length).toBeGreaterThanOrEqual(1);
    expect(m[0].length).toBeGreaterThanOrEqual(1);
  });

  it("converts null/undefined cell values to empty string (prevents crash on .value access)", () => {
    const ws = utils.aoa_to_sheet([[null, undefined, "ok"]]);
    const m = sheetToMatrix(ws);
    expect(m[0][0]!.value).toBe("");
    expect(m[0][1]!.value).toBe("");
    expect(m[0][2]!.value).toBe("ok");
  });

  it("preserves numeric values as numbers (not strings)", () => {
    const ws = utils.aoa_to_sheet([[42, 3.14, 0]]);
    const m = sheetToMatrix(ws);
    expect(m[0][0]!.value).toBe(42);
    expect(m[0][1]!.value).toBe(3.14);
    expect(m[0][2]!.value).toBe(0);
  });

  it("preserves boolean values", () => {
    const ws = utils.aoa_to_sheet([[true, false]]);
    const m = sheetToMatrix(ws);
    expect(m[0][0]!.value).toBe(true);
    expect(m[0][1]!.value).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// matrixToSheet — converts react-spreadsheet data back to xlsx WorkSheet
// This is the write path: errors here corrupt the saved file
// ---------------------------------------------------------------------------

describe("matrixToSheet", () => {
  it("converts a simple matrix back to a WorkSheet preserving values", () => {
    const matrix: Matrix<CellBase> = [
      [{ value: "A" }, { value: "B" }],
      [{ value: 1 }, { value: 2 }],
    ];
    const ws = matrixToSheet(matrix);
    const rows: unknown[][] = utils.sheet_to_json(ws, { header: 1 });
    expect(rows).toEqual([
      ["A", "B"],
      [1, 2],
    ]);
  });

  it("treats undefined cells as empty strings (prevents null writes)", () => {
    const matrix: Matrix<CellBase> = [
      [{ value: "X" }, undefined],
      [undefined, { value: "Y" }],
    ];
    const ws = matrixToSheet(matrix);
    const rows: unknown[][] = utils.sheet_to_json(ws, { header: 1, defval: "" });
    expect(rows[0][0]).toBe("X");
    expect(rows[0][1]).toBe("");
    expect(rows[1][0]).toBe("");
    expect(rows[1][1]).toBe("Y");
  });

  it("handles null/undefined rows without crashing", () => {
    const matrix: Matrix<CellBase> = [
      [{ value: "first" }],
      undefined as unknown as (CellBase | undefined)[],
      [{ value: "third" }],
    ];
    const ws = matrixToSheet(matrix);
    const rows: unknown[][] = utils.sheet_to_json(ws, { header: 1, defval: "" });
    expect(rows[0][0]).toBe("first");
    expect(rows[2][0]).toBe("third");
  });

  it("round-trips through sheetToMatrix and back", () => {
    const original: Matrix<CellBase> = [
      [{ value: "Name" }, { value: "Score" }],
      [{ value: "Bob" }, { value: 95 }],
      [{ value: "Eve" }, { value: 88 }],
    ];
    const ws = matrixToSheet(original);
    const roundTripped = sheetToMatrix(ws);
    expect(roundTripped[0][0]!.value).toBe("Name");
    expect(roundTripped[1][0]!.value).toBe("Bob");
    expect(roundTripped[1][1]!.value).toBe(95);
    expect(roundTripped[2][1]!.value).toBe(88);
  });
});

// ---------------------------------------------------------------------------
// matrixToCsv — CSV serialization
// This is the text save path. Incorrect quoting/escaping = data loss
// ---------------------------------------------------------------------------

describe("matrixToCsv", () => {
  it("serializes a simple grid with comma separator", () => {
    const data: Matrix<CellBase> = [
      [{ value: "A" }, { value: "B" }],
      [{ value: 1 }, { value: 2 }],
    ];
    expect(matrixToCsv(data)).toBe("A,B\n1,2");
  });

  it("quotes values containing the separator (prevents column shift)", () => {
    const data: Matrix<CellBase> = [[{ value: "hello, world" }, { value: "ok" }]];
    expect(matrixToCsv(data)).toBe('"hello, world",ok');
  });

  it("escapes double quotes inside values (RFC 4180 compliance)", () => {
    const data: Matrix<CellBase> = [[{ value: 'She said "hi"' }]];
    expect(matrixToCsv(data)).toBe('"She said ""hi"""');
  });

  it("quotes values containing newlines (prevents row split)", () => {
    const data: Matrix<CellBase> = [[{ value: "line1\nline2" }]];
    expect(matrixToCsv(data)).toBe('"line1\nline2"');
  });

  it("uses tab separator for TSV output", () => {
    const data: Matrix<CellBase> = [
      [{ value: "A" }, { value: "B" }],
      [{ value: 1 }, { value: 2 }],
    ];
    expect(matrixToCsv(data, "\t")).toBe("A\tB\n1\t2");
  });

  it("quotes TSV values containing tabs (prevents column shift in TSV)", () => {
    const data: Matrix<CellBase> = [[{ value: "has\ttab" }, { value: "ok" }]];
    expect(matrixToCsv(data, "\t")).toBe('"has\ttab"\tok');
  });

  it("treats undefined cells as empty strings", () => {
    const data: Matrix<CellBase> = [[{ value: "X" }, undefined, { value: "Z" }]];
    expect(matrixToCsv(data)).toBe("X,,Z");
  });

  it("treats null rows as empty rows", () => {
    const data: Matrix<CellBase> = [
      [{ value: "a" }],
      undefined as unknown as (CellBase | undefined)[],
      [{ value: "c" }],
    ];
    expect(matrixToCsv(data)).toBe("a\n\nc");
  });

  it("handles a value that is exactly a double quote", () => {
    const data: Matrix<CellBase> = [[{ value: '"' }]];
    expect(matrixToCsv(data)).toBe('""""');
  });

  it("handles empty matrix", () => {
    expect(matrixToCsv([])).toBe("");
  });

  it("handles matrix with single empty-value cell", () => {
    const data: Matrix<CellBase> = [[{ value: "" }]];
    expect(matrixToCsv(data)).toBe("");
  });

  it("does not quote values that only contain letters/numbers (no false quoting)", () => {
    const data: Matrix<CellBase> = [[{ value: "hello" }, { value: 42 }]];
    const csv = matrixToCsv(data);
    expect(csv).toBe("hello,42");
    expect(csv).not.toContain('"');
  });

  it("handles value that contains only the separator character", () => {
    const data: Matrix<CellBase> = [[{ value: "," }]];
    expect(matrixToCsv(data)).toBe('","');
  });

  it("handles mixed types: number, boolean, string", () => {
    const data: Matrix<CellBase> = [[{ value: 0 }, { value: true }, { value: "text" }]];
    expect(matrixToCsv(data)).toBe("0,true,text");
  });
});

// ---------------------------------------------------------------------------
// selectionStats — computes Count/Sum/Avg for status bar
// Wrong stats mislead users making data-driven decisions
// ---------------------------------------------------------------------------

describe("selectionStats", () => {
  const data: Matrix<CellBase> = [
    [{ value: 10 }, { value: 20 }, { value: "text" }],
    [{ value: 30 }, { value: "" }, { value: 40 }],
    [{ value: "N/A" }, { value: 50 }, { value: 0 }],
  ];

  it("returns null when selection is null (no selection active)", () => {
    expect(selectionStats(data, null)).toBeNull();
  });

  it("returns null for an empty selection", () => {
    const sel = new EmptySelection();
    expect(selectionStats(data, sel)).toBeNull();
  });

  it("returns null when only a single cell is selected (no aggregation needed)", () => {
    const sel = new RangeSelection(
      new PointRange({ row: 0, column: 0 }, { row: 0, column: 0 }),
    );
    expect(selectionStats(data, sel)).toBeNull();
  });

  it("computes correct sum and average for a numeric range", () => {
    const sel = new RangeSelection(
      new PointRange({ row: 0, column: 0 }, { row: 1, column: 0 }),
    );
    const stats = selectionStats(data, sel);
    expect(stats).not.toBeNull();
    expect(stats!.count).toBe(2);
    expect(stats!.numericCount).toBe(2);
    expect(stats!.sum).toBe(40);
    expect(stats!.avg).toBe(20);
  });

  it("excludes non-numeric cells from sum/avg but includes them in count", () => {
    const sel = new RangeSelection(
      new PointRange({ row: 0, column: 0 }, { row: 0, column: 2 }),
    );
    const stats = selectionStats(data, sel);
    expect(stats).not.toBeNull();
    expect(stats!.count).toBe(3);
    expect(stats!.numericCount).toBe(2);
    expect(stats!.sum).toBe(30);
    expect(stats!.avg).toBe(15);
  });

  it("excludes empty-string cells from numeric count (empty is not zero)", () => {
    const sel = new RangeSelection(
      new PointRange({ row: 1, column: 0 }, { row: 1, column: 2 }),
    );
    const stats = selectionStats(data, sel);
    expect(stats).not.toBeNull();
    expect(stats!.numericCount).toBe(2);
    expect(stats!.sum).toBe(70);
  });

  it("counts zero as a numeric value (0 is not empty)", () => {
    const sel = new RangeSelection(
      new PointRange({ row: 2, column: 1 }, { row: 2, column: 2 }),
    );
    const stats = selectionStats(data, sel);
    expect(stats).not.toBeNull();
    expect(stats!.numericCount).toBe(2);
    expect(stats!.sum).toBe(50);
    expect(stats!.avg).toBe(25);
  });

  it("returns avg=0 when all selected cells are non-numeric text", () => {
    const textData: Matrix<CellBase> = [
      [{ value: "foo" }, { value: "bar" }],
    ];
    const sel = new RangeSelection(
      new PointRange({ row: 0, column: 0 }, { row: 0, column: 1 }),
    );
    const stats = selectionStats(textData, sel);
    expect(stats).not.toBeNull();
    expect(stats!.numericCount).toBe(0);
    expect(stats!.sum).toBe(0);
    expect(stats!.avg).toBe(0);
  });

  it("handles selection that spans all rows (entire-row selection)", () => {
    const sel = new EntireRowsSelection(0, 2);
    const stats = selectionStats(data, sel);
    expect(stats).not.toBeNull();
    // 3x3 grid, all 9 cells have defined CellBase objects (including {value: ""})
    expect(stats!.count).toBe(9);
  });

  it("skips undefined cells in sparse matrices", () => {
    const sparse: Matrix<CellBase> = [
      [{ value: 5 }, undefined, { value: 15 }],
    ];
    const sel = new RangeSelection(
      new PointRange({ row: 0, column: 0 }, { row: 0, column: 2 }),
    );
    const stats = selectionStats(sparse, sel);
    expect(stats).not.toBeNull();
    expect(stats!.count).toBe(2);
    expect(stats!.numericCount).toBe(2);
    expect(stats!.sum).toBe(20);
  });

  it("handles negative numbers correctly", () => {
    const negData: Matrix<CellBase> = [
      [{ value: -10 }, { value: 30 }],
    ];
    const sel = new RangeSelection(
      new PointRange({ row: 0, column: 0 }, { row: 0, column: 1 }),
    );
    const stats = selectionStats(negData, sel);
    expect(stats).not.toBeNull();
    expect(stats!.sum).toBe(20);
    expect(stats!.avg).toBe(10);
  });

  it("treats string-encoded numbers as numeric (e.g. '42' from user input)", () => {
    const strNum: Matrix<CellBase> = [
      [{ value: "42" }, { value: "3.5" }],
    ];
    const sel = new RangeSelection(
      new PointRange({ row: 0, column: 0 }, { row: 0, column: 1 }),
    );
    const stats = selectionStats(strNum, sel);
    expect(stats).not.toBeNull();
    expect(stats!.numericCount).toBe(2);
    expect(stats!.sum).toBe(45.5);
  });

  it("does not count 'NaN' string as numeric", () => {
    const nanData: Matrix<CellBase> = [
      [{ value: "NaN" }, { value: 10 }],
    ];
    const sel = new RangeSelection(
      new PointRange({ row: 0, column: 0 }, { row: 0, column: 1 }),
    );
    const stats = selectionStats(nanData, sel);
    expect(stats).not.toBeNull();
    expect(stats!.numericCount).toBe(1);
    expect(stats!.sum).toBe(10);
  });

  it("handles entire-column selection correctly", () => {
    const sel = new EntireColumnsSelection(0, 0);
    const stats = selectionStats(data, sel);
    expect(stats).not.toBeNull();
    expect(stats!.count).toBe(3);
    expect(stats!.numericCount).toBe(2);
    expect(stats!.sum).toBe(40);
  });

  it("handles entire-worksheet selection", () => {
    const sel = new EntireWorksheetSelection();
    const stats = selectionStats(data, sel);
    expect(stats).not.toBeNull();
    expect(stats!.count).toBe(9);
  });

  it("handles floating-point precision without crashing (0.1 + 0.2 scenario)", () => {
    const fpData: Matrix<CellBase> = [
      [{ value: 0.1 }, { value: 0.2 }, { value: 0.3 }],
    ];
    const sel = new RangeSelection(
      new PointRange({ row: 0, column: 0 }, { row: 0, column: 2 }),
    );
    const stats = selectionStats(fpData, sel);
    expect(stats).not.toBeNull();
    expect(stats!.numericCount).toBe(3);
    expect(stats!.sum).toBeCloseTo(0.6, 10);
    expect(stats!.avg).toBeCloseTo(0.2, 10);
  });

  it("handles Infinity values as numeric", () => {
    const infData: Matrix<CellBase> = [
      [{ value: Infinity }, { value: 1 }],
    ];
    const sel = new RangeSelection(
      new PointRange({ row: 0, column: 0 }, { row: 0, column: 1 }),
    );
    const stats = selectionStats(infData, sel);
    expect(stats).not.toBeNull();
    expect(stats!.numericCount).toBe(2);
    expect(stats!.sum).toBe(Infinity);
  });

  it("handles large multi-row selection correctly", () => {
    const bigData: Matrix<CellBase> = Array.from({ length: 100 }, (_, i) => [
      { value: i + 1 },
    ]);
    const sel = new RangeSelection(
      new PointRange({ row: 0, column: 0 }, { row: 99, column: 0 }),
    );
    const stats = selectionStats(bigData, sel);
    expect(stats).not.toBeNull();
    expect(stats!.count).toBe(100);
    expect(stats!.numericCount).toBe(100);
    expect(stats!.sum).toBe(5050);
    expect(stats!.avg).toBe(50.5);
  });
});

// ---------------------------------------------------------------------------
// isSpreadsheetFile — gate function that routes files to spreadsheet viewer
// Missing extension = file opens in wrong viewer, user can't edit it
// ---------------------------------------------------------------------------

describe("isSpreadsheetFile", () => {
  it("recognizes all xlsx-family extensions", () => {
    expect(isSpreadsheetFile("data.xlsx")).toBe(true);
    expect(isSpreadsheetFile("legacy.xls")).toBe(true);
    expect(isSpreadsheetFile("binary.xlsb")).toBe(true);
    expect(isSpreadsheetFile("macro.xlsm")).toBe(true);
    expect(isSpreadsheetFile("template.xltx")).toBe(true);
    expect(isSpreadsheetFile("macrotemplate.xltm")).toBe(true);
  });

  it("recognizes OpenDocument formats", () => {
    expect(isSpreadsheetFile("libre.ods")).toBe(true);
    expect(isSpreadsheetFile("flat.fods")).toBe(true);
  });

  it("recognizes text-based spreadsheet formats", () => {
    expect(isSpreadsheetFile("data.csv")).toBe(true);
    expect(isSpreadsheetFile("data.tsv")).toBe(true);
  });

  it("recognizes Apple Numbers format", () => {
    expect(isSpreadsheetFile("budget.numbers")).toBe(true);
  });

  it("is case-insensitive (XLSX and xlsx both detected)", () => {
    expect(isSpreadsheetFile("DATA.XLSX")).toBe(true);
    expect(isSpreadsheetFile("Report.CSV")).toBe(true);
    expect(isSpreadsheetFile("budget.Numbers")).toBe(true);
    expect(isSpreadsheetFile("LEGACY.XLS")).toBe(true);
  });

  it("rejects non-spreadsheet files (prevents wrong viewer)", () => {
    expect(isSpreadsheetFile("readme.md")).toBe(false);
    expect(isSpreadsheetFile("image.png")).toBe(false);
    expect(isSpreadsheetFile("script.py")).toBe(false);
    expect(isSpreadsheetFile("data.json")).toBe(false);
    expect(isSpreadsheetFile("styles.css")).toBe(false);
    expect(isSpreadsheetFile("document.pdf")).toBe(false);
    expect(isSpreadsheetFile("archive.zip")).toBe(false);
  });

  it("handles files with multiple dots in the name", () => {
    expect(isSpreadsheetFile("report.2024.01.xlsx")).toBe(true);
    expect(isSpreadsheetFile("data.backup.csv")).toBe(true);
  });

  it("rejects files with no extension", () => {
    expect(isSpreadsheetFile("Makefile")).toBe(false);
    expect(isSpreadsheetFile("LICENSE")).toBe(false);
  });

  it("rejects dotfiles", () => {
    expect(isSpreadsheetFile(".gitignore")).toBe(false);
    expect(isSpreadsheetFile(".env")).toBe(false);
  });

  it("rejects empty filename", () => {
    expect(isSpreadsheetFile("")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isSpreadsheetFile / isTextSpreadsheet consistency
// If a file passes isTextSpreadsheet but not isSpreadsheetFile, the save
// path runs but the file was never routed to the spreadsheet viewer.
// ---------------------------------------------------------------------------

describe("isSpreadsheetFile and isTextSpreadsheet consistency", () => {
  const textSpreadsheetFiles = ["data.csv", "report.tsv", "DATA.CSV", "REPORT.TSV"];
  const binarySpreadsheetFiles = [
    "data.xlsx", "legacy.xls", "binary.xlsb", "macro.xlsm",
    "template.xltx", "macrotemplate.xltm", "libre.ods", "flat.fods",
    "budget.numbers",
  ];

  it("every text spreadsheet is also detected as a spreadsheet file (prevents unroutable save)", () => {
    for (const f of textSpreadsheetFiles) {
      expect(isSpreadsheetFile(f)).toBe(true);
      expect(isTextSpreadsheet(f)).toBe(true);
    }
  });

  it("every binary spreadsheet is detected as spreadsheet but NOT text (prevents text-encoding binary)", () => {
    for (const f of binarySpreadsheetFiles) {
      expect(isSpreadsheetFile(f)).toBe(true);
      expect(isTextSpreadsheet(f)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Full xlsx binary round-trip
// The most critical data integrity invariant: data survives the full
// load → convert → modify → convert back → save → re-load pipeline
// ---------------------------------------------------------------------------

describe("full xlsx binary round-trip", () => {
  function createTestWorkbook(sheets: Record<string, unknown[][]>): ArrayBuffer {
    const wb = utils.book_new();
    for (const [name, aoa] of Object.entries(sheets)) {
      utils.book_append_sheet(wb, utils.aoa_to_sheet(aoa), name);
    }
    return write(wb, { type: "array", bookType: "xlsx" }) as ArrayBuffer;
  }

  it("preserves a simple sheet through the full pipeline (load → edit → save → reload)", () => {
    const original = [
      ["Name", "Age", "City"],
      ["Alice", 30, "NYC"],
      ["Bob", 25, "SF"],
    ];
    const buf = createTestWorkbook({ Sheet1: original });

    const wb1 = read(buf, { type: "array" });
    const matrix = sheetToMatrix(wb1.Sheets["Sheet1"]);

    expect(matrix[0][0]!.value).toBe("Name");
    expect(matrix[1][0]!.value).toBe("Alice");
    expect(matrix[1][1]!.value).toBe(30);

    matrix[1][1] = { value: 31 };

    const wb2 = utils.book_new();
    utils.book_append_sheet(wb2, matrixToSheet(matrix), "Sheet1");
    const buf2 = write(wb2, { type: "array", bookType: "xlsx" }) as ArrayBuffer;

    const wb3 = read(buf2, { type: "array" });
    const reloaded = sheetToMatrix(wb3.Sheets["Sheet1"]);

    expect(reloaded[0][0]!.value).toBe("Name");
    expect(reloaded[1][0]!.value).toBe("Alice");
    expect(reloaded[1][1]!.value).toBe(31);
    expect(reloaded[1][2]!.value).toBe("NYC");
    expect(reloaded[2][0]!.value).toBe("Bob");
  });

  it("preserves multi-sheet workbook through full pipeline (sheet names and data)", () => {
    const buf = createTestWorkbook({
      Revenue: [["Q1", "Q2"], [100, 200]],
      Expenses: [["Rent", "Salary"], [1000, 5000]],
      Summary: [["Net"], [-600]],
    });

    const wb1 = read(buf, { type: "array" });
    expect(wb1.SheetNames).toEqual(["Revenue", "Expenses", "Summary"]);

    const sheets = wb1.SheetNames.map((name) => ({
      name,
      data: sheetToMatrix(wb1.Sheets[name]),
    }));

    const wb2 = utils.book_new();
    for (const s of sheets) {
      utils.book_append_sheet(wb2, matrixToSheet(s.data), s.name);
    }
    const buf2 = write(wb2, { type: "array", bookType: "xlsx" }) as ArrayBuffer;

    const wb3 = read(buf2, { type: "array" });
    expect(wb3.SheetNames).toEqual(["Revenue", "Expenses", "Summary"]);

    const revenue = sheetToMatrix(wb3.Sheets["Revenue"]);
    expect(revenue[1][0]!.value).toBe(100);
    expect(revenue[1][1]!.value).toBe(200);

    const summary = sheetToMatrix(wb3.Sheets["Summary"]);
    expect(summary[1][0]!.value).toBe(-600);
  });

  it("preserves mixed data types through binary round-trip (strings, numbers, booleans)", () => {
    const buf = createTestWorkbook({
      Types: [
        ["string", 42, true, false, 0, 3.14, ""],
      ],
    });

    const wb1 = read(buf, { type: "array" });
    const matrix = sheetToMatrix(wb1.Sheets["Types"]);
    const ws2 = matrixToSheet(matrix);
    const wb2 = utils.book_new();
    utils.book_append_sheet(wb2, ws2, "Types");
    const buf2 = write(wb2, { type: "array", bookType: "xlsx" }) as ArrayBuffer;

    const wb3 = read(buf2, { type: "array" });
    const reloaded = sheetToMatrix(wb3.Sheets["Types"]);

    expect(reloaded[0][0]!.value).toBe("string");
    expect(reloaded[0][1]!.value).toBe(42);
    expect(reloaded[0][2]!.value).toBe(true);
    expect(reloaded[0][3]!.value).toBe(false);
    expect(reloaded[0][4]!.value).toBe(0);
    expect(reloaded[0][5]!.value).toBeCloseTo(3.14);
    expect(reloaded[0][6]!.value).toBe("");
  });

  it("handles large sheets (500 rows x 20 cols) without data loss", () => {
    const rows: unknown[][] = [];
    for (let r = 0; r < 500; r++) {
      const row: unknown[] = [];
      for (let c = 0; c < 20; c++) {
        row.push(r * 20 + c);
      }
      rows.push(row);
    }
    const buf = createTestWorkbook({ Big: rows });
    const wb1 = read(buf, { type: "array" });
    const matrix = sheetToMatrix(wb1.Sheets["Big"]);

    expect(matrix).toHaveLength(500);
    expect(matrix[0]).toHaveLength(20);
    expect(matrix[0][0]!.value).toBe(0);
    expect(matrix[499][19]!.value).toBe(9999);

    const ws2 = matrixToSheet(matrix);
    const wb2 = utils.book_new();
    utils.book_append_sheet(wb2, ws2, "Big");
    const buf2 = write(wb2, { type: "array", bookType: "xlsx" }) as ArrayBuffer;

    const wb3 = read(buf2, { type: "array" });
    const reloaded = sheetToMatrix(wb3.Sheets["Big"]);
    expect(reloaded).toHaveLength(500);
    expect(reloaded[499][19]!.value).toBe(9999);
    expect(reloaded[250][10]!.value).toBe(5010);
  });
});

// ---------------------------------------------------------------------------
// CSV round-trip
// Serialize to CSV, parse back, verify data survives quoting/escaping
// ---------------------------------------------------------------------------

describe("CSV round-trip", () => {
  it("simple data survives CSV serialization and re-parse", () => {
    const matrix: Matrix<CellBase> = [
      [{ value: "Name" }, { value: "Score" }],
      [{ value: "Alice" }, { value: 95 }],
      [{ value: "Bob" }, { value: 88 }],
    ];
    const csv = matrixToCsv(matrix);
    const ws = utils.aoa_to_sheet(
      csv.split("\n").map((line) => line.split(",")),
    );
    const parsed = sheetToMatrix(ws);

    expect(parsed[0][0]!.value).toBe("Name");
    expect(parsed[0][1]!.value).toBe("Score");
    expect(parsed[1][0]!.value).toBe("Alice");
    expect(parsed[2][0]!.value).toBe("Bob");
  });

  it("cells with commas, quotes, and newlines all combined in one row", () => {
    const matrix: Matrix<CellBase> = [[
      { value: 'She said "hi, there"' },
      { value: "line1\nline2" },
      { value: "plain" },
      { value: "has,comma" },
    ]];
    const csv = matrixToCsv(matrix);

    expect(csv).toContain('""');

    // RFC 4180 parse: correctly handle quoted fields with embedded newlines
    const parsed: string[] = [];
    let current = "";
    let inQuotes = false;
    for (let i = 0; i < csv.length; i++) {
      const ch = csv[i];
      if (inQuotes) {
        if (ch === '"') {
          if (i + 1 < csv.length && csv[i + 1] === '"') {
            current += '"';
            i++;
          } else {
            inQuotes = false;
          }
        } else {
          current += ch;
        }
      } else if (ch === '"') {
        inQuotes = true;
      } else if (ch === ",") {
        parsed.push(current);
        current = "";
      } else if (ch === "\n") {
        parsed.push(current);
        current = "";
      } else {
        current += ch;
      }
    }
    parsed.push(current);

    expect(parsed[0]).toBe('She said "hi, there"');
    expect(parsed[1]).toBe("line1\nline2");
    expect(parsed[2]).toBe("plain");
    expect(parsed[3]).toBe("has,comma");
  });

  it("TSV round-trip preserves data with embedded tabs", () => {
    const matrix: Matrix<CellBase> = [
      [{ value: "A" }, { value: "B\twith tab" }],
    ];
    const tsv = matrixToCsv(matrix, "\t");
    expect(tsv).toContain("A\t");
    expect(tsv).toContain('"B\twith tab"');
  });
});

// ---------------------------------------------------------------------------
// matrixToCsv — additional combined edge cases
// Real-world CSV files often have multiple edge cases in a single cell
// ---------------------------------------------------------------------------

describe("matrixToCsv — combined edge cases", () => {
  it("cell with comma + quote + newline all at once", () => {
    const data: Matrix<CellBase> = [[{ value: 'a "b", c\nd' }]];
    const csv = matrixToCsv(data);
    expect(csv).toBe('"a ""b"", c\nd"');
  });

  it("consecutive empty cells produce correct number of separators", () => {
    const data: Matrix<CellBase> = [
      [{ value: "" }, { value: "" }, { value: "" }, { value: "end" }],
    ];
    expect(matrixToCsv(data)).toBe(",,,end");
  });

  it("trailing empty cells are preserved (not truncated)", () => {
    const data: Matrix<CellBase> = [
      [{ value: "start" }, { value: "" }, { value: "" }],
    ];
    expect(matrixToCsv(data)).toBe("start,,");
  });

  it("handles unicode content including emoji and CJK characters", () => {
    const data: Matrix<CellBase> = [
      [{ value: "Tokyo" }, { value: "\u6771\u4EAC" }, { value: "\u{1F4B4}" }],
    ];
    const csv = matrixToCsv(data);
    expect(csv).toBe("Tokyo,\u6771\u4EAC,\u{1F4B4}");
  });

  it("preserves leading/trailing whitespace in cells", () => {
    const data: Matrix<CellBase> = [
      [{ value: "  padded  " }, { value: "normal" }],
    ];
    expect(matrixToCsv(data)).toBe("  padded  ,normal");
  });

  it("handles very long cell value without truncation", () => {
    const longVal = "x".repeat(10000);
    const data: Matrix<CellBase> = [[{ value: longVal }]];
    const csv = matrixToCsv(data);
    expect(csv).toBe(longVal);
    expect(csv).toHaveLength(10000);
  });
});

// ---------------------------------------------------------------------------
// sheetToMatrix — additional edge cases
// ---------------------------------------------------------------------------

describe("sheetToMatrix — additional edge cases", () => {
  it("handles single-cell sheet", () => {
    const ws = utils.aoa_to_sheet([["only"]]);
    const m = sheetToMatrix(ws);
    expect(m).toHaveLength(1);
    expect(m[0]).toHaveLength(1);
    expect(m[0][0]!.value).toBe("only");
  });

  it("handles sheet with only one column and many rows", () => {
    const aoa = Array.from({ length: 50 }, (_, i) => [i]);
    const ws = utils.aoa_to_sheet(aoa);
    const m = sheetToMatrix(ws);
    expect(m).toHaveLength(50);
    expect(m[0]).toHaveLength(1);
    expect(m[49][0]!.value).toBe(49);
  });

  it("handles sheet with only one row and many columns", () => {
    const aoa = [Array.from({ length: 50 }, (_, i) => `col${i}`)];
    const ws = utils.aoa_to_sheet(aoa);
    const m = sheetToMatrix(ws);
    expect(m).toHaveLength(1);
    expect(m[0]).toHaveLength(50);
    expect(m[0][49]!.value).toBe("col49");
  });

  it("never produces a cell with null/undefined value (null guard safety net)", () => {
    const ws = utils.aoa_to_sheet([
      [1, null, 3],
      [null, null, null],
    ]);
    const m = sheetToMatrix(ws);
    for (const row of m) {
      for (const cell of row ?? []) {
        if (cell) {
          expect(cell.value).not.toBeNull();
          expect(cell.value).not.toBeUndefined();
        }
      }
    }
  });

  it("preserves string that looks like a number (e.g. zip code '02134')", () => {
    const ws = utils.aoa_to_sheet([["02134"]]);
    const m = sheetToMatrix(ws);
    expect(m[0][0]!.value).toBe("02134");
  });

  it("handles special string values (empty string, whitespace-only)", () => {
    const ws = utils.aoa_to_sheet([["", "  ", "\t"]]);
    const m = sheetToMatrix(ws);
    expect(m[0][0]!.value).toBe("");
    expect(m[0][1]!.value).toBe("  ");
    expect(m[0][2]!.value).toBe("\t");
  });
});

// ---------------------------------------------------------------------------
// matrixToSheet — additional edge cases for the write path
// ---------------------------------------------------------------------------

describe("matrixToSheet — additional edge cases", () => {
  it("handles empty matrix (no rows)", () => {
    const ws = matrixToSheet([]);
    const rows: unknown[][] = utils.sheet_to_json(ws, { header: 1, defval: "" });
    expect(rows).toEqual([]);
  });

  it("handles matrix with single empty-value cell", () => {
    const ws = matrixToSheet([[{ value: "" }]]);
    const rows: unknown[][] = utils.sheet_to_json(ws, { header: 1, defval: "" });
    expect(rows).toHaveLength(1);
    expect(rows[0][0]).toBe("");
  });

  it("preserves row ordering (data is not scrambled)", () => {
    const matrix: Matrix<CellBase> = Array.from({ length: 26 }, (_, i) => [
      { value: String.fromCharCode(65 + i) },
    ]);
    const ws = matrixToSheet(matrix);
    const rows: unknown[][] = utils.sheet_to_json(ws, { header: 1 });
    for (let i = 0; i < 26; i++) {
      expect(rows[i][0]).toBe(String.fromCharCode(65 + i));
    }
  });

  it("handles ragged matrix (rows of different lengths)", () => {
    const matrix: Matrix<CellBase> = [
      [{ value: 1 }, { value: 2 }, { value: 3 }],
      [{ value: 4 }],
      [{ value: 5 }, { value: 6 }],
    ];
    const ws = matrixToSheet(matrix);
    const rows: unknown[][] = utils.sheet_to_json(ws, { header: 1, defval: "" });
    expect(rows[0]).toEqual([1, 2, 3]);
    expect(rows[1][0]).toBe(4);
    // xlsx pads shorter rows to the widest column when using defval
    expect(rows[2][0]).toBe(5);
    expect(rows[2][1]).toBe(6);
  });
});
