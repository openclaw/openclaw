import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { AnyAgentTool } from "./pi-tools.types.js";
import { createOpenClawReadTool } from "./pi-tools.read.js";

describe("createOpenClawReadTool", () => {
  it("fails fast when path points to a directory", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-read-"));
    const dirPath = path.join(root, "docs");
    await fs.mkdir(dirPath, { recursive: true });

    try {
      const base: AnyAgentTool = {
        name: "read",
        description: "read test",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string" },
          },
        },
        execute: vi.fn(async () => ({
          content: [{ type: "text", text: "ok" }],
        })),
        // `createReadTool` includes this at runtime; test keeps compatibility.
        root,
      } as unknown as AnyAgentTool;

      const wrapped = createOpenClawReadTool(base);
      await expect(wrapped.execute("tool-1", { path: "docs" })).rejects.toThrow(/directory/i);
      expect(base.execute).not.toHaveBeenCalled();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("passes file paths through to the underlying read tool", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-read-"));
    const filePath = path.join(root, "note.txt");
    await fs.writeFile(filePath, "hello", "utf8");

    try {
      const execute = vi.fn(async (_id: string, args: unknown) => ({
        content: [
          {
            type: "text",
            text: `Read file ${JSON.stringify(args)}`,
          },
        ],
      }));

      const base: AnyAgentTool = {
        name: "read",
        description: "read test",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string" },
          },
        },
        execute,
        root,
      } as unknown as AnyAgentTool;

      const wrapped = createOpenClawReadTool(base);
      await wrapped.execute("tool-2", { path: "note.txt" });
      expect(execute).toHaveBeenCalled();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
