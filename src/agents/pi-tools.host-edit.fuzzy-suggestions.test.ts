/**
 * Tests for edit tool fuzzy match suggestions: when oldText is not found in the file,
 * the wrapper enriches the error with the closest matching regions (line numbers +
 * similarity scores) so the model can self-correct in one shot.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  lcsLength,
  lcsRatio,
  scoreWindows,
  wrapEditToolWithFuzzyMatchSuggestions,
} from "./pi-tools.host-edit.js";
import type { AnyAgentTool } from "./pi-tools.types.js";

// ─── Helpers ───

function makeMockTool(behavior: "success" | "not-found" | "other-error"): AnyAgentTool {
  return {
    name: "edit",
    description: "mock edit tool",
    schema: { type: "object" as const, properties: {} },
    execute: async (_toolCallId: string, params: unknown) => {
      if (behavior === "success") {
        return { content: [{ type: "text", text: "OK" }], details: {} };
      }
      const record = params as Record<string, unknown>;
      if (behavior === "not-found") {
        throw new Error(
          `Could not find the exact text in ${String(record.path)}. The old text must match exactly.`,
        );
      }
      throw new Error("File not found: /no/such/file");
    },
  } as unknown as AnyAgentTool;
}

// ─── lcsLength tests ───

describe("lcsLength", () => {
  it("returns 0 for empty strings", () => {
    expect(lcsLength("", "")).toBe(0);
    expect(lcsLength("abc", "")).toBe(0);
    expect(lcsLength("", "abc")).toBe(0);
  });

  it("returns full length for identical strings", () => {
    expect(lcsLength("hello", "hello")).toBe(5);
  });

  it("finds common subsequence for different strings", () => {
    // LCS of "abc" and "axbxc" is "abc" = 3
    expect(lcsLength("abc", "axbxc")).toBe(3);
  });

  it("returns 0 for completely different strings", () => {
    expect(lcsLength("abc", "xyz")).toBe(0);
  });
});

// ─── lcsRatio tests ───

describe("lcsRatio", () => {
  it("returns 1.0 for identical strings", () => {
    expect(lcsRatio("hello world", "hello world")).toBe(1.0);
  });

  it("returns 1.0 for two empty strings", () => {
    expect(lcsRatio("", "")).toBe(1.0);
  });

  it("returns 0.0 when one string is empty", () => {
    expect(lcsRatio("abc", "")).toBe(0.0);
    expect(lcsRatio("", "abc")).toBe(0.0);
  });

  it("returns 0.0 for completely different strings", () => {
    expect(lcsRatio("abc", "xyz")).toBe(0.0);
  });

  it("returns value between 0 and 1 for partially similar strings", () => {
    const ratio = lcsRatio("function handleClick(event)", "function handleTouch(event)");
    expect(ratio).toBeGreaterThan(0.5);
    expect(ratio).toBeLessThan(1.0);
  });
});

// ─── scoreWindows tests ───

describe("scoreWindows", () => {
  it("returns empty array for empty inputs", () => {
    expect(scoreWindows([], ["hello"])).toEqual([]);
    expect(scoreWindows(["hello"], [])).toEqual([]);
    expect(scoreWindows([], [])).toEqual([]);
  });

  it("finds exact match with score ~1.0", () => {
    const fileLines = ["line 1", "function foo() {", "  return 42;", "}", "line 5"];
    const oldTextLines = ["function foo() {", "  return 42;", "}"];
    const results = scoreWindows(fileLines, oldTextLines);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].score).toBeGreaterThan(0.95);
    expect(results[0].startLine).toBe(2);
    expect(results[0].endLine).toBe(4);
  });

  it("finds near-match with minor differences", () => {
    const fileLines = [
      "function handleClick(event: MouseEvent) {",
      "  const target = event.target as HTMLElement;",
      '  if (target.classList.contains("selected")) {',
      "    target.remove();",
      "  }",
      "}",
    ];
    const oldTextLines = [
      "function handleClick(event: MouseEvent) {",
      "  const target = event.target as HTMLElement;",
      '  if (target.classList.contains("active")) {', // different
      "    target.remove();",
      "  }",
      "}",
    ];
    const results = scoreWindows(fileLines, oldTextLines);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].score).toBeGreaterThan(0.8);
    expect(results[0].startLine).toBe(1);
  });

  it("keeps multi-line near-matches when only the line prefixes changed", () => {
    const fileLines = [
      "let primaryValue = computeResult(input);",
      "let fallbackValue = sanitize(primaryValue);",
    ];
    const oldTextLines = [
      "const primaryValue = computeResult(input);",
      "const fallbackValue = sanitize(primaryValue);",
    ];
    const results = scoreWindows(fileLines, oldTextLines);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].startLine).toBe(1);
    expect(results[0].score).toBeGreaterThan(0.7);
  });

  it("returns empty when content is completely different", () => {
    const fileLines = ["alpha", "bravo", "charlie", "delta"];
    const oldTextLines = ["xylophone", "yesterday", "zebra"];
    const results = scoreWindows(fileLines, oldTextLines);
    expect(results).toEqual([]);
  });

  it("returns at most 3 suggestions", () => {
    // Create a file with 5 similar functions
    const fileLines: string[] = [];
    for (let i = 0; i < 5; i++) {
      fileLines.push(`function handler${i}(event) {`, `  console.log(event);`, `}`, "");
    }
    const oldTextLines = ["function handlerX(event) {", "  console.log(event);", "}"];
    const results = scoreWindows(fileLines, oldTextLines);
    expect(results.length).toBeLessThanOrEqual(3);
  });

  it("finds match when only indentation differs (review feedback: pre-filter trims leading whitespace)", () => {
    // The pre-filter must trim leading whitespace so indentation mismatches
    // (the most common edit failure) are not rejected by the 8-char prefix check.
    const fileLines = ["    function indented() {", "        return true;", "    }"];
    const oldTextLines = ["  function indented() {", "      return true;", "  }"];
    const results = scoreWindows(fileLines, oldTextLines);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].startLine).toBe(1);
    expect(results[0].score).toBeGreaterThan(0.8);
  });

  it("keeps short multi-line near-matches for LCS scoring", () => {
    const fileLines = ["let x", "ok"];
    const oldTextLines = ["const x", "on"];
    const results = scoreWindows(fileLines, oldTextLines);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].startLine).toBe(1);
    expect(results[0].score).toBeGreaterThan(0.4);
  });

  it("handles single-line oldText", () => {
    const fileLines = ["const foo = 1;", "const bar = 2;", "const baz = 3;"];
    const oldTextLines = ["const bar = 22;"];
    const results = scoreWindows(fileLines, oldTextLines);
    expect(results.length).toBeGreaterThan(0);
    // Best match should be the line "const bar = 2;" (line 2)
    expect(results[0].startLine).toBe(2);
  });

  it("skips the pre-filter for single-line oldText with renamed prefixes", () => {
    const fileLines = ["let renderedOutput = formatResult(payload);", "const somethingElse = 1;"];
    const oldTextLines = ["const renderedOutput = formatResult(payload);"];
    const results = scoreWindows(fileLines, oldTextLines);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].startLine).toBe(1);
    expect(results[0].score).toBeGreaterThan(0.8);
  });

  it("collects all near-perfect windows before sorting the top matches", () => {
    const oldTextLines = ["const stableIdentifier = formatResult(payload);"];
    const fileLines = [
      "const stableIdentifier = formatResult(payload)",
      "doSomethingElse();",
      "const stableIdentifier = formatResult(payload);",
      "doSomethingElseAgain();",
      "const stableIdentifier = formatResult(payload)?",
    ];

    const results = scoreWindows(fileLines, oldTextLines);

    expect(results.map((result) => result.startLine)).toEqual([3, 1, 5]);
    expect(results.map((result) => result.score)).toEqual(
      expect.arrayContaining([expect.any(Number), expect.any(Number), expect.any(Number)]),
    );
    expect(results[0]?.score).toBeGreaterThan(results[1]?.score ?? 0);
    expect(results[1]?.score).toBeGreaterThan(results[2]?.score ?? 0);
  });
});

// ─── Wrapper integration tests ───

describe("wrapEditToolWithFuzzyMatchSuggestions", () => {
  let tmpDir = "";

  afterEach(async () => {
    if (tmpDir) {
      await fs.rm(tmpDir, { recursive: true, force: true });
      tmpDir = "";
    }
  });

  it("passes through successful results unchanged", async () => {
    const base = makeMockTool("success");
    const wrapped = wrapEditToolWithFuzzyMatchSuggestions(base, "/tmp");
    const result = await wrapped.execute(
      "call-1",
      { path: "test.ts", oldText: "x", newText: "y" },
      undefined,
    );
    const content = (result as { content: Array<{ text?: string }> }).content;
    expect(content[0]?.text).toBe("OK");
  });

  it("passes through non-not-found errors unchanged", async () => {
    const base = makeMockTool("other-error");
    const wrapped = wrapEditToolWithFuzzyMatchSuggestions(base, "/tmp");
    await expect(
      wrapped.execute("call-1", { path: "test.ts", oldText: "x", newText: "y" }, undefined),
    ).rejects.toThrow("File not found");
  });

  it("enriches not-found error with fuzzy suggestions", async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-fuzzy-"));
    const filePath = path.join(tmpDir, "test.ts");
    await fs.writeFile(
      filePath,
      ["function greet(name: string) {", "  return `Hello, ${name}!`;", "}"].join("\n"),
      "utf-8",
    );

    const base = makeMockTool("not-found");
    const wrapped = wrapEditToolWithFuzzyMatchSuggestions(base, tmpDir);

    try {
      await wrapped.execute(
        "call-1",
        {
          path: filePath,
          oldText: "function greet(name: string) {\n  return `Hi, ${name}!`;\n}",
          newText: "replaced",
        },
        undefined,
      );
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
      const msg = (err as Error).message;
      expect(msg).toContain("most similar region");
      expect(msg).toContain("similarity:");
      expect(msg).toMatch(/Lines \d+-\d+/);
      expect(msg).toContain("Hint:");
    }
  });

  it("handles binary files gracefully", async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-fuzzy-"));
    const filePath = path.join(tmpDir, "binary.dat");
    const buf = Buffer.alloc(100);
    buf[50] = 0; // null byte
    buf.write("some text", 0);
    await fs.writeFile(filePath, buf);

    const base = makeMockTool("not-found");
    const wrapped = wrapEditToolWithFuzzyMatchSuggestions(base, tmpDir);

    await expect(
      wrapped.execute(
        "call-1",
        { path: filePath, oldText: "some text", newText: "replaced" },
        undefined,
      ),
    ).rejects.toThrow("appears to be binary");
  });

  it("handles large files by skipping fuzzy match", async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-fuzzy-"));
    const filePath = path.join(tmpDir, "large.ts");
    // Create a file > 100KB
    const largeLine = "x".repeat(200) + "\n";
    await fs.writeFile(filePath, largeLine.repeat(600), "utf-8");

    const base = makeMockTool("not-found");
    const wrapped = wrapEditToolWithFuzzyMatchSuggestions(base, tmpDir);

    await expect(
      wrapped.execute(
        "call-1",
        { path: filePath, oldText: "not here", newText: "replaced" },
        undefined,
      ),
    ).rejects.toThrow(/Fuzzy matching skipped for performance/);
  });

  it("handles old_string param alias", async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-fuzzy-"));
    const filePath = path.join(tmpDir, "test.ts");
    await fs.writeFile(filePath, "const x = 1;\n", "utf-8");

    const base = makeMockTool("not-found");
    const wrapped = wrapEditToolWithFuzzyMatchSuggestions(base, tmpDir);

    try {
      await wrapped.execute(
        "call-1",
        { path: filePath, old_string: "const x = 2;", new_string: "replaced" },
        undefined,
      );
      expect.unreachable("should have thrown");
    } catch (err) {
      const msg = (err as Error).message;
      // Should have enriched the error (not the raw "not found" from upstream)
      expect(msg).toContain("most similar region");
    }
  });

  it("falls back to no-similar-regions message when file has unrelated content", async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-fuzzy-"));
    const filePath = path.join(tmpDir, "test.ts");
    await fs.writeFile(filePath, "alpha\nbravo\ncharlie\ndelta\n", "utf-8");

    const base = makeMockTool("not-found");
    const wrapped = wrapEditToolWithFuzzyMatchSuggestions(base, tmpDir);

    try {
      await wrapped.execute(
        "call-1",
        { path: filePath, oldText: "xylophone\nyesterday\nzebra", newText: "replaced" },
        undefined,
      );
      expect.unreachable("should have thrown");
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).toContain("No similar regions found");
      expect(msg).toContain("re-reading the file");
    }
  });

  it("finds multiple similar regions ranked by score", async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-fuzzy-"));
    const filePath = path.join(tmpDir, "handlers.ts");
    await fs.writeFile(
      filePath,
      [
        "function handleClick(event: MouseEvent) {",
        "  event.preventDefault();",
        "}",
        "",
        "function handleHover(event: MouseEvent) {",
        "  event.stopPropagation();",
        "}",
        "",
        "function handleScroll(event: WheelEvent) {",
        "  event.preventDefault();",
        "}",
      ].join("\n"),
      "utf-8",
    );

    const base = makeMockTool("not-found");
    const wrapped = wrapEditToolWithFuzzyMatchSuggestions(base, tmpDir);

    try {
      await wrapped.execute(
        "call-1",
        {
          path: filePath,
          oldText: "function handleClick(event: MouseEvent) {\n  event.preventDefault();\n}",
          newText: "replaced",
        },
        undefined,
      );
      expect.unreachable("should have thrown");
    } catch (err) {
      const msg = (err as Error).message;
      // Should find the exact match at lines 1-3 plus similar blocks
      expect(msg).toContain("Lines 1-3");
      expect(msg).toContain("similarity:");
    }
  });

  it("rethrows original error when file does not exist (review feedback: FS errors don't mask not-found)", async () => {
    // When the fallback file read fails (e.g. ENOENT race), the wrapper must
    // rethrow the original "not found" error, not the FS error.
    const base = makeMockTool("not-found");
    const wrapped = wrapEditToolWithFuzzyMatchSuggestions(base, "/nonexistent/path");

    try {
      await wrapped.execute(
        "call-1",
        { path: "missing.ts", oldText: "some text", newText: "replaced" },
        undefined,
      );
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
      const msg = (err as Error).message;
      // Must be the original "not found" error, not ENOENT
      expect(msg).toContain("Could not find the exact text in");
      expect(msg).not.toContain("ENOENT");
    }
  });

  it("uses fs.stat before reading file (review feedback: no full read before size check)", async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-fuzzy-"));
    const filePath = path.join(tmpDir, "large.ts");
    // Create a file > 100KB
    const largeLine = "x".repeat(200) + "\n";
    await fs.writeFile(filePath, largeLine.repeat(600), "utf-8");

    const base = makeMockTool("not-found");
    const wrapped = wrapEditToolWithFuzzyMatchSuggestions(base, tmpDir);

    try {
      await wrapped.execute(
        "call-1",
        { path: filePath, oldText: "not here", newText: "replaced" },
        undefined,
      );
      expect.unreachable("should have thrown");
    } catch (err) {
      const msg = (err as Error).message;
      // Must mention performance skip, proving stat() was checked before read
      expect(msg).toContain("Fuzzy matching skipped for performance");
      expect(msg).toContain("File is large");
    }
  });

  it("handles ~ path expansion", async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-fuzzy-"));
    const filePath = path.join(tmpDir, "test.ts");
    await fs.writeFile(
      filePath,
      "const greeting = 'hello world';\nconst farewell = 'goodbye world';\n",
      "utf-8",
    );

    // Use absolute path directly (~ expansion tested via resolveHostEditPath internal)
    const base = makeMockTool("not-found");
    const wrapped = wrapEditToolWithFuzzyMatchSuggestions(base, tmpDir);

    try {
      await wrapped.execute(
        "call-1",
        { path: filePath, oldText: "const greeting = 'hello earth';", newText: "replaced" },
        undefined,
      );
      expect.unreachable("should have thrown");
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).toContain("most similar region");
    }
  });
});
