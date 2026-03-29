import { describe, expect, it, vi } from "vitest";
import { wrapEditToolWithRecovery } from "./pi-tools.host-edit.js";
import type { AnyAgentTool } from "./pi-tools.types.js";

function createMockEditTool(errorMessage: string): AnyAgentTool {
  return {
    name: "edit",
    label: "edit",
    description: "test edit tool",
    parameters: {},
    execute: vi.fn(async () => {
      throw new Error(errorMessage);
    }),
  } as unknown as AnyAgentTool;
}

describe("edit tool fuzzy match hint", () => {
  it("shows best matching region when oldText partially matches", async () => {
    const fileContent = [
      "function hello() {",
      '  console.log("hello");',
      '  console.log("world");',
      "}",
      "",
      "function goodbye() {",
      '  console.log("goodbye");',
      "}",
    ].join("\n");

    const base = createMockEditTool("Could not find the exact text in test.ts");
    const wrapped = wrapEditToolWithRecovery(base, {
      root: "/tmp",
      readFile: async () => fileContent,
    });

    const error = await wrapped
      .execute(
        "call-1",
        {
          path: "test.ts",
          // Slightly wrong oldText — extra space before console.log
          oldText: 'function hello() {\n   console.log("hello");\n  console.log("world");\n}',
          newText: "replacement",
        },
        undefined,
      )
      .catch((e: Error) => e);

    expect(error).toBeInstanceOf(Error);
    const msg = (error as Error).message;
    expect(msg).toContain("Best matching region");
    expect(msg).toContain("near line");
    expect(msg).toContain("similar");
    expect(msg).toContain("Hint:");
  });

  it("falls back to file contents when no similar region found", async () => {
    const fileContent = "alpha bravo charlie\ndelta echo foxtrot\n";

    const base = createMockEditTool("Could not find the exact text in test.ts");
    const wrapped = wrapEditToolWithRecovery(base, {
      root: "/tmp",
      readFile: async () => fileContent,
    });

    const error = await wrapped
      .execute(
        "call-1",
        {
          path: "test.ts",
          oldText: "zzz yyy xxx www\nvvv uuu ttt sss\nrrr qqq ppp ooo",
          newText: "replacement",
        },
        undefined,
      )
      .catch((e: Error) => e);

    expect(error).toBeInstanceOf(Error);
    const msg = (error as Error).message;
    expect(msg).toContain("Current file contents:");
    expect(msg).toContain("alpha bravo charlie");
  });

  it("finds single-line partial match via substring", async () => {
    const fileContent = [
      "import { foo } from './foo';",
      "import { bar } from './bar';",
      "",
      "export function main() {",
      "  return foo() + bar();",
      "}",
    ].join("\n");

    const base = createMockEditTool("Could not find the exact text in main.ts");
    const wrapped = wrapEditToolWithRecovery(base, {
      root: "/tmp",
      readFile: async () => fileContent,
    });

    const error = await wrapped
      .execute(
        "call-1",
        {
          path: "main.ts",
          // Model wrote the import without quotes matching
          oldText: "return foo() + bar()",
          newText: "return foo() * bar()",
        },
        undefined,
      )
      .catch((e: Error) => e);

    expect(error).toBeInstanceOf(Error);
    const msg = (error as Error).message;
    expect(msg).toContain("Best matching region");
    expect(msg).toContain("line 5");
  });

  it("includes line numbers in the snippet", async () => {
    const lines = Array.from({ length: 50 }, (_, i) => `line ${i + 1} content`);
    const fileContent = lines.join("\n");

    const base = createMockEditTool("Could not find the exact text in big.ts");
    const wrapped = wrapEditToolWithRecovery(base, {
      root: "/tmp",
      readFile: async () => fileContent,
    });

    const error = await wrapped
      .execute(
        "call-1",
        {
          path: "big.ts",
          // Multi-line oldText that partially matches around line 30
          oldText: "line 30 content\nline 31 WRONG\nline 32 content",
          newText: "replacement",
        },
        undefined,
      )
      .catch((e: Error) => e);

    expect(error).toBeInstanceOf(Error);
    const msg = (error as Error).message;
    // Should contain numbered lines in the snippet
    expect(msg).toMatch(/\d+\|/);
    expect(msg).toContain("Best matching region");
  });

  it("preserves original error when oldText is missing", async () => {
    const fileContent = "some content";

    const base = createMockEditTool("Could not find the exact text in test.ts");
    const wrapped = wrapEditToolWithRecovery(base, {
      root: "/tmp",
      readFile: async () => fileContent,
    });

    const error = await wrapped
      .execute(
        "call-1",
        {
          path: "test.ts",
          newText: "replacement",
        },
        undefined,
      )
      .catch((e: Error) => e);

    expect(error).toBeInstanceOf(Error);
    const msg = (error as Error).message;
    expect(msg).toContain("Current file contents:");
  });
});
