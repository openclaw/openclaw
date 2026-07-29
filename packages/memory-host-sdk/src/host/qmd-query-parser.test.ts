// Memory Host SDK tests cover qmd query parser behavior.
import { describe, expect, it, vi } from "vitest";
import { parseQmdQueryJson } from "./qmd-query-parser.js";

describe("parseQmdQueryJson", () => {
  it("parses clean qmd JSON output", () => {
    const results = parseQmdQueryJson('[{"docid":"abc","score":1,"snippet":"@@ -1,1\\none"}]', "");
    expect(results).toEqual([
      {
        docid: "abc",
        score: 1,
        snippet: "@@ -1,1\none",
      },
    ]);
  });

  it("preserves valid result objects and their order while dropping malformed entries", () => {
    expect(
      parseQmdQueryJson(
        JSON.stringify([
          null,
          "noise",
          1,
          [{ docid: "nested", score: 1 }],
          { docid: "first", score: 0.8, start_line: 3, end_line: 4 },
          false,
          { docid: "second", score: 0.6, snippet: "second hit" },
        ]),
        "",
      ),
    ).toEqual([
      { docid: "first", score: 0.8, startLine: 3, endLine: 4 },
      { docid: "second", score: 0.6, snippet: "second hit" },
    ]);
  });

  it.each([
    { name: "null", entries: [null] },
    { name: "a string", entries: ["noise"] },
    { name: "a number", entries: [1] },
    { name: "a boolean", entries: [false] },
    { name: "a nested array", entries: [[{ docid: "nested", score: 1 }]] },
    { name: "mixed malformed values", entries: [null, "noise", 1, false, ["nested"]] },
  ])("rejects a nonempty result array containing only $name", ({ entries }) => {
    expect(() => parseQmdQueryJson(JSON.stringify(entries), "")).toThrow(
      /qmd query returned invalid JSON/i,
    );
  });

  it("preserves empty result arrays and valid result objects without optional fields", () => {
    expect(parseQmdQueryJson("[]", "")).toStrictEqual([]);
    expect(parseQmdQueryJson("[{}]", "")).toEqual([{}]);
  });

  it("extracts embedded result arrays from noisy stdout", () => {
    const results = parseQmdQueryJson(
      `initializing
{"payload":"ok"}
[{"docid":"abc","score":0.5}]
complete`,
      "",
    );
    expect(results).toEqual([{ docid: "abc", score: 0.5 }]);
  });

  it("skips a malformed standalone array before a valid noisy result array", () => {
    expect(
      parseQmdQueryJson(
        'initializing\n[null, "noise", 1, ["nested"]]\n[{"docid":"abc","score":0.5}]',
        "",
      ),
    ).toEqual([{ docid: "abc", score: 0.5 }]);
  });

  it.each([
    {
      name: "bracketed log prefix",
      stdout: '[qmd] initializing search\n[{"docid":"abc","score":0.5}]',
    },
    {
      name: "bracketed log with an empty array",
      stdout: '[qmd] filters=[]\n[{"docid":"abc","score":0.5}]',
    },
    {
      name: "bracketed log with result-shaped data",
      stdout: '[qmd] previous=[{"docid":"stale","score":1}]\n[{"docid":"abc","score":0.5}]',
    },
    {
      name: "leading no-results marker",
      stdout: 'warning: no results found\n[{"docid":"abc","score":0.5}]',
    },
    {
      name: "trailing no-results marker",
      stdout: '[{"docid":"abc","score":0.5}]\nwarning: no results found',
    },
    {
      name: "bracketed no-results marker",
      stdout: '[qmd] warning: no results found\n[{"docid":"abc","score":0.5}]',
    },
  ])("preserves query results after a $name", ({ stdout }) => {
    expect(parseQmdQueryJson(stdout, "")).toEqual([{ docid: "abc", score: 0.5 }]);
  });

  it("preserves explicit qmd line metadata when present", () => {
    const results = parseQmdQueryJson(
      '[{"docid":"abc","score":0.5,"start_line":4,"end_line":6,"snippet":"@@ -10,1\\nignored"}]',
      "",
    );
    expect(results).toEqual([
      {
        docid: "abc",
        score: 0.5,
        snippet: "@@ -10,1\nignored",
        startLine: 4,
        endLine: 6,
      },
    ]);
  });

  it("drops non-integer qmd line metadata", () => {
    const results = parseQmdQueryJson(
      `[{"docid":"abc","start_line":4.5,"end_line":${Number.MAX_SAFE_INTEGER + 1}}]`,
      "",
    );

    expect(results).toEqual([{ docid: "abc" }]);
  });

  it("treats plain-text no-results from stderr as an empty result set", () => {
    const results = parseQmdQueryJson("", "No results found\n");
    expect(results).toStrictEqual([]);
  });

  it("treats prefixed no-results marker output as an empty result set", () => {
    expect(parseQmdQueryJson("warning: no results found", "")).toStrictEqual([]);
    expect(parseQmdQueryJson("", "[qmd] warning: no results found\n")).toStrictEqual([]);
    expect(
      parseQmdQueryJson("[qmd] initializing search\nwarning: no results found", ""),
    ).toStrictEqual([]);
  });

  it("keeps bounded stderr context UTF-16 safe", () => {
    const prefix = "a".repeat(116);
    const stderr = `${prefix}😀${"b".repeat(120)}`;

    expect(() => parseQmdQueryJson("", stderr)).toThrow(
      `qmd query returned invalid JSON: stdout empty (stderr: ${prefix}...)`,
    );
  });

  it("does not treat arbitrary non-marker text as no-results output", () => {
    expect(() =>
      parseQmdQueryJson("warning: search completed; no results found for this query", ""),
    ).toThrow(/qmd query returned invalid JSON/i);
  });

  it("throws when stdout cannot be interpreted as qmd JSON", () => {
    expect(() => parseQmdQueryJson("this is not json", "")).toThrow(
      /qmd query returned invalid JSON/i,
    );
  });

  it("rejects malformed bracket-heavy stdout without repeated rescanning", () => {
    expect(() => parseQmdQueryJson("[".repeat(4_096), "")).toThrow(
      /qmd query returned invalid JSON/i,
    );
  });

  it("routes invalid-output diagnostics through console capture", () => {
    vi.stubEnv("VITEST", "");
    vi.stubEnv("NODE_ENV", "production");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    try {
      expect(() => parseQmdQueryJson("this is not json", "")).toThrow(
        /qmd query returned invalid JSON/i,
      );
      expect(warn).toHaveBeenCalledWith(
        "qmd query returned invalid JSON: qmd query JSON response was not an array",
      );
    } finally {
      warn.mockRestore();
      vi.unstubAllEnvs();
    }
  });
});
