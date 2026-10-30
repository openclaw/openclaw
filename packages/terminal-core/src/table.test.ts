import { spawnSync } from "node:child_process";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  resolveRuntimeWorkerArgv,
  resolveRuntimeWorkerUrl,
} from "../../../src/infra/runtime-worker-url.js";
import { sanitizeForLog, stripAnsi, visibleWidth } from "./ansi.js";
import { tableStackEntrypoint } from "./table-runtime.test-support.js";
import { renderTable, type TableColumn } from "./table.js";

const linkOpen = "\x1b]8;;https://openclaw.ai\x07";
const linkClose = "\x1b]8;;\x07";

function column(key: string, options: Partial<Omit<TableColumn, "key">> = {}): TableColumn {
  return { key, header: key, ...options };
}
const cells = (lines: string[], strip: (line: string) => string, separator: string) =>
  lines.map((line) =>
    strip(line)
      .split(separator)
      .slice(1, -1)
      .map((cell) => cell.trim()),
  );
const linesOf = (out: string) => out.trimEnd().split("\n");

function expectAnsi(lines: string[], present: readonly string[], absent: readonly string[] = []) {
  for (const line of lines) {
    for (const sequence of present) {
      expect(line).toContain(sequence);
    }
    for (const sequence of absent) {
      expect(line).not.toContain(sequence);
    }
  }
}

function expectWidth(lines: string[], width: number) {
  expect(lines.map(visibleWidth)).toEqual(lines.map(() => width));
}

function expectClosedBeforeBorder(lines: string[], open: string, close: string) {
  expectAnsi(lines, [open, close]);
  for (const line of lines) {
    expect(line.lastIndexOf(close)).toBeLessThan(line.lastIndexOf("│"));
  }
}

function renderRow(columns: TableColumn[], row: Record<string, string>, width?: number) {
  return renderTable({ columns, rows: [row], width });
}

function renderCell(value: string, minWidth?: number, width?: number) {
  return renderRow([column("V", { minWidth })], { V: value }, width);
}

function matchingLines(out: string, text: string) {
  const lines = out.split("\n").filter((line) => line.includes(text));
  expect(lines.length).toBeGreaterThan(1);
  return lines;
}

function renderValue(value: string, width = 24) {
  vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
  return renderRow(
    [column("K", { minWidth: 3 }), column("V", { flex: true, minWidth: 10 })],
    { K: "X", V: value },
    width,
  );
}

