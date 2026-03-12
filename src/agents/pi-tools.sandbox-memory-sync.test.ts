import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { createOpenClawCodingTools } from "./pi-tools.js";
import type { SandboxContext } from "./sandbox/types.js";
import { createHostSandboxFsBridge } from "./test-helpers/host-sandbox-fs-bridge.js";

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
  name: string;
  execute: (toolCallId: string, args: unknown, signal?: AbortSignal) => Promise<unknown>;
};

async function withTempDirs<T>(fn: (workspaceDir: string, sandboxDir: string) => Promise<T>) {
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-memory-workspace-"));
  const sandboxDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-memory-sandbox-"));
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

function resolveTool(tools: ToolWithExecute[], name: string): ToolWithExecute {
  const tool = tools.find((entry) => entry.name === name);
  if (!tool) {
    throw new Error(`tool missing: ${name}`);
  }
  return tool;
}

function createSandboxedTools(workspaceDir: string, sandboxDir: string): ToolWithExecute[] {
  return createOpenClawCodingTools({
    agentId: "main",
    workspaceDir,
    sandbox: createSandbox(workspaceDir, sandboxDir),
    config: {
      tools: {
        allow: ["read", "write", "edit", "exec"],
        exec: { applyPatch: { enabled: true } },
      },
    } as OpenClawConfig,
    modelProvider: "openai",
    modelId: "gpt-5.2",
  }) as ToolWithExecute[];
}

describe("createOpenClawCodingTools sandbox memory sync", () => {
  beforeEach(() => {
    scheduleMemoryDocumentSyncToPostgresMock.mockClear();
  });

  it("schedules canonical sync for sandboxed write and edit memory mutations", async () => {
    await withTempDirs(async (workspaceDir, sandboxDir) => {
      await fs.mkdir(path.join(sandboxDir, "memory"), { recursive: true });
      await fs.writeFile(path.join(sandboxDir, "memory", "2026-03-12.md"), "old\n", "utf8");

      const tools = createSandboxedTools(workspaceDir, sandboxDir);
      await resolveTool(tools, "write").execute("call-write", {
        path: "MEMORY.md",
        content: "hello\n",
      });
      await resolveTool(tools, "edit").execute("call-edit", {
        path: "memory/2026-03-12.md",
        old_string: "old",
        new_string: "new",
      });

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

  it("schedules canonical sync for sandboxed apply_patch memory mutations", async () => {
    await withTempDirs(async (workspaceDir, sandboxDir) => {
      const tools = createSandboxedTools(workspaceDir, sandboxDir);

      await resolveTool(tools, "apply_patch").execute("call-patch", {
        input: `*** Begin Patch
*** Add File: MEMORY.md
+sandbox canonical
*** End Patch`,
      });

      expect(scheduleMemoryDocumentSyncToPostgresMock).toHaveBeenCalledWith({
        workspaceRoot: workspaceDir,
        absolutePath: path.join(sandboxDir, "MEMORY.md"),
        logicalPath: "MEMORY.md",
        agentId: "main",
      });
    });
  });
});
