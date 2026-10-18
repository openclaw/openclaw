import { spawnSync } from "node:child_process";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  resolveRuntimeWorkerArgv,
  resolveRuntimeWorkerUrl,
} from "../../../src/infra/runtime-worker-url.js";
import { sanitizeForLog, stripAnsi, visibleWidth } from "./ansi.js";
import { tableStackEntrypoint } from "./table-runtime.test-support.js";
import { renderTable } from "./table.js";

function mockProcessPlatform(platform: NodeJS.Platform): void {
  vi.spyOn(process, "platform", "get").mockReturnValue(platform);
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
  return renderTable({
    width,
    border: "unicode",
    columns: [
      { key: "K", header: "K", minWidth: 3 },
      { key: "V", header: "V", flex: true, minWidth: 10 },
    ],
    rows: [{ K: "X", V: value }],
  });
}

const pluginListColumns = [
  { key: "Name", header: "Name", minWidth: 14, flex: true },
  { key: "ID", header: "ID", minWidth: 10, flex: true },
  { key: "Format", header: "Format", minWidth: 9 },
  { key: "Status", header: "Status", minWidth: 10 },
  { key: "Source", header: "Source", minWidth: 26, flex: true },
  { key: "Version", header: "Version", minWidth: 8 },
];

const pluginListRows = [
  {
    Name: "Amazon Bedrock",
    ID: "amazon-bedrock",
    Format: "openclaw",
    Status: "enabled",
    Source: "~/Projects/openclaw/extensions/amazon-bedrock/index.ts",
    Version: "2026.8.1",
  },
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
  return renderTable({
    width,
    border: "unicode",
    columns: pluginListColumns,
    rows: pluginListRows,
  });
}

