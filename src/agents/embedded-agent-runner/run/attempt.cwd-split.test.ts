import fs from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../../test/helpers/temp-dir.js";
import { wrapToolDefinition } from "../../sessions/tools/tool-definition-wrapper.js";
import type { AnyAgentTool } from "../../tools/common.js";
import { runWithAgentWorkspaceReadiness } from "../../workspace-readiness.js";
import {
  useContextEngineAttemptHarness,
  mockParams,
  type ContextEngineAttemptOptions,
} from "./attempt-context-engine.test-support.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
const { hoisted, runAttempt } = useContextEngineAttemptHarness("agent:main:subagent:child");
function run(
  attemptOverrides: ContextEngineAttemptOptions["attemptOverrides"],
  sessionPrompt?: ContextEngineAttemptOptions["sessionPrompt"],
) {
  return runAttempt({
    attemptOverrides: { disableTools: false, ...attemptOverrides },
    sessionPrompt,
  });
}
function stubTool(name: string): AnyAgentTool {
  return {
    name,
    label: name,
    description: `${name} tool`,
    parameters: { type: "object", properties: {} },
    execute: vi.fn(async () => ({ content: [], details: undefined })),
  };
}

describe("runEmbeddedAttempt cwd/workspace split", () => {
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
    });
    const bootstrap = mockParams(hoisted.resolveBootstrapFilesForRunMock);
    expect(bootstrap.workspaceDir).not.toBe(taskRepo);
    expect(bootstrap.agentId).toBe("main");
    const tools = hoisted.createOpenClawCodingToolsMock.mock.calls[0]?.[0];
    expect(tools).toMatchObject({
      cwd: taskRepo,
      workspaceDir: bootstrap.workspaceDir,
      spawnWorkspaceDir: bootstrap.workspaceDir,
      requireWorkspaceOnly: true,
      runtimeToolAllowlist: [...allowed, "tool_search", "tool_describe", "dispatch_action"],
    });
    expect(
      hoisted.createAgentSessionMock.mock.calls.at(-1)?.[0]?.customTools?.map((tool) => tool.name),
    ).toEqual(["tool_search", "tool_describe", "dispatch_action", ...allowed]);
    expect(hoisted.defaultResourceLoaderInitMock.mock.calls[0]?.[0]).toHaveProperty(
      "cwd",
      taskRepo,
    );
    expect(hoisted.embeddedSystemPromptInputs[0]).toMatchObject({
      workspaceDir: bootstrap.workspaceDir,
      runtimeCwd: taskRepo,
    });
  });

  it.each(["guarded", "workspace"] as const)(
    "uses the %s session permission root",
    async (mode) => {
      const root = dirs.make("openclaw-permission-");
      await run({
        permissionMode: mode,
        workspaceDir: root,
        ...(mode === "guarded" ? { sessionRoot: root } : {}),
      });
      expect(hoisted.createOpenClawCodingToolsMock.mock.calls.at(-1)?.[0]).toMatchObject({
        sessionPermissionPolicy: {
          root: mode === "guarded" ? root : await fs.realpath(root),
          mode,
        },
        ...(mode === "guarded" ? { exec: { mode: "ask" } } : {}),
      });
    },
  );

  it("starts the built-in prompt while only workspace tools wait for checkout", async () => {
    const ready = createDeferred();
    const waiting = createDeferred();
    const read = stubTool("read");
    const web = stubTool("web_search");
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
        run(
          {
            config: { tools: { toolSearch: false, codeMode: false } },
          },
          async () => {
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
            expect(web.execute).toHaveBeenCalledOnce();
            expect(read.execute).not.toHaveBeenCalled();
            ready.resolve();
            await pending;
          },
        ),
    );
    expect(read.execute).toHaveBeenCalledOnce();
  });

  it("skips runtime tool construction when the model does not support tools", async () => {
    hoisted.supportsModelToolsMock.mockReturnValueOnce(false);
    await run({});
    expect(hoisted.createOpenClawCodingToolsMock).not.toHaveBeenCalled();
  });

  it("rejects cwd overrides for sandboxed runs", async () => {
    hoisted.resolveSandboxContextMock.mockResolvedValueOnce({
      enabled: true,
      workspaceAccess: "ro",
      workspaceDir: "/tmp/openclaw-sandbox-copy",
    });
    await expect(run({ cwd: "/tmp/task-repo", disableTools: true })).rejects.toThrow(
      "cwd override is not supported",
    );
    expect(hoisted.createOpenClawCodingToolsMock).not.toHaveBeenCalled();
  });

  it("runs a managed worktree when sandbox workspace and cwd match", async () => {
    const worktree = dirs.make("openclaw-sandbox-worktree-");
    hoisted.resolveSandboxContextMock.mockResolvedValueOnce({
      enabled: true,
      workspaceAccess: "rw",
      workspaceDir: worktree,
    });
    await run({ workspaceDir: worktree, cwd: worktree });
    const call = hoisted.createOpenClawCodingToolsMock.mock.calls[0];
    expect(call?.[0]).toMatchObject({ cwd: worktree, workspaceDir: worktree });
    expect(call?.[4]).toHaveProperty("assertCurrent", expect.any(Function));
  });
});
