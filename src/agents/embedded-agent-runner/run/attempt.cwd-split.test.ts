import fs from "node:fs/promises";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../../test/helpers/temp-dir.js";
import { wrapToolDefinition } from "../../sessions/tools/tool-definition-wrapper.js";
import type { AnyAgentTool } from "../../tools/common.js";
import { runWithAgentWorkspaceReadiness } from "../../workspace-readiness.js";
import {
  cleanupTempPaths,
  createContextEngineAttemptRunner,
  createContextEngineBootstrapAndAssemble,
  getHoisted,
  preloadRunEmbeddedAttemptForTests,
  resetEmbeddedAttemptHarness,
} from "./attempt-spawn-workspace.test-support.js";

const hoisted = getHoisted();
const tempPaths: string[] = [];
const dirs = useAutoCleanupTempDirTracker(afterEach);
function run(
  attemptOverrides: Parameters<typeof createContextEngineAttemptRunner>[0]["attemptOverrides"],
) {
  return createContextEngineAttemptRunner({
    contextEngine: createContextEngineBootstrapAndAssemble(),
    sessionKey: "agent:main:subagent:child",
    tempPaths,
    attemptOverrides,
  });
}
function stubTool(name: string): AnyAgentTool {
  return {
    name,
    label: name,
    description: `${name} tool`,
    parameters: { type: "object", properties: {} },
    execute: async () => ({ content: [], details: undefined }),
  };
}

