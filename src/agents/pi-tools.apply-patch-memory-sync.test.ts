import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { createOpenClawCodingTools } from "./pi-tools.js";
import type { SandboxContext } from "./sandbox/types.js";
import { createHostSandboxFsBridge } from "./test-helpers/host-sandbox-fs-bridge.js";

const scheduleMemoryDocumentSyncToPostgresMock = vi.hoisted(() => vi.fn());
const persistMemoryDocumentCanonicalMock = vi.hoisted(() => vi.fn(async () => {}));
const runtimePersistencePolicy = vi.hoisted(() => ({
  enabled: false,
  exportCompatibility: true,
}));

vi.mock("../persistence/service.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../persistence/service.js")>();
  return {
    ...mod,
    scheduleMemoryDocumentSyncToPostgres: scheduleMemoryDocumentSyncToPostgresMock,
    persistMemoryDocumentCanonical: persistMemoryDocumentCanonicalMock,
  };
});

vi.mock("../persistence/postgres-client.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../persistence/postgres-client.js")>();
  return {
    ...mod,
    getRuntimePostgresPersistencePolicySync: () => runtimePersistencePolicy,
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

async function withTempDirs<T>(fn: (workspaceDir: string, sandboxDir: string) => Promise<T>) {
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-apply-patch-workspace-"));
  const sandboxDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-apply-patch-sandbox-"));
  try {
    return await fn(workspaceDir, sandboxDir);
  } finally {
    await fs.rm(workspaceDir, { recursive: true, force: true });
    await fs.rm(sandboxDir, { recursive: true, force: true });
  }
}

function createSandbox(workspaceDir: string, sandboxDir: string): SandboxContext {
  return {
    enabled: true,
    sessionKey: "agent:main",
    workspaceDir: sandboxDir,
    agentWorkspaceDir: workspaceDir,
    workspaceAccess: "rw",
    containerName: "sandbox-main",
    containerWorkdir: "/workspace",
    docker: { env: {} },
    tools: {},
    browserAllowHostControl: false,
    fsBridge: createHostSandboxFsBridge(sandboxDir),
  } as SandboxContext;
}

function resolveApplyPatchTool(options: {
  workspaceDir: string;
  sandboxDir?: string;
}): ToolWithExecute {
  const tools = createOpenClawCodingTools({
    agentId: "main",
    workspaceDir: options.workspaceDir,
    sandbox: options.sandboxDir
      ? createSandbox(options.workspaceDir, options.sandboxDir)
      : undefined,
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
    persistMemoryDocumentCanonicalMock.mockClear();
    runtimePersistencePolicy.enabled = false;
    runtimePersistencePolicy.exportCompatibility = true;
  });

  it("schedules sync for memory docs touched by apply_patch", async () => {
    await withTempDirs(async (workspaceDir, sandboxDir) => {
      await fs.mkdir(path.join(sandboxDir, "memory"), { recursive: true });
      await fs.writeFile(path.join(sandboxDir, "memory", "2026-03-12.md"), "old\n", "utf8");

      const tool = resolveApplyPatchTool({ workspaceDir, sandboxDir });
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
        workspaceRoot: workspaceDir,
        absolutePath: path.join(sandboxDir, "MEMORY.md"),
        logicalPath: "MEMORY.md",
        agentId: "main",
      });
      expect(scheduleMemoryDocumentSyncToPostgresMock).toHaveBeenNthCalledWith(2, {
        workspaceRoot: workspaceDir,
        absolutePath: path.join(sandboxDir, "memory", "2026-03-12.md"),
        logicalPath: "memory/2026-03-12.md",
        agentId: "main",
      });
    });
  });

  it("schedules sync for touched memory docs even when apply_patch fails after earlier hunks", async () => {
    await withTempDirs(async (workspaceDir, sandboxDir) => {
      const tool = resolveApplyPatchTool({ workspaceDir, sandboxDir });

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
        workspaceRoot: workspaceDir,
        absolutePath: path.join(sandboxDir, "MEMORY.md"),
        logicalPath: "MEMORY.md",
        agentId: "main",
      });
    });
  });

  it("does not schedule filesystem re-sync after canonical host apply_patch writes", async () => {
    await withTempDir(async (dir) => {
      runtimePersistencePolicy.enabled = true;
      runtimePersistencePolicy.exportCompatibility = false;

      const tool = resolveApplyPatchTool({ workspaceDir: dir });
      await tool.execute(
        "call-3",
        {
          input: `*** Begin Patch
*** Add File: MEMORY.md
+canonical
*** End Patch`,
        },
        undefined,
      );

      expect(persistMemoryDocumentCanonicalMock).toHaveBeenCalledWith({
        workspaceRoot: dir,
        absolutePath: path.join(dir, "MEMORY.md"),
        logicalPath: "MEMORY.md",
        body: "canonical\n",
        agentId: "main",
      });
      expect(scheduleMemoryDocumentSyncToPostgresMock).not.toHaveBeenCalled();
    });
  });
});
