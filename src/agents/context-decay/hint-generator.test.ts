import { describe, expect, it } from "vitest";
import { generateHeuristicHint } from "./hint-generator.js";

describe("generateHeuristicHint", () => {
  describe("file read tools", () => {
    it("generates hint for TypeScript file read", () => {
      const hint = generateHeuristicHint({
        toolName: "Read",
        args: '"/src/utils.ts"',
        content: 'export function resolveUserPath(input: string): string {\n  return input.trim();\n}\n\nexport function formatDuration(ms: number): string {\n  return `${ms}ms`;\n}',
      });
      expect(hint).toContain("TypeScript");
      expect(hint).toContain("lines");
      expect(hint).toContain("resolveUserPath");
    });

    it("detects Python language from args", () => {
      const hint = generateHeuristicHint({
        toolName: "Read",
        args: '"app/main.py"',
        content: "def main():\n    print('hello')\n",
      });
      expect(hint).toContain("Python");
    });

    it("handles file read with no exports", () => {
      const hint = generateHeuristicHint({
        toolName: "Read",
        args: '"config.json"',
        content: '{\n  "key": "value"\n}',
      });
      expect(hint).toContain("JSON");
      expect(hint).toContain("3 lines");
    });
  });

  describe("search tools", () => {
    it("generates hint for grep results", () => {
      const hint = generateHeuristicHint({
        toolName: "Grep",
        args: '"resolveUserPath"',
        content: "/src/utils.ts:236:export function resolveUserPath\n/src/compact.ts:42:  resolveUserPath(input)\n/tests/utils.test.ts:10:  resolveUserPath\n",
      });
      expect(hint).toContain("result lines");
      expect(hint).toContain("/src/utils.ts");
    });

    it("generates hint for glob results", () => {
      const hint = generateHeuristicHint({
        toolName: "Glob",
        args: '"**/*.test.ts"',
        content: "/src/foo.test.ts\n/src/bar.test.ts\n",
      });
      expect(hint).toContain("result lines");
      expect(hint).toContain("Files:");
    });
  });

  describe("exec tools", () => {
    it("generates hint for bash output with exit code", () => {
      const hint = generateHeuristicHint({
        toolName: "Bash",
        args: '"npm test"',
        content: "Running tests...\nTest 1 passed\nTest 2 passed\nAll tests passed\nexit code: 0\n",
      });
      expect(hint).toContain("exit 0");
      expect(hint).toContain("lines");
    });

    it("generates hint for bash output without exit code", () => {
      const hint = generateHeuristicHint({
        toolName: "Bash",
        args: '"ls"',
        content: "file1.ts\nfile2.ts\nfile3.ts\n",
      });
      expect(hint).toContain("lines");
      expect(hint).toContain("file1.ts");
    });
  });

  describe("default tool", () => {
    it("generates hint for unknown tool", () => {
      const hint = generateHeuristicHint({
        toolName: "CustomTool",
        args: '{}',
        content: "Some result content\nwith multiple lines\nand more data\n",
      });
      expect(hint).toContain("lines");
      expect(hint).toContain("chars");
    });

    it("includes error messages when present", () => {
      const hint = generateHeuristicHint({
        toolName: "CustomTool",
        args: '{}',
        content: "Error: file not found\nfailed to read config\n",
      });
      expect(hint).toContain("Errors:");
    });
  });

  describe("truncation", () => {
    it("truncates hint to maxHintChars", () => {
      const hint = generateHeuristicHint({
        toolName: "Read",
        args: '"file.ts"',
        content: "a".repeat(10000),
        maxHintChars: 50,
      });
      expect(hint.length).toBeLessThanOrEqual(50);
      expect(hint.endsWith("...")).toBe(true);
    });
  });
});
