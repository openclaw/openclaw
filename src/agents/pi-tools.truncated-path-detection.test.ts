import { describe, expect, it } from "vitest";
import { detectTruncatedPath } from "./pi-tools.read.js";

// Test the truncation detection heuristic used to catch file paths
// corrupted by partial JSON streaming.
// See: https://github.com/openclaw/openclaw/issues/23622

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
      "/path/to/ViewController.m",
      "/path/to/analysis.R",
      "/path/to/module.d",
      "/path/to/circuit.v",
      "/path/to/lib.a",
      "/path/to/boot.S",
      "/path/to/program.f",
      "/path/to/lexer.l",
      "/path/to/code.p",
      "/path/to/test.t",
      "/path/to/parser.y",
    ];

    for (const p of cases) {
      it(`accepts: ${p}`, () => {
        expect(detectTruncatedPath(p)).toBe(false);
      });
    }
  });

  describe("truncated paths (SHOULD be flagged)", () => {
    const cases: Array<[string, string]> = [
      // Single-char non-valid extensions (likely truncated)
      ["/some/path/xiaohongshu-to-douyin/README.b", ".bin truncated to .b"],
      ["/some/path/file.j", ".js/.json truncated to .j"],
      ["/some/path/file.x", ".tsx/.xml truncated to .x"],
      ["/some/path/component.g", ".go truncated to .g"],
      ["/some/path/file.w", ".wasm truncated to .w"],
      // JSON structure leaked into path value
      ["/some/path/README.m, ", "comma from JSON leaked in"],
      ["/some/path/file.ts,", "comma from JSON leaked in"],
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