describe("runEmbeddedAttempt cwd/workspace split", () => {
  beforeAll(preloadRunEmbeddedAttemptForTests);
  beforeEach(() => resetEmbeddedAttemptHarness());
  afterEach(async () => {
    await cleanupTempPaths(tempPaths);
    tempPaths.length = 0;
  });

  it("uses workspace for bootstrap and cwd for runtime tools", async () => {
    const taskRepo = dirs.make("openclaw-task-repo-");
    const allowed = ["read", "write", "edit", "apply_patch", "exec", "process"];
    hoisted.createOpenClawCodingToolsMock.mockReturnValueOnce(
      [...allowed, "message", "browser", "web_search"].map(stubTool),
    );
    await run({
      cwd: taskRepo,
      requireWorkspaceOnly: true,
      toolsAllow: allowed,
      disableTools: false,
    });
    const bootstrap = hoisted.resolveBootstrapFilesForRunMock.mock.calls[0]?.[0] as
      | { agentId?: string; workspaceDir?: string }
      | undefined;
    expect(bootstrap?.workspaceDir).not.toBe(taskRepo);
    expect(bootstrap?.agentId).toBe("main");
    const tools = hoisted.createOpenClawCodingToolsMock.mock.calls[0]?.[0];
    expect(tools).toMatchObject({
      cwd: taskRepo,
      workspaceDir: bootstrap?.workspaceDir,
      spawnWorkspaceDir: bootstrap?.workspaceDir,
      requireWorkspaceOnly: true,
      runtimeToolAllowlist: [...allowed, "tool_search", "tool_describe", "tool_call"],
      toolConstructionPlan: {
        includeBaseCodingTools: true,
        includeShellTools: true,
        includeChannelTools: false,
        includeOpenClawTools: false,
        includePluginTools: false,
      },
    });
    expect(
      hoisted.createAgentSessionMock.mock.calls.at(-1)?.[0]?.customTools?.map((tool) => tool.name),
    ).toEqual(["tool_search", "tool_describe", "tool_call", ...allowed]);
    expect(hoisted.defaultResourceLoaderInitMock.mock.calls[0]?.[0]).toMatchObject({
      cwd: taskRepo,
    });
    expect(hoisted.embeddedSystemPromptInputs[0]).toMatchObject({
      workspaceDir: bootstrap?.workspaceDir,
      runtimeCwd: taskRepo,
    });
  });

  it("passes the explicit session permission root to native tools", async () => {
    const root = dirs.make("openclaw-permission-mode-");
    await run({
      disableTools: false,
      permissionMode: "guarded",
      sessionRoot: root,
      workspaceDir: root,
    });
    expect(hoisted.createOpenClawCodingToolsMock.mock.calls.at(-1)?.[0]).toMatchObject({
      sessionPermissionPolicy: { root, mode: "guarded" },
      exec: { mode: "ask" },
    });
  });

  it("starts the built-in prompt while only workspace tools wait for checkout", async () => {
    const ready = createDeferred();
    const waiting = createDeferred();
    const read = stubTool("read");
    const executeRead = vi.fn(read.execute);
    read.execute = executeRead;
    const web = stubTool("web_search");
    const executeWeb = vi.fn(web.execute);
    web.execute = executeWeb;
    hoisted.createOpenClawCodingToolsMock.mockReturnValue([read, web]);
    await runWithAgentWorkspaceReadiness(
      {
        sessionKey: "agent:main:subagent:child",
        waitUntilReady: () => {
          waiting.resolve();
          return ready.promise;
        },
        assertCurrent: () => {},
      },
      async () =>
        createContextEngineAttemptRunner({
          contextEngine: createContextEngineBootstrapAndAssemble(),
          sessionKey: "agent:main:subagent:child",
          tempPaths,
          attemptOverrides: {
            disableTools: false,
            config: { tools: { toolSearch: false, codeMode: false } },
          },
          sessionPrompt: async () => {
            const tools = hoisted.createAgentSessionMock.mock.calls
              .at(-1)?.[0]
              ?.customTools?.map((tool) => wrapToolDefinition(tool));
            const boundRead = tools?.find((tool) => tool.name === "read");
            const boundWeb = tools?.find((tool) => tool.name === "web_search");
            expect(boundRead).toBeDefined();
            expect(boundWeb).toBeDefined();
            const pending = boundRead!.execute("read", {});
            await Promise.race([waiting.promise, pending]);
            await boundWeb!.execute("web", {});
            expect(executeWeb).toHaveBeenCalledOnce();
            expect(executeRead).not.toHaveBeenCalled();
            ready.resolve();
            await pending;
          },
        }),
    );
    expect(executeRead).toHaveBeenCalledOnce();
  });

  it("defaults rootless session permission boundaries to the canonical workspace", async () => {
    const workspaceDir = dirs.make("openclaw-rootless-permission-");
    await run({ disableTools: false, permissionMode: "workspace", workspaceDir });
    expect(hoisted.createOpenClawCodingToolsMock.mock.calls.at(-1)?.[0]).toMatchObject({
      sessionPermissionPolicy: { root: await fs.realpath(workspaceDir), mode: "workspace" },
    });
  });

  it("skips runtime tool construction when the model does not support tools", async () => {
    hoisted.supportsModelToolsMock.mockReturnValueOnce(false);
    await run({ disableTools: false });
    expect(hoisted.createOpenClawCodingToolsMock).not.toHaveBeenCalled();
  });

  it("rejects cwd overrides for sandboxed runs", async () => {
    hoisted.resolveSandboxContextMock.mockResolvedValueOnce({
      enabled: true,
      workspaceAccess: "ro",
      workspaceDir: "/tmp/openclaw-sandbox-copy",
    });
    await expect(run({ cwd: "/tmp/task-repo" })).rejects.toThrow("cwd override is not supported");
    expect(hoisted.createOpenClawCodingToolsMock).not.toHaveBeenCalled();
  });

  it("runs a managed worktree when sandbox workspace and cwd match", async () => {
    const worktree = dirs.make("openclaw-sandbox-worktree-");
    hoisted.resolveSandboxContextMock.mockResolvedValueOnce({
      enabled: true,
      workspaceAccess: "rw",
      workspaceDir: worktree,
    });
    await run({ workspaceDir: worktree, cwd: worktree, disableTools: false });
    expect(hoisted.createOpenClawCodingToolsMock).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: worktree, workspaceDir: worktree }),
      undefined,
      undefined,
      undefined,
      expect.objectContaining({ assertCurrent: expect.any(Function) }),
    );
  });
});
