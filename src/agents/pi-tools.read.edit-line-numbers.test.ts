import { describe, expect, it, vi } from "vitest";
import { createSandboxedEditTool } from "./pi-tools.read.js";
import type { SandboxFsBridge } from "./sandbox/fs-bridge.js";

describe("edit tool - line numbers in duplicate match errors", () => {
  it("should include line numbers when multiple occurrences are found", async () => {
    const testContent = `line 1
line 2
const foo = 'bar';
line 4
const foo = 'bar';
line 6`;

    const mockBridge: SandboxFsBridge = {
      readFile: vi.fn(async () => Buffer.from(testContent, "utf-8")),
      writeFile: vi.fn(async () => {}),
      stat: vi.fn(async () => ({
        type: "file" as const,
        size: testContent.length,
        mtimeMs: Date.now(),
      })),
      mkdirp: vi.fn(async () => {}),
    } as unknown as SandboxFsBridge;

    const tool = createSandboxedEditTool({
      root: "/test",
      bridge: mockBridge,
    });

    await expect(
      tool.execute("test-call", {
        path: "test.ts",
        oldText: "const foo = 'bar';",
        newText: "const foo = 'baz';",
      }),
    ).rejects.toThrow(/Found 2 occurrences.*\(lines 3, 5\)/);
  });

  it("should include line numbers for multi-line text", async () => {
    const testContent = `function test() {
  return 42;
}
some other code
function test() {
  return 42;
}`;

    const mockBridge: SandboxFsBridge = {
      readFile: vi.fn(async () => Buffer.from(testContent, "utf-8")),
      writeFile: vi.fn(async () => {}),
      stat: vi.fn(async () => ({
        type: "file" as const,
        size: testContent.length,
        mtimeMs: Date.now(),
      })),
      mkdirp: vi.fn(async () => {}),
    } as unknown as SandboxFsBridge;

    const tool = createSandboxedEditTool({
      root: "/test",
      bridge: mockBridge,
    });

    await expect(
      tool.execute("test-call", {
        path: "test.ts",
        oldText: `function test() {
  return 42;
}`,
        newText: `function test() {
  return 100;
}`,
      }),
    ).rejects.toThrow(/Found 2 occurrences.*\(lines 1, 5\)/);
  });

  it("should handle many occurrences with truncation", async () => {
    const lines: string[] = [];
    for (let i = 1; i <= 20; i++) {
      lines.push(`line ${i}`);
      if (i % 2 === 0) {
        lines.push("duplicate line");
      }
    }
    const testContent = lines.join("\n");

    const mockBridge: SandboxFsBridge = {
      readFile: vi.fn(async () => Buffer.from(testContent, "utf-8")),
      writeFile: vi.fn(async () => {}),
      stat: vi.fn(async () => ({
        type: "file" as const,
        size: testContent.length,
        mtimeMs: Date.now(),
      })),
      mkdirp: vi.fn(async () => {}),
    } as unknown as SandboxFsBridge;

    const tool = createSandboxedEditTool({
      root: "/test",
      bridge: mockBridge,
    });

    await expect(
      tool.execute("test-call", {
        path: "test.ts",
        oldText: "duplicate line",
        newText: "unique line",
      }),
    ).rejects.toThrow(/\(lines 3, 6, 9, 12, 15\.\.\. \(10 total\)\)/);
  });

  it("should work normally when text is unique", async () => {
    const testContent = `line 1
const foo = 'bar';
line 3`;

    const mockBridge: SandboxFsBridge = {
      readFile: vi.fn(async () => Buffer.from(testContent, "utf-8")),
      writeFile: vi.fn(async () => {}),
      stat: vi.fn(async () => ({
        type: "file" as const,
        size: testContent.length,
        mtimeMs: Date.now(),
      })),
      mkdirp: vi.fn(async () => {}),
    } as unknown as SandboxFsBridge;

    const tool = createSandboxedEditTool({
      root: "/test",
      bridge: mockBridge,
    });

    const result = await tool.execute("test-call", {
      path: "test.ts",
      oldText: "const foo = 'bar';",
      newText: "const foo = 'baz';",
    });

    expect(result).toMatchObject({
      content: expect.arrayContaining([
        expect.objectContaining({
          type: "text",
          text: expect.stringContaining("Successfully replaced"),
        }),
      ]),
    });
  });
});
