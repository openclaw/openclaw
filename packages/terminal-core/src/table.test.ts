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

function column(key: string, options: Omit<TableColumn, "key" | "header"> = {}): TableColumn {
  return { key, header: key, ...options };
}
const cells = (lines: string[], strip: (line: string) => string, separator: string) =>
  lines.map((line) =>
    strip(line)
      .split(separator)
      .slice(1, -1)
      .map((cell) => cell.trim()),
  );

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

function expectIntroducersToStartCompleteSequences(
  value: string,
  introducer: string,
  sequences: readonly string[],
): void {
  let index = value.indexOf(introducer);
  while (index >= 0) {
    const sequence = sequences.find((candidate) => value.startsWith(candidate, index));
    expect(sequence).toBeDefined();
    index = value.indexOf(introducer, index + (sequence?.length ?? introducer.length));
  }
}

function renderValue(value: string, width = 24) {
  vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
  return renderRow(
    [column("K", { minWidth: 3 }), column("V", { flex: true, minWidth: 10 })],
    { K: "X", V: value },
    width,
  );
}

const pluginListColumns = [
  column("Name", { minWidth: 14, flex: true }),
  column("ID", { minWidth: 10, flex: true }),
  column("Format", { minWidth: 9 }),
  column("Status", { minWidth: 10 }),
  column("Source", { minWidth: 26, flex: true }),
  column("Version", { minWidth: 8 }),
];

const pluginListRows = [
  {
    Name: "N".repeat(40),
    ID: "i".repeat(22),
    Format: "openclaw",
    Status: "disabled",
    Source: `/${"s".repeat(80)}`,
    Version: "2026.8.1",
  },
];