describe("renderTable", () => {
  beforeEach(() => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    vi.stubEnv("WT_SESSION", "");
    vi.stubEnv("TERM_PROGRAM", "");
    vi.stubEnv("TERM", "vt100");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("materializes executable tabs as table spacing in CSI-only cells", () => {
    expect(renderCell("\x1b[31\tm", 9)).toBe(
      "+---------+\n| V       |\n+---------+\n|         |\n+---------+\n",
    );
  });

  it("keeps materialized tabs visible after C0 before CSI restarts", () => {
    const out = renderCell("a\x1b[31\t\x07\x9b0\tmb", 9);
    expect(sanitizeForLog(out.split("\n")[3] ?? "")).toBe("| a  b    |");
    expect(stripAnsi(out)).not.toContain("\x18");
  });

  it("sizes multiline linked LF headers and cells by their widest line", () => {
    const out = renderRow([column("A", { header: "abc\ndef" }), column("B")], {
      A: "x",
      B: "\x1b]8;;https://example.com/\x07abc\ndef\x1b]8;;\x07",
    });
    expect(stripAnsi(out)).toBe(
      "+-----+-----+\n| abc | B   |\n| def |     |\n+-----+-----+\n| x   | abc |\n|     | def |\n+-----+-----+\n",
    );
  });

  it("keeps newlines inside an OSC payload out of table line metrics", () => {
    const open = "\x1b]8;id=line\nmetadata;https://example.com/\x07";
    const out = renderCell(`${open}abc${linkClose}`);
    expect(out).toContain(`${open}abc${linkClose}`);
    expect(stripAnsi(out)).toBe("+-----+\n| V   |\n+-----+\n| abc |\n+-----+\n");
  });

  it.each(["rows", "wrapped lines", "soft-wrap suffix"])(
    "renders large %s with the CLI process stack",
    (shape) => {
      // Worker threads have a larger stack than the CLI process. Neither many
      // rows nor one heavily wrapped cell may depend on V8's argument-count limit.
      const result = spawnSync(
        process.execPath,
        [...resolveRuntimeWorkerArgv(resolveRuntimeWorkerUrl(tableStackEntrypoint)), shape],
        { encoding: "utf8", timeout: 30_000 },
      );
      expect(result.status, result.stderr).toBe(0);
      const rendered = JSON.parse(result.stdout);
      expect(rendered).toMatchObject({
        lineCount: shape === "soft-wrap suffix" ? 6 : 150_004,
        rows: shape === "soft-wrap suffix" ? 0 : 150_000,
        ...(shape === "soft-wrap suffix" ? { softWrapRowsMatch: true } : {}),
      });
    },
  );

  it("fits mixed flex columns within 60 columns without clipping headers", () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    const fields = [
      ["Name", 30, true, "N".repeat(40)],
      ["Status", 10, false, "disabled"],
      ["Source", 26, true, `/${"s".repeat(80)}`],
    ] as const;
    const columns = fields.map(([key, minWidth, flex]) => column(key, { minWidth, flex }));
    const row = Object.fromEntries(fields.map((field) => [field[0], field[3]]));
    const width = 60;
    const lines = linesOf(renderRow(columns, row, width));
    const headerCells = (lines[1] ?? "").split("│").slice(1, -1);
    expect(Math.max(...lines.map(visibleWidth))).toBeLessThanOrEqual(width);
    for (const [index, definition] of columns.entries()) {
      expect(visibleWidth(headerCells[index] ?? "")).toBeGreaterThanOrEqual(
        visibleWidth(definition.header) + 2,
      );
    }
  });

  it("keeps ANSI styling when a multiline cell wraps after an unstyled line", () => {
    const muted = "\x1b[38;2;120;120;120m";
    const resetForeground = "\x1b[39m";
    const out = renderValue(`plain\n${muted}${"styled ".repeat(12)}${resetForeground}`);
    expectClosedBeforeBorder(matchingLines(out, "styled"), muted, resetForeground);
  });

  it.each([
    [
      "RGB zero operands",
      "prefix \x1b[1m\x1b[38;2;255;0;0m",
      ["\x1b[1m", "\x1b[38;2;255;0;0m"],
      [],
    ],
    ["selective reset", "\x1b[1;31mred\x1b[39m\n", ["\x1b[1m"], ["\x1b[1;31m", "\x1b[31m"]],
  ] as const)("keeps unrelated SGR categories after %s", (_name, prefix, present, absent) => {
    const out = renderValue(`${prefix}${"z".repeat(80)}\x1b[0m`);
    expectAnsi(matchingLines(out, "z"), present, absent);
  });

  it("keeps underline color active with colon operands", () => {
    const combined = "\x1b[4;58:2::255:0:0m";
    const color = "\x1b[58:2::255:0:0m";
    const globalReset = "\x1b[0m";
    const out = renderValue(`${combined}${"u".repeat(80)}${globalReset}`);
    for (const line of matchingLines(out, "u")) {
      expect(line.includes(combined) || (line.includes("\x1b[4m") && line.includes(color))).toBe(
        true,
      );
      expect(
        line.includes(globalReset) || (line.includes("\x1b[24m") && line.includes("\x1b[59m")),
      ).toBe(true);
    }
  });

  it("preserves OSC-8 parameters when reopening wrapped links", () => {
    const open = "\x1b]8;id=docs;https://openclaw.ai\x07";
    const out = renderValue(`${open}${"OpenClaw".repeat(5)}${linkClose} after`, 20);
    expectAnsi(matchingLines(out, "OpenClaw"), [open, linkClose]);
    const afterLine = out.split("\n").find((line) => line.includes("after")) ?? "";
    expect(afterLine).toContain("after");
    const closeIndex = afterLine.indexOf(linkClose);
    expect(closeIndex).toBeGreaterThan(-1);
    expect(closeIndex).toBeLessThan(afterLine.indexOf("after"));
    expect(afterLine.indexOf(open)).toBeLessThan(closeIndex);
  });

  it("does not reopen a leading OSC-8 link onto wrapped suffix lines (BEL ST)", () => {
    const out = renderValue(`${linkOpen}OpenClaw${linkClose} after`, 20);
    expect(out.replaceAll(linkOpen, "").replaceAll(linkClose, "")).not.toContain("\x1b");
    // Reopening here would leak an unclosed hyperlink past the cell border.
    const lines = linesOf(out);
    const afterLines = lines.filter((line) => line.includes("after"));
    expect(afterLines.length).toBeGreaterThan(0);
    expectAnsi(afterLines, [], [linkOpen]);
    expectAnsi([lines.find((line) => line.includes("OpenClaw")) ?? ""], [linkOpen, linkClose]);
  });

  it("preserves blank colored CRLF lines without adding rows after wrapped spacing", () => {
    const open = "\x1b[31m";
    const close = "\x1b[39m";
    const out = renderRow(
      [column("A", { minWidth: 6 }), column("B", { minWidth: 6 })],
      { A: `${open}\r\nRead \r\n\r\nNext\r\n\r\n${close}`, B: "0\n1\n2\n3\n4" },
      15,
    );
    const dataLines = linesOf(out).slice(3, -1);
    expect(cells(dataLines, stripAnsi, "|")).toEqual(
      ["", "Read", "", "Next", ""].map((text, index) => [text, String(index)]),
    );
    expectAnsi(
      dataLines.map((line) => line.split("|")[1] ?? ""),
      [open, close],
    );
  });

  it.each([
    ["linked CRLF", `${linkOpen}line1\r\n東京 line2${linkClose}`, linkOpen, linkClose, 0],
    ["CR/CSI-HT/LF", "line1\r\x1b[31\tm\n東京 line2\x1b[39m", "\x1b[31m", "\x1b[39m", 1],
  ] as const)(
    "respects explicit %s newlines in cell values",
    (_name, value, open, close, styledStart) => {
      vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
      const out = renderRow(
        [column("A", { minWidth: 6 }), column("B", { minWidth: 10, flex: true })],
        { A: "row", B: value },
        48,
      );
      const lines = linesOf(out);
      expectWidth(lines, 48);
      const dataLines = lines.slice(3, -1);
      expect(cells(dataLines, sanitizeForLog, "│")).toEqual([
        ["row", "line1"],
        ["", "東京 line2"],
      ]);
      expectClosedBeforeBorder(dataLines.slice(styledStart), open, close);
    },
  );

  it("shortens home paths in table cells for a whitespace-padded OPENCLAW_HOME", () => {
    const home = path.resolve("/srv/openclaw-home");
    vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    vi.stubEnv("HOME", "/home/other");
    vi.stubEnv("USERPROFILE", "");
    vi.stubEnv("OPENCLAW_HOME", " /srv/openclaw-home ");
    const out = renderRow([column("Path")], { Path: home });
    expect(cells(linesOf(out).slice(3, -1), stripAnsi, "│")).toEqual([["$OPENCLAW_HOME"]]);
  });

  it("terminates with aligned borders when a flex column starts at its floor", () => {
    const out = renderRow(
      [column("A", { header: "long header here" }), column("B", { header: "", flex: true })],
      { A: "data", B: "📸" },
      10,
    );
    const lines = linesOf(out);
    const headerWidth = visibleWidth(lines[0] ?? "");
    expect(headerWidth).toBeGreaterThan(10);
    expectWidth(lines, headerWidth);
  });

  it("wraps separately executed CSI tabs with the surrounding text", () => {
    const sequence = "\x1b[31\t\t\tm";
    const out = renderCell(`a bbb${sequence}d\x1b[0m`, 7, 9);
    expect(out).toBe(
      "+-------+\n| V     |\n+-------+\n| a     |\n| bbb\x1b[\x18   |\n| \x1b[31md\x1b[0m     |\n+-------+\n",
    );
  });

  it("does not interpret CSI intermediates as SGR state", () => {
    const sequence = "\x1b[31 m";
    const out = renderValue(`${sequence}${"a".repeat(80)}`);

    expect(out.split(sequence)).toHaveLength(2);
    expect(out).not.toContain("\x1b[39m");
    expectWidth(linesOf(out), 24);
  });

  it("selects Unicode borders for modern Windows terminals", () => {
    vi.stubEnv("WT_SESSION", "1");
    const out = renderCell("value");
    expect(out).toContain("┌");
    expect(out).not.toContain("+");
  });
});
