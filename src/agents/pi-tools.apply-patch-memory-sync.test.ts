import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { createOpenClawCodingTools } from "./pi-tools.js";

const scheduleMemoryDocumentSyncToPostgresMock = vi.hoisted(() => vi.fn());

vi.mock("../persistence/service.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../persistence/service.js")>();
  return {
    ...mod,
    scheduleMemoryDocumentSyncToPostgres: scheduleMemoryDocumentSyncToPostgresMock,
  };
});

vi.mock("../infra/shell-env.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../infra/shell-env.js")>();
  return { ...mod, getShellPathFromLoginShell: () => null };
});

type ToolWithExecute = {
  execute: (toolCallId: string, args: unknown, signal?: AbortSignal) => Promise<unknown>;
};

async function withTempDir<T>(fn: (dir: string) => Promise<T>) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-apply-patch-sync-"));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

function resolveApplyPatchTool(workspaceDir: string): ToolWithExecute {
  const tools = createOpenClawCodingTools({
    agentId: "main",
    workspaceDir,
    config: {
      tools: {
        allow: ["read", "exec"],
        exec: { applyPatch: { enabled: true } },
      },
    } as OpenClawConfig,
    modelProvider: "openai",
    modelId: "gpt-5.2",
  });
  const tool = tools.find((entry) => entry.name === "apply_patch") as ToolWithExecute | undefined;
  if (!tool) {
    throw new Error("apply_patch tool missing");
  }
  return tool;
}

describe("createOpenClawCodingTools apply_patch memory sync", () => {
  beforeEach(() => {
    scheduleMemoryDocumentSyncToPostgresMock.mockClear();
  });

  it("schedules sync for memory docs touched by apply_patch", async () => {
    await withTempDir(async (dir) => {
      await fs.mkdir(path.join(dir, "memory"), { recursive: true });
      await fs.writeFile(path.join(dir, "memory", "2026-03-12.md"), "old\n", "utf8");

      const tool = resolveApplyPatchTool(dir);
      await tool.execute(
        "call-1",
        {
          input: `*** Begin Patch
*** Add File: MEMORY.md
+hello
*** Update File: memory/2026-03-12.md
*** Move to: notes.md
@@
-old
+new
*** End Patch`,
        },
        undefined,
      );

      expect(scheduleMemoryDocumentSyncToPostgresMock).toHaveBeenCalledTimes(2);
      expect(scheduleMemoryDocumentSyncToPostgresMock).toHaveBeenNthCalledWith(1, {
        workspaceRoot: dir,
        absolutePath: path.join(dir, "MEMORY.md"),
        logicalPath: "MEMORY.md",
        agentId: "main",
      });
      expect(scheduleMemoryDocumentSyncToPostgresMock).toHaveBeenNthCalledWith(2, {
        workspaceRoot: dir,
        absolutePath: path.join(dir, "memory", "2026-03-12.md"),
        logicalPath: "memory/2026-03-12.md",
        agentId: "main",
      });
    });
  });

  it("schedules sync for touched memory docs even when apply_patch fails after earlier hunks", async () => {
    await withTempDir(async (dir) => {
      const tool = resolveApplyPatchTool(dir);

      await expect(
        tool.execute(
          "call-2",
          {
            input: `*** Begin Patch
*** Add File: MEMORY.md
+hello
*** Update File: missing.txt
@@
-old
+new
*** End Patch`,
          },
          undefined,
        ),
      ).rejects.toThrow();

      expect(scheduleMemoryDocumentSyncToPostgresMock).toHaveBeenCalledTimes(1);
      expect(scheduleMemoryDocumentSyncToPostgresMock).toHaveBeenCalledWith({
        workspaceRoot: dir,
        absolutePath: path.join(dir, "MEMORY.md"),
        logicalPath: "MEMORY.md",
        agentId: "main",
      });
    });
  });
});