function renderPluginListTable(width: number): string {
  vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
  return renderTable({ width, columns: pluginListColumns, rows: pluginListRows });
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
    const out = renderTable({
      columns: [
        { key: "A", header: "abc\ndef" },
        { key: "B", header: "B" },
      ],
      rows: [{ A: "x", B: "\x1b]8;;https://example.com/\x07abc\ndef\x1b]8;;\x07" }],
    });
    expect(stripAnsi(out)).toBe(
      "+-----+-----+\n| abc | B   |\n| def |     |\n+-----+-----+\n| x   | abc |\n|     | def |\n+-----+-----+\n",
    );
  });

  it("keeps newlines inside an OSC payload out of table line metrics", () => {
    const open = "\x1b]8;id=line\nmetadata;https://example.com/\x07";
    const close = "\x1b]8;;\x07";
    const out = renderCell(`${open}abc${close}`);

    expect(out).toContain(`${open}abc${close}`);
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

      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
      const rendered = JSON.parse(result.stdout);
      expect(rendered).toMatchObject({
        lineCount: shape === "soft-wrap suffix" ? 6 : 150_004,
        rows: shape === "soft-wrap suffix" ? 0 : 150_000,
        ...(shape === "soft-wrap suffix" ? { softWrapRowsMatch: true } : {}),
        header: expect.stringMatching(/^([│|]) Key +\1$/u),
      });
      expect([
        ["+-----+", "+-----+"],
        ["┌─────┐", "└─────┘"],
      ]).toContainEqual([rendered.firstLine, rendered.lastLine]);
    },
  );

  it("keeps the plugin-list shape deterministic and within 60 columns", () => {
    const width = 60;
    const out = renderPluginListTable(width);
    const lines = out.trimEnd().split("\n");
    const headerCells = (lines[1] ?? "").split("│").slice(1, -1);

    expect(out).toBe(renderPluginListTable(width));
    expect(Math.max(...lines.map(visibleWidth))).toBeLessThanOrEqual(width);
    expect(headerCells).toHaveLength(pluginListColumns.length);
    for (const [index, definition] of pluginListColumns.entries()) {
      expect(visibleWidth(headerCells[index] ?? "")).toBeGreaterThanOrEqual(
        visibleWidth(definition.header) + 2,
      );
    }
  });

  it("keeps ANSI styling when a multiline cell wraps after an unstyled line", () => {
    const muted = "\x1b[38;2;120;120;120m";
    const resetForeground = "\x1b[39m";
    const out = renderValue(`plain\n${muted}${"styled ".repeat(12)}${resetForeground}`);

    for (const line of matchingLines(out, "styled")) {
      expect(line).toContain(muted);
      const resetIndex = line.lastIndexOf(resetForeground);
      expect(resetIndex).toBeGreaterThan(-1);
      expect(line.lastIndexOf("│")).toBeGreaterThan(resetIndex);
    }
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
    for (const line of matchingLines(out, "z")) {
      for (const sequence of present) {
        expect(line).toContain(sequence);
      }
      for (const sequence of absent) {
        expect(line).not.toContain(sequence);
      }
    }
  });

  it("keeps underline color active with colon operands", () => {
    const combined = "\x1b[4;58:2::255:0:0m";
    const color = "\x1b[58:2::255:0:0m";
    const underline = "\x1b[4m";
    const globalReset = "\x1b[0m";
    const out = renderValue(`${combined}${"u".repeat(80)}${globalReset}`);

    for (const line of matchingLines(out, "u")) {
      const hasOpeningState =
        line.includes(combined) || (line.includes(underline) && line.includes(color));
      expect(hasOpeningState).toBe(true);
      const hasClosingState =
        line.includes(globalReset) || (line.includes("\x1b[24m") && line.includes("\x1b[59m"));
      expect(hasClosingState).toBe(true);
    }
  });

  it("preserves OSC-8 parameters when reopening wrapped links", () => {
    const open = "\x1b]8;id=docs;https://openclaw.ai\x07";
    const close = "\x1b]8;;\x07";
    const out = renderValue(`${open}${"OpenClaw".repeat(5)}${close} after`, 20);

    for (const line of matchingLines(out, "OpenClaw")) {
      expect(line).toContain(open);
      expect(line).toContain(close);
    }
    const afterLine = out.split("\n").find((line) => line.includes("after"));
    expect(afterLine).toBeDefined();
    const afterIndex = afterLine?.indexOf("after") ?? -1;
    const closeIndex = afterLine?.indexOf(close) ?? -1;
    expect(closeIndex).toBeGreaterThan(-1);
    expect(closeIndex).toBeLessThan(afterIndex);
    const openIndex = afterLine?.indexOf(open) ?? -1;
    if (openIndex >= 0) {
      expect(openIndex).toBeLessThan(closeIndex);
    }
  });

  it("does not reopen a leading OSC-8 link onto wrapped suffix lines (BEL ST)", () => {
    const openSeq = "\x1b]8;;https://openclaw.ai\x07";
    const closeSeq = "\x1b]8;;\x07";
    const link = `${openSeq}OpenClaw${closeSeq}`;
    const out = renderValue(`${link} after`, 20);
    expectIntroducersToStartCompleteSequences(out, openSeq.charAt(0), [openSeq, closeSeq]);

    // Reopening here would leak an unclosed hyperlink past the cell border.
    const lines = out.split("\n");
    const afterLines = lines.filter((line) => line.includes("after"));
    expect(afterLines.length).toBeGreaterThan(0);
    for (const line of afterLines) {
      expect(line.includes(openSeq)).toBe(false);
    }
    const linkLine = lines.find((line) => line.includes("OpenClaw"));
    expect(linkLine).toBeDefined();
    expect(linkLine?.includes(openSeq)).toBe(true);
    expect(linkLine?.includes(closeSeq)).toBe(true);
  });

  it("preserves blank colored CRLF lines without adding rows after wrapped spacing", () => {
    const open = "\x1b[31m";
    const close = "\x1b[39m";
    const out = renderRow(
      [column("A", { minWidth: 6 }), column("B", { minWidth: 6 })],
      { A: `${open}\r\nRead \r\n\r\nNext\r\n\r\n${close}`, B: "0\n1\n2\n3\n4" },
      15,
    );

    const dataLines = out.trimEnd().split("\n").slice(3, -1);
    expect(cells(dataLines, stripAnsi, "|")).toEqual([
      ["", "0"],
      ["Read", "1"],
      ["", "2"],
      ["Next", "3"],
      ["", "4"],
    ]);
    for (const line of dataLines) {
      const cell = line.split("|")[1] ?? "";
      expect(cell).toContain(open);
      expect(cell).toContain(close);
    }
  });

  it.each([
    [
      "linked CRLF",
      "\x1b]8;;https://openclaw.ai\x07line1\r\n東京 line2\x1b]8;;\x07",
      "\x1b]8;;https://openclaw.ai\x07",
      "\x1b]8;;\x07",
      0,
    ],
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

      const lines = out.trimEnd().split("\n");
      expect(lines).toHaveLength(6);
      for (const line of lines) {
        expect(visibleWidth(line)).toBe(48);
      }
      const dataLines = lines.slice(3, -1);
      expect(cells(dataLines, sanitizeForLog, "│")).toEqual([
        ["row", "line1"],
        ["", "東京 line2"],
      ]);
      for (const line of dataLines.slice(styledStart)) {
        expect(line).toContain(open);
        expect(line).toContain(close);
        expect(line.lastIndexOf(close)).toBeLessThan(line.lastIndexOf("│"));
      }
    },
  );

  it("shortens home paths in table cells for a whitespace-padded OPENCLAW_HOME", () => {
    const home = path.resolve("/srv/openclaw-home");
    const prefix = "$OPENCLAW_HOME";
    vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    vi.stubEnv("HOME", "/home/other");
    vi.stubEnv("USERPROFILE", "");
    vi.stubEnv("OPENCLAW_HOME", " /srv/openclaw-home ");

    const out = renderTable({
      columns: [column("Path")],
      rows: [
        { Path: home },
        { Path: `${home}/project` },
        { Path: `${home}2/project` },
        { Path: `Workspace: ${home}/project` },
      ],
    });

    expect(out.split("\n")[3]?.split("│")[1]?.trim()).toBe(prefix);
    expect(out).toContain(`${prefix}/project`);
    expect(out).toContain(`${home}2/project`);
    expect(out).toContain(`Workspace: ${prefix}/project`);
    expect(out).not.toContain(`${prefix}2/project`);
  });

  it("terminates with aligned borders when a flex column starts at its floor", () => {
    const out = renderRow(
      [
        { key: "A", header: "long header here" },
        { key: "B", header: "", flex: true },
      ],
      { A: "data", B: "📸" },
      10,
    );
    const lines = out.trimEnd().split("\n");
    const headerWidth = visibleWidth(lines[0] ?? "");
    expect(headerWidth).toBeGreaterThan(10);
    for (const line of lines) {
      expect(visibleWidth(line)).toBe(headerWidth);
    }
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
    for (const line of out.trimEnd().split("\n")) {
      expect(visibleWidth(line)).toBe(24);
    }
  });

  it.each([
    ["legacy", "", "vt100", "+", "┌"],
    ["modern", "1", "", "┌", "+"],
  ])("selects borders for %s Windows terminals", (_name, session, term, border, excluded) => {
    vi.stubEnv("WT_SESSION", session);
    vi.stubEnv("TERM", term);
    const out = renderCell("value");
    expect(out).toContain(border);
    expect(out).not.toContain(excluded);
  });
});