describe("renderTable", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it.each([["CSI without text", "\x1b[31\tm", "|         |"]])(
    "materializes executable tabs as table spacing in %s cells",
    (_label, value, expectedRow) => {
      const out = renderTable({
        border: "ascii",
        columns: [{ key: "V", header: "V", minWidth: 9, maxWidth: 9 }],
        rows: [{ V: value }],
      });

      expect(out).toBe(
        ["+---------+", "| V       |", "+---------+", expectedRow, "+---------+", ""].join("\n"),
      );
    },
  );

  it.each([["C0 before restart", "a\x1b[31\t\x07\x9b0\tmb", "| a  b    |"]])(
    "keeps materialized tabs visible after %s CSI restarts",
    (_label, value, expectedRow) => {
      const out = renderTable({
        border: "ascii",
        columns: [{ key: "V", header: "V", minWidth: 9, maxWidth: 9 }],
        rows: [{ V: value }],
      });

      expect(sanitizeForLog(out.split("\n")[3] ?? "")).toBe(expectedRow);
      expect(stripAnsi(out)).not.toContain("\x18");
    },
  );

  it.each([["linked LF", "\n", "\x1b]8;;https://example.com/\x07", "\x1b]8;;\x07"]])(
    "sizes multiline %s headers and cells by their widest line",
    (_label, separator, open, close) => {
      const out = renderTable({
        border: "ascii",
        columns: [
          { key: "A", header: ["abc", "def"].join(separator) },
          { key: "B", header: "B" },
        ],
        rows: [{ A: "x", B: `${open}abc${separator}def${close}` }],
      });

      expect(stripAnsi(out)).toBe(
        [
          "+-----+-----+",
          "| abc | B   |",
          "| def |     |",
          "+-----+-----+",
          "| x   | abc |",
          "|     | def |",
          "+-----+-----+",
          "",
        ].join("\n"),
      );
    },
  );

  it("keeps newlines inside an OSC payload out of table line metrics", () => {
    const open = "\x1b]8;id=line\nmetadata;https://example.com/\x07";
    const close = "\x1b]8;;\x07";
    const out = renderTable({
      border: "ascii",
      columns: [{ key: "V", header: "V" }],
      rows: [{ V: `${open}abc${close}` }],
    });

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
      expect(rendered.lineCount).toBe(shape === "soft-wrap suffix" ? 6 : 150_004);
      expect(rendered.rows).toBe(shape === "soft-wrap suffix" ? 0 : 150_000);
      if (shape === "soft-wrap suffix") {
        expect(rendered.softWrapRowsMatch).toBe(true);
      }
      expect(rendered.header).toMatch(/^\| Key +\|$/u);
      expect(rendered.lastLine).toBe(rendered.firstLine);
    },
  );

  it.each([60])("keeps the plugin-list shape deterministic and within %i columns", (width) => {
    const out = renderPluginListTable(width);
    const lines = out.trimEnd().split("\n");
    const headerCells = (lines[1] ?? "").split("│").slice(1, -1);

    expect(out).toBe(renderPluginListTable(width));
    expect(Math.max(...lines.map(visibleWidth))).toBeLessThanOrEqual(width);
    expect(headerCells).toHaveLength(pluginListColumns.length);
    for (const [index, column] of pluginListColumns.entries()) {
      expect(visibleWidth(headerCells[index] ?? "")).toBeGreaterThanOrEqual(
        visibleWidth(column.header) + 2,
      );
    }
  });

  it("stops flex growth at the cap when a fractional width rounds up", () => {
    const out = renderTable({
      width: 20,
      border: "ascii",
      padding: 0,
      columns: [{ key: "V", header: "V", minWidth: 7.999999999999999, maxWidth: 9, flex: true }],
      rows: [{ V: "x" }],
    });

    expect(out).toBe("+---------+\n|V        |\n+---------+\n|x        |\n+---------+\n");
  });

  it("keeps ANSI styling when a multiline cell wraps after an unstyled line", () => {
    const muted = "\x1b[38;2;120;120;120m";
    const resetForeground = "\x1b[39m";
    const out = renderTable({
      width: 62,
      columns: [
        { key: "Status", header: "Status", minWidth: 10 },
        { key: "Source", header: "Source", minWidth: 24, flex: true },
        { key: "Version", header: "Version", minWidth: 8 },
      ],
      rows: [
        {
          Status: "disabled",
          Source:
            "stock:codex/index.js\n" +
            `${muted}Codex app-server harness and Codex-managed GPT model catalog.${resetForeground}`,
          Version: "2026.5.12-beta.6",
        },
      ],
    });

    const descLines = out
      .split("\n")
      .filter((line) => line.includes("Codex") || line.includes("catalog."));
    expect(descLines.length).toBeGreaterThan(1);
    for (const line of descLines) {
      expect(line).toContain(muted);
      const resetIndex = line.lastIndexOf(resetForeground);
      const lastSep = Math.max(line.lastIndexOf("│"), line.lastIndexOf("|"));
      expect(resetIndex).toBeGreaterThan(-1);
      expect(lastSep).toBeGreaterThan(resetIndex);
    }
  });

  it("keeps intensity active when an RGB color contains zero operands", () => {
    const bold = "\x1b[1m";
    const red = "\x1b[38;2;255;0;0m";
    const reset = "\x1b[0m";
    const out = renderValue(`prefix ${bold}${red}${"a".repeat(80)}${reset}`);

    const styledLines = out.split("\n").filter((line) => line.includes("a"));
    expect(styledLines.length).toBeGreaterThan(1);
    for (const line of styledLines) {
      expect(line).toContain(bold);
      expect(line).toContain(red);
    }
  });

  it.each([["colon", "\x1b[4;58:2::255:0:0m", "\x1b[58:2::255:0:0m"]])(
    "keeps underline color active with %s operands",
    (_label, combined, color) => {
      const underline = "\x1b[4m";
      const globalReset = "\x1b[0m";
      const out = renderValue(`${combined}${"u".repeat(80)}${globalReset}`);

      const styledLines = out.split("\n").filter((line) => line.includes("u"));
      expect(styledLines.length).toBeGreaterThan(1);
      for (const line of styledLines) {
        const hasOpeningState =
          line.includes(combined) || (line.includes(underline) && line.includes(color));
        expect(hasOpeningState).toBe(true);
        const hasClosingState =
          line.includes(globalReset) || (line.includes("\x1b[24m") && line.includes("\x1b[59m"));
        expect(hasClosingState).toBe(true);
      }
    },
  );

  it("keeps unrelated SGR categories after a selective reset", () => {
    const boldRed = "\x1b[1;31m";
    const bold = "\x1b[1m";
    const resetForeground = "\x1b[39m";
    const reset = "\x1b[0m";
    const out = renderValue(`${boldRed}red${resetForeground}\n${"z".repeat(80)}${reset}`);

    const continuationLines = out.split("\n").filter((line) => line.includes("z"));
    expect(continuationLines.length).toBeGreaterThan(1);
    for (const line of continuationLines) {
      expect(line).toContain(bold);
      expect(line).not.toContain(boldRed);
      expect(line).not.toContain("\x1b[31m");
    }
  });

  it("preserves OSC-8 parameters when reopening wrapped links", () => {
    const open = "\x1b]8;id=docs;https://openclaw.ai\x07";
    const close = "\x1b]8;;\x07";
    const out = renderValue(`${open}${"OpenClaw".repeat(5)}${close} after`, 20);

    const linkLines = out.split("\n").filter((line) => line.includes("OpenClaw"));
    expect(linkLines.length).toBeGreaterThan(1);
    for (const line of linkLines) {
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

  it.each([["BEL ST", "\x1b]8;;https://openclaw.ai\x07", "\x1b]8;;\x07"]])(
    "does not reopen a leading OSC-8 link onto wrapped suffix lines (%s)",
    (_label, openSeq, closeSeq) => {
      const link = `${openSeq}OpenClaw${closeSeq}`;
      const out = renderValue(`${link} after`, 20);
      expectIntroducersToStartCompleteSequences(out, openSeq.charAt(0), [openSeq, closeSeq]);

      // "after" wraps onto a continuation line after the link's close. The
      // leading opener must not be prepended to that line, or "after" plus its
      // padding become an unclosed hyperlink that bleeds past the cell border.
      const lines = out.split("\n");
      const afterLines = lines.filter((line) => line.includes("after"));
      expect(afterLines.length).toBeGreaterThan(0);
      for (const line of afterLines) {
        expect(line.includes(openSeq)).toBe(false);
      }
      // The link itself stays intact on the OpenClaw line: open + close present.
      const linkLine = lines.find((line) => line.includes("OpenClaw"));
      expect(linkLine).toBeDefined();
      expect(linkLine?.includes(openSeq)).toBe(true);
      expect(linkLine?.includes(closeSeq)).toBe(true);
    },
  );

  it.each([["colored CRLF", "\r\n", "\x1b[31m", "\x1b[39m"]])(
    "preserves blank %s lines without adding rows after wrapped spacing",
    (_label, separator, open, close) => {
      const out = renderTable({
        border: "ascii",
        width: 15,
        columns: [
          { key: "A", header: "A", minWidth: 6, maxWidth: 6 },
          { key: "B", header: "B", minWidth: 6, maxWidth: 6 },
        ],
        rows: [
          {
            A: `${open}${["", "Read ", "", "Next", "", ""].join(separator)}${close}`,
            B: "0\n1\n2\n3\n4",
          },
        ],
      });

      const dataLines = out.trimEnd().split("\n").slice(3, -1);
      expect(
        dataLines.map((line) =>
          stripAnsi(line)
            .split("|")
            .slice(1, -1)
            .map((cell) => cell.trim()),
        ),
      ).toEqual([
        ["", "0"],
        ["Read", "1"],
        ["", "2"],
        ["Next", "3"],
        ["", "4"],
      ]);
      if (open) {
        for (const line of dataLines) {
          const cell = line.split("|")[1] ?? "";
          expect(cell).toContain(open);
          expect(cell).toContain(close);
        }
      }
    },
  );

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
      const out = renderTable({
        width: 48,
        border: "unicode",
        columns: [
          { key: "A", header: "A", minWidth: 6 },
          { key: "B", header: "B", minWidth: 10, flex: true },
        ],
        rows: [{ A: "row", B: value }],
      });

      const lines = out.trimEnd().split("\n");
      expect(lines).toHaveLength(6);
      for (const line of lines) {
        expect(visibleWidth(line)).toBe(48);
      }
      const dataLines = lines.slice(3, -1);
      expect(
        dataLines.map((line) =>
          sanitizeForLog(line)
            .split("│")
            .slice(1, -1)
            .map((cell) => cell.trim()),
        ),
      ).toEqual([
        ["row", "line1"],
        ["", "東京 line2"],
      ]);
      if (open) {
        for (const line of dataLines.slice(styledStart)) {
          expect(line).toContain(open);
          expect(line).toContain(close);
          expect(line.lastIndexOf(close)).toBeLessThan(line.lastIndexOf("│"));
        }
      }
    },
  );

  it.each([[" /srv/openclaw-home ", path.resolve("/srv/openclaw-home"), "$OPENCLAW_HOME"]])(
    "shortens home paths in table cells for OPENCLAW_HOME=%j",
    (override, home, prefix) => {
      vi.stubEnv("HOME", "/home/other");
      vi.stubEnv("USERPROFILE", "");
      vi.stubEnv("OPENCLAW_HOME", override);

      const out = renderTable({
        border: "none",
        columns: [{ key: "Path", header: "Path" }],
        rows: [
          { Path: home },
          { Path: `${home}/project` },
          { Path: `${home}2/project` },
          { Path: `Workspace: ${home}/project` },
        ],
      });

      expect(out).toContain(`${prefix}\n`);
      expect(out).toContain(`${prefix}/project`);
      expect(out).toContain(`${home}2/project`);
      expect(out).toContain(`Workspace: ${prefix}/project`);
      expect(out).not.toContain(`${prefix}2/project`);
    },
  );

  it("terminates with aligned borders when a flex column starts at its floor", () => {
    const out = renderTable({
      width: 10,
      border: "ascii",
      columns: [
        { key: "A", header: "long header here" },
        { key: "B", header: "", flex: true, maxWidth: 3 },
      ],
      rows: [{ A: "data", B: "📸" }],
    });
    const lines = out.trimEnd().split("\n");
    const headerWidth = visibleWidth(lines[0] ?? "");
    expect(headerWidth).toBeGreaterThan(10);
    for (const line of lines) {
      expect(visibleWidth(line)).toBe(headerWidth);
    }
  });

  it("wraps separately executed CSI tabs with the surrounding text", () => {
    const sequence = "\x1b[31\t\t\tm";
    const out = renderTable({
      width: 7,
      border: "ascii",
      padding: 0,
      columns: [{ key: "V", header: "V", minWidth: 5 }],
      rows: [{ V: `a bbb${sequence}d\x1b[0m` }],
    });

    expect(out).toBe(
      [
        "+-----+",
        "|V    |",
        "+-----+",
        "|a    |",
        "|bbb\x1b[\x18  |",
        "|\x1b[31md\x1b[0m    |",
        "+-----+",
        "",
      ].join("\n"),
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

  it("falls back to ASCII borders on legacy Windows consoles", () => {
    mockProcessPlatform("win32");
    vi.stubEnv("WT_SESSION", "");
    vi.stubEnv("TERM_PROGRAM", "");
    vi.stubEnv("TERM", "vt100");

    const out = renderTable({
      columns: [
        { key: "A", header: "A", minWidth: 6 },
        { key: "B", header: "B", minWidth: 10, flex: true },
      ],
      rows: [{ A: "row", B: "value" }],
    });

    expect(out).toContain("+");
    expect(out).not.toContain("┌");
  });

  it("keeps unicode borders on modern Windows terminals", () => {
    mockProcessPlatform("win32");
    vi.stubEnv("WT_SESSION", "1");
    vi.stubEnv("TERM", "");
    vi.stubEnv("TERM_PROGRAM", "");

    const out = renderTable({
      columns: [
        { key: "A", header: "A", minWidth: 6 },
        { key: "B", header: "B", minWidth: 10, flex: true },
      ],
      rows: [{ A: "row", B: "value" }],
    });

    expect(out).toContain("┌");
    expect(out).not.toContain("+");
  });
});
