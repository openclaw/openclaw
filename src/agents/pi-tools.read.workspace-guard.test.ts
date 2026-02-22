import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { wrapToolWorkspaceRootGuard } from "./pi-tools.read.js";
import type { AnyAgentTool } from "./pi-tools.types.js";

async function withTempDir<T>(prefix: string, run: (dir: string) => Promise<T>) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  try {
    return await run(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

function createToolSpy() {
  const execute = vi.fn(async () => ({
    content: [{ type: "text", text: "ok" }],
    details: {},
  }));
  const tool = {
    name: "read",
    description: "test",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
      },
      required: ["path"],
      additionalProperties: false,
    },
    execute: execute as unknown as AnyAgentTool["execute"],
  } as unknown as AnyAgentTool;
  return { tool, execute };
}

describe("wrapToolWorkspaceRootGuard", () => {
  it("allows workspace-contained paths", async () => {
    await withTempDir("openclaw-ws-guard-", async (workspaceDir) => {
      const { tool, execute } = createToolSpy();
      const guarded = wrapToolWorkspaceRootGuard(tool, workspaceDir);

      await guarded.execute("tc1", { path: "inside.txt" });

      expect(execute).toHaveBeenCalledTimes(1);
    });
  });

  it("rejects absolute paths outside workspace", async () => {
    await withTempDir("openclaw-ws-guard-", async (workspaceDir) => {
      await withTempDir("openclaw-outside-guard-", async (outsideDir) => {
        const { tool, execute } = createToolSpy();
        const guarded = wrapToolWorkspaceRootGuard(tool, workspaceDir);
        const outsideFile = path.join(outsideDir, "secret.txt");
        await fs.writeFile(outsideFile, "secret", "utf8");

        await expect(guarded.execute("tc2", { path: outsideFile })).rejects.toThrow(
          /Path escapes sandbox root/i,
        );
        expect(execute).not.toHaveBeenCalled();
      });
    });
  });

  it("rejects symlink escapes outside workspace", async () => {
    await withTempDir("openclaw-ws-guard-", async (workspaceDir) => {
      await withTempDir("openclaw-outside-guard-", async (outsideDir) => {
        const outsideFile = path.join(outsideDir, "secret.txt");
        const linkPath = path.join(workspaceDir, "linked-secret.txt");
        await fs.writeFile(outsideFile, "secret", "utf8");
        try {
          await fs.symlink(outsideFile, linkPath);
        } catch {
          return;
        }

        const { tool, execute } = createToolSpy();
        const guarded = wrapToolWorkspaceRootGuard(tool, workspaceDir);

        await expect(guarded.execute("tc3", { path: linkPath })).rejects.toThrow(
          /Symlink escapes sandbox root/i,
        );
        expect(execute).not.toHaveBeenCalled();
      });
    });
  });
});
