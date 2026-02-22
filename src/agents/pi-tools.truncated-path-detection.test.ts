import { describe, expect, it } from "vitest";

// Test the truncation detection heuristic patterns directly.
// The actual assertPathIntegrity function is internal, but we validate
// the detection logic matches expected behavior.
// See: https://github.com/openclaw/openclaw/issues/23622

const VALID_SINGLE_CHAR_EXTENSIONS = new Set(["c", "h", "r", "R", "d", "v", "o", "a", "s", "S"]);

function detectTruncatedPath(filePath: string): boolean {
  if (typeof filePath !== "string" || !filePath.trim()) {
    return false;
  }
  if (/,\s*$/.test(filePath)) {
    return true;
  }
  const basename = filePath.split("/").pop() ?? filePath;
  const singleCharExtMatch = basename.match(/\.([a-zA-Z])$/);
  if (singleCharExtMatch) {
    const ext = singleCharExtMatch[1];
    if (!VALID_SINGLE_CHAR_EXTENSIONS.has(ext)) {
      return true;
    }
  }
  return false;
}

describe("detectTruncatedPath", () => {
  describe("valid paths (should NOT be flagged)", () => {
    const cases = [
      "/some/path/README.md",
      "/some/path/file.ts",
      "/some/path/image.png",
      "/some/path/Makefile",
      "/some/path/.gitignore",
      "/some/path/no-extension",
      "relative/path/file.py",
      "./local.json",
      "/a/b/c.rb",
      "/path/to/file.go",
      // Legitimate single-char extensions
      "/path/to/main.c",
      "/path/to/header.h",
      "/path/to/analysis.R",
      "/path/to/module.d",
      "/path/to/circuit.v",
      "/path/to/lib.a",
      "/path/to/boot.S",
    ];

    for (const p of cases) {
      it(`accepts: ${p}`, () => {
        expect(detectTruncatedPath(p)).toBe(false);
      });
    }
  });

  describe("truncated paths (SHOULD be flagged)", () => {
    const cases = [
      // Single-char non-valid extensions (likely truncated)
      ["/some/path/xiaohongshu-to-douyin/README.m", ".md truncated to .m"],
      ["/some/path/file.t", ".ts/.tsx truncated to .t"],
      ["/some/path/file.j", ".js/.json truncated to .j"],
      ["/some/path/file.p", ".py/.php truncated to .p"],
      ["/some/path/component.x", ".tsx/.xml truncated to .x"],
      // JSON structure leaked into path value
      ["/some/path/README.m, ", "comma from JSON leaked in"],
      ["/some/path/file.t,", "comma from JSON leaked in"],
      ["/path/to/file.md, ", "even valid extension with trailing comma"],
    ];

    for (const [p, reason] of cases) {
      it(`detects: ${p} (${reason})`, () => {
        expect(detectTruncatedPath(p)).toBe(true);
      });
    }
  });

  describe("edge cases", () => {
    it("handles empty string", () => {
      expect(detectTruncatedPath("")).toBe(false);
    });

    it("handles whitespace-only string", () => {
      expect(detectTruncatedPath("   ")).toBe(false);
    });

    it("handles path with only a dot", () => {
      expect(detectTruncatedPath(".")).toBe(false);
    });

    it("handles dotfile without extension", () => {
      expect(detectTruncatedPath("/path/.env")).toBe(false);
    });
  });
});
