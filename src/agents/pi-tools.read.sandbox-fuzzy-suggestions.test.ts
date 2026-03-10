import type { EditToolOptions } from "@mariozechner/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SandboxFsBridge } from "./sandbox/fs-bridge.js";

const mocks = vi.hoisted(() => ({
  operations: undefined as EditToolOptions["operations"] | undefined,
}));

vi.mock("@mariozechner/pi-coding-agent", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@mariozechner/pi-coding-agent")>();
  return {
    ...actual,
    createEditTool: (_cwd: string, options?: EditToolOptions) => {
      mocks.operations = options?.operations;
      return {
        name: "edit",
        description: "test sandbox edit tool",
        parameters: { type: "object", properties: {} },
        execute: async (_toolCallId: string, params: unknown) => {
          const record = params as Record<string, unknown>;
          throw new Error(
            `Could not find the exact text in ${String(record.path)}. The old text must match exactly.`,
          );
        },
      };
    },
  };
});

const { createSandboxedEditTool } = await import("./pi-tools.read.js");

describe("createSandboxedEditTool fuzzy suggestions", () => {
  afterEach(() => {
    mocks.operations = undefined;
  });

  it("uses the sandbox fs bridge to enrich not-found errors for sandbox-only paths", async () => {
    const calls: Array<{ kind: "readFile" | "stat"; filePath: string; cwd?: string }> = [];
    const bridge: SandboxFsBridge = {
      resolvePath: ({ filePath }) => ({
        hostPath: `/host${filePath}`,
        relativePath: filePath.replace(/^\/+/, ""),
        containerPath: filePath,
      }),
      readFile: async ({ filePath, cwd }) => {
        calls.push({ kind: "readFile", filePath, cwd });
        return Buffer.from("const sandboxValue = 1;\n", "utf8");
      },
      writeFile: async () => {},
      mkdirp: async () => {},
      remove: async () => {},
      rename: async () => {},
      stat: async ({ filePath, cwd }) => {
        calls.push({ kind: "stat", filePath, cwd });
        return {
          type: "file",
          size: Buffer.byteLength("const sandboxValue = 1;\n", "utf8"),
          mtimeMs: 0,
        };
      },
    };

    const tool = createSandboxedEditTool({ root: "/workspace", bridge });

    await expect(
      tool.execute(
        "call-1",
        {
          path: "test.ts",
          oldText: "const sandboxValue = 2;",
          newText: "const sandboxValue = 3;",
        },
        undefined,
      ),
    ).rejects.toThrow(/most similar region/);

    expect(calls).toEqual([
      { kind: "stat", filePath: "/workspace/test.ts", cwd: "/workspace" },
      { kind: "readFile", filePath: "/workspace/test.ts", cwd: "/workspace" },
    ]);
  });
});
