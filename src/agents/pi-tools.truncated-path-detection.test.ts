import { describe, expect, it } from "vitest";
import { detectTruncatedPath, VALID_SINGLE_CHAR_EXTENSIONS } from "./pi-tools.read.js";

describe("detectTruncatedPath", () => {
  // --- Should NOT flag (valid paths) ---
  it.each([
    "src/main.ts",
    "README.md",
    "package.json",
    "src/index.js",
    "Makefile",
    ".gitignore",
    "src/foo.cpp",
    "src/bar.py",
    "",
    "   ",
  ])("returns undefined for valid path %j", (p) => {
    expect(detectTruncatedPath(p)).toBeUndefined();
  });

  // --- Legitimate single-char extensions ---
  it.each([...VALID_SINGLE_CHAR_EXTENSIONS])(
    "returns undefined for valid single-char extension %s",
    (ext) => {
      expect(detectTruncatedPath(`src/foo${ext}`)).toBeUndefined();
    },
  );

  // --- Should flag: suspicious single-char extensions ---
  it.each([
    [".t", "truncated .ts/.txt"],
    [".p", "truncated .py/.php"],
    [".x", "truncated .xml/.xlsx"],
    [".y", "truncated .yml/.yaml"],
  ])("flags single-char extension %s (%s)", (ext) => {
    const result = detectTruncatedPath(`src/foo${ext}`);
    expect(result).toBeDefined();
    expect(result).toContain("truncated");
  });

  // --- Should flag: leaked JSON structure ---
  it.each(["README.md, ", "src/foo.ts,", "package.json,  "])(
    "flags leaked JSON comma in %j",
    (p) => {
      const result = detectTruncatedPath(p);
      expect(result).toBeDefined();
      expect(result).toContain("trailing comma");
    },
  );

  // --- Edge cases ---
  it("handles dotfiles without extension", () => {
    expect(detectTruncatedPath(".gitignore")).toBeUndefined();
  });

  it("handles paths with no extension", () => {
    expect(detectTruncatedPath("Makefile")).toBeUndefined();
  });

  it("handles deeply nested paths", () => {
    expect(detectTruncatedPath("a/b/c/d/e/f.ts")).toBeUndefined();
  });

  it("flags deeply nested truncated path", () => {
    const result = detectTruncatedPath("a/b/c/d/e/f.t");
    expect(result).toBeDefined();
    expect(result).toContain("truncated");
  });
});
