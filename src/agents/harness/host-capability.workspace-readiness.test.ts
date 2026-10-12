import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { resetAgentRunRegistryForTest } from "../../infra/agent-run-registry.js";
import { setPluginToolMeta } from "../../plugins/tool-metadata.js";
import {
  createOperationalRunInstanceRef,
  prepareAgentRunAdmission,
  type PreparedAgentRunAdmission,
} from "../admitted-run-context.js";
import { runBeforeToolCallHook } from "../agent-tools.before-tool-call.js";
import { markCodeModeControlTool } from "../code-mode-control-tools.js";
import {
  attachInternalToolExecutionPreparer,
  getInternalToolExecutionPreparer,
  type InternalToolExecutionPreparer,
} from "../runtime/internal-hooks.js";
import { createSandboxTestContext } from "../sandbox/test-fixtures.js";
import { createHostSandboxFsBridge } from "../test-helpers/host-sandbox-fs-bridge.js";
import type { AnyAgentTool } from "../tools/common.js";
import { runWithAgentWorkspaceReadiness } from "../workspace-readiness.js";
import { createAgentHarnessHostCapabilities } from "./host-capability.js";

vi.mock("../agent-tools.before-tool-call.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../agent-tools.before-tool-call.js")>()),
  rewrapToolWithBeforeToolCallHook: vi.fn((tool) => tool),
  runBeforeToolCallHook: vi.fn(async ({ params }) => ({ blocked: false, params })),
}));
const mockRunBefore = vi.mocked(runBeforeToolCallHook);

type HostAttempt = Parameters<typeof createAgentHarnessHostCapabilities>[0]["attempt"];

const admissions: PreparedAgentRunAdmission[] = [];

async function admittedAttempt(
  runId = "run-1",
  overrides: Omit<Partial<HostAttempt>, "admittedRunContext" | "runId"> = {},
): Promise<{ attempt: HostAttempt; admission: PreparedAgentRunAdmission }> {
  const admission = prepareAgentRunAdmission({
    cfg: {},
    facts: {
      runId,
      agentId: "main",
      ingress: { kind: "system", boundary: "host-capability-test", state: "present" },
    },
    operationalRunInstance: createOperationalRunInstanceRef(runId),
  });
  admissions.push(admission);
  const admittedRunContext = await admission.admit("plugin-harness", `harness-${runId}`);
  return {
    admission,
    attempt: {
      agentId: "main",
      sessionId: "session-1",
      sessionKey: "agent:main:session-1",
      runId,
      cwd: "/attempt/worktree",
      workspaceDir: "/workspace",
      currentChannelId: "chat-1",
      messageChannel: "telegram",
      ...overrides,
      admittedRunContext,
    },
  };
}

function testTool(execute = vi.fn(async () => ({ content: [], details: {} }))): {
  tool: AnyAgentTool;
  execute: typeof execute;
} {
  return {
    execute,
    tool: {
      name: "read",
      label: "Read",
      description: "read",
      parameters: Type.Object({}),
      execute,
    },
  };
}

function bindTool(
  attempt: HostAttempt,
  tool: AnyAgentTool,
): {
  host: ReturnType<typeof createAgentHarnessHostCapabilities>;
  bound: AnyAgentTool;
} {
  const host = createAgentHarnessHostCapabilities({ attempt, pluginId: "codex" });
  const [bound] = host.capabilities.bindToolSurface([tool]);
  if (!bound) {
    throw new Error("expected bound tool");
  }
  return { host, bound };
}

afterEach(() => {
  for (const admission of admissions.splice(0)) {
    admission.close();
  }
  resetAgentRunRegistryForTest();
});
beforeEach(() => {
  mockRunBefore.mockClear();
});

describe("agent harness workspace readiness and boundaries", () => {
  it.each(["read", "pdf", "workspace_plugin"])(
    "waits for the workspace before %s runs while independent tools remain usable",
    async (name) => {
      const { attempt } = await admittedAttempt("pending-workspace");
      const ready = createDeferred();
      const waiting = createDeferred();
      const { tool, execute } = testTool();
      tool.name = name;
      if (name === "workspace_plugin") {
        setPluginToolMeta(tool, { pluginId: "fixture", optional: false, workspaceAccess: true });
      }
      const web = testTool();
      web.tool.name = "web_search";
      const code = testTool();
      code.tool.name = "exec";
      markCodeModeControlTool(code.tool);
      const host = await runWithAgentWorkspaceReadiness(
        {
          sessionKey: attempt.sessionKey!,
          waitUntilReady: () => {
            waiting.resolve();
            return ready.promise;
          },
          assertCurrent: () => {},
        },
        async () => createAgentHarnessHostCapabilities({ attempt, pluginId: "codex" }),
      );
      const [bound, independent, codeControl] = host.capabilities.bindToolSurface([
        tool,
        web.tool,
        code.tool,
      ]);
      const pending = bound!.execute("workspace", {});
      await Promise.race([waiting.promise, pending]);
      await independent!.execute("web", {});
      await codeControl!.execute("code", {});
      expect(web.execute).toHaveBeenCalledOnce();
      expect(code.execute).toHaveBeenCalledOnce();
      expect(execute).not.toHaveBeenCalled();
      ready.resolve();
      await pending;
      expect(execute).toHaveBeenCalledOnce();
      host.close();
    },
  );

  it("checks host authority after workspace readiness before preparing a tool", async () => {
    const { attempt } = await admittedAttempt("pending-workspace-preparation");
    const ready = createDeferred();
    const waiting = createDeferred();
    const { tool } = testTool();
    const prepare = vi.fn<InternalToolExecutionPreparer>(async () => ({
      kind: "immediate",
      outcome: { kind: "result", result: { content: [], details: {} }, isError: false },
      dispose() {},
    }));
    attachInternalToolExecutionPreparer(tool, prepare);
    const { host, bound } = await runWithAgentWorkspaceReadiness(
      {
        sessionKey: attempt.sessionKey!,
        waitUntilReady: () => {
          waiting.resolve();
          return ready.promise;
        },
        assertCurrent: () => {},
      },
      async () => bindTool(attempt, tool),
    );
    const pending = getInternalToolExecutionPreparer(bound)!({ toolCallId: "prepare", args: {} });
    await Promise.race([waiting.promise, pending]);
    expect(prepare).not.toHaveBeenCalled();
    host.close();
    ready.resolve();
    await expect(pending).rejects.toThrow("no longer active");
    expect(prepare).not.toHaveBeenCalled();
  });

  it.each(["Bash", "apply_patch", "read_file", "grep_files", "list_dir", "write_stdin"])(
    "holds native %s admission and rechecks workspace ownership after the wait",
    async (toolName) => {
      const { attempt } = await admittedAttempt("pending-native-workspace");
      const ready = createDeferred();
      const waiting = createDeferred();
      let current = true;
      const host = await runWithAgentWorkspaceReadiness(
        {
          sessionKey: attempt.sessionKey!,
          waitUntilReady: () => {
            waiting.resolve();
            return ready.promise;
          },
          assertCurrent: () => {
            if (!current) {
              throw new Error("workspace owner replaced");
            }
          },
        },
        async () => createAgentHarnessHostCapabilities({ attempt, pluginId: "codex" }),
      );
      const pending = host.capabilities.runBeforeToolCall({ toolName, params: {} });
      await Promise.race([waiting.promise, pending]);
      await host.capabilities.runBeforeToolCall({ toolName: "web_search", params: {} });
      await host.capabilities.runBeforeToolCall({
        toolName: "exec",
        toolKind: "code_mode_exec",
        params: {},
      });
      expect(mockRunBefore).not.toHaveBeenCalledWith(expect.objectContaining({ toolName }));
      current = false;
      ready.resolve();
      await expect(pending).rejects.toThrow("workspace owner replaced");
      expect(mockRunBefore).not.toHaveBeenCalledWith(expect.objectContaining({ toolName }));
      host.close();
    },
  );

  it("does not inherit another session's pending workspace", async () => {
    const { attempt } = await admittedAttempt("unrelated-workspace");
    const waitUntilReady = vi.fn(async () => {
      throw new Error("wrong session");
    });
    const { tool, execute } = testTool();
    const { host, bound } = await runWithAgentWorkspaceReadiness(
      {
        sessionKey: "agent:main:another-session",
        waitUntilReady,
        assertCurrent: () => {},
      },
      async () => bindTool(attempt, tool),
    );
    await bound.execute("read", {});
    expect(execute).toHaveBeenCalledOnce();
    expect(waitUntilReady).not.toHaveBeenCalled();
    expect(host.capabilities.workspaceReadiness).toBeUndefined();
    host.close();
  });

  it("returns the workspace owner's preparation error without starting the tool", async () => {
    const { attempt } = await admittedAttempt("failed-workspace");
    const { tool, execute } = testTool();
    const failure = new Error("Worktree preparation failed. Retry session preparation.");
    const { host, bound } = await runWithAgentWorkspaceReadiness(
      {
        sessionKey: attempt.sessionKey!,
        waitUntilReady: async () => {
          throw failure;
        },
        assertCurrent: () => {},
      },
      async () => bindTool(attempt, tool),
    );
    await expect(bound.execute("read", {})).rejects.toBe(failure);
    expect(execute).not.toHaveBeenCalled();
    host.close();
  });

  it("does not remove existing shell policy from a non-Codex required-root harness", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-rooted-other-"));
    const { attempt } = await admittedAttempt("required-other", {
      workspaceDir: root,
      cwd: root,
      sessionRoot: root,
      requireWorkspaceOnly: true,
    });
    const host = createAgentHarnessHostCapabilities({ attempt, pluginId: "copilot" });
    try {
      const tools = host.capabilities.createToolSurface?.({}) ?? [];
      expect(tools.map((tool) => tool.name)).toEqual(
        expect.arrayContaining(["read", "exec", "process"]),
      );
    } finally {
      host.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
  it("retains callable prepared sandbox handles in a required-root surface", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-rooted-sandbox-"));
    const bridge = createHostSandboxFsBridge(root);
    const runShellCommand = vi.fn(async () => ({
      stdout: Buffer.alloc(0),
      stderr: Buffer.alloc(0),
      code: 0,
    }));
    const sandbox = createSandboxTestContext({
      overrides: {
        workspaceDir: root,
        agentWorkspaceDir: root,
        fsBridge: bridge,
        backend: {
          id: "test",
          runtimeId: "test",
          runtimeLabel: "test",
          workdir: "/workspace",
          buildExecSpec: vi.fn(),
          runShellCommand,
        },
        skillsEligibility: {
          remote: { platforms: ["linux"], hasBin: () => false, hasAnyBin: () => false },
        },
      },
    });
    const { attempt } = await admittedAttempt("required-sandbox", {
      workspaceDir: root,
      cwd: root,
      sessionRoot: root,
      requireWorkspaceOnly: true,
      sandbox,
    });
    const host = createAgentHarnessHostCapabilities({ attempt, pluginId: "codex" });
    try {
      const tools = host.capabilities.createToolSurface?.({ sandbox: undefined }) ?? [];
      expect(tools.some((tool) => tool.name === "exec" || tool.name === "process")).toBe(false);
      await tools
        .find((tool) => tool.name === "write")!
        .execute("sandbox-write", { path: "inside.txt", content: "inside" });
      await expect(
        tools.find((tool) => tool.name === "read")!.execute("sandbox-read", { path: "inside.txt" }),
      ).resolves.toBeDefined();
      expect(fs.readFileSync(path.join(root, "inside.txt"), "utf8")).toBe("inside");
      expect(runShellCommand).not.toHaveBeenCalled();
      const noCore = host.capabilities.createToolSurface?.({ includeCoreTools: false }) ?? [];
      expect(
        noCore.some((tool) => ["read", "write", "exec", "process", "message"].includes(tool.name)),
      ).toBe(false);
    } finally {
      host.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps required-root file tools and rejects shell and plugin root escapes", async () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-rooted-host-"));
    const root = path.join(parent, "workshop");
    fs.mkdirSync(root);
    fs.writeFileSync(path.join(parent, "outside.txt"), "outside");
    fs.symlinkSync(parent, path.join(root, "escape"), "dir");
    const { attempt } = await admittedAttempt("required-root", {
      workspaceDir: root,
      cwd: root,
      sessionRoot: root,
      requireWorkspaceOnly: true,
    });
    const host = createAgentHarnessHostCapabilities({ attempt, pluginId: "codex" });
    attempt.workspaceDir = parent;
    attempt.cwd = parent;
    attempt.sessionRoot = parent;
    attempt.requireWorkspaceOnly = undefined;
    try {
      for (const plan of [
        undefined,
        {
          includeBaseCodingTools: true,
          includeShellTools: true,
          includeChannelTools: true,
          includeOpenClawTools: true,
          includePluginTools: true,
        },
      ]) {
        const tools =
          host.capabilities.createToolSurface?.({
            workspaceDir: parent,
            cwd: parent,
            requireWorkspaceOnly: undefined,
            exec: { mode: "full" },
            toolConstructionPlan: plan,
          }) ?? [];
        expect(tools.map((tool) => tool.name)).toEqual(
          expect.arrayContaining(["read", "write", "edit"]),
        );
        expect(tools.some((tool) => tool.name === "exec" || tool.name === "process")).toBe(false);
        const write = tools.find((tool) => tool.name === "write")!;
        const read = tools.find((tool) => tool.name === "read")!;
        await write.execute("inside", { path: "inside.txt", content: "inside" });
        expect(fs.readFileSync(path.join(root, "inside.txt"), "utf8")).toBe("inside");
        for (const target of [
          path.join(parent, "outside.txt"),
          "../outside.txt",
          "escape/outside.txt",
        ]) {
          await expect(read.execute("escape-read", { path: target })).rejects.toThrow();
          await expect(
            write.execute("escape-write", { path: target, content: "bad" }),
          ).rejects.toThrow();
        }
      }
      expect(() =>
        host.capabilities.createToolSurface?.({
          sessionPermissionPolicy: { root: parent, mode: "full" },
        }),
      ).toThrow("escapes the captured required workspace");
      expect(fs.readFileSync(path.join(parent, "outside.txt"), "utf8")).toBe("outside");
    } finally {
      host.close();
      fs.rmSync(parent, { recursive: true, force: true });
    }
  });

  it("preserves a narrower read-only root inside the required workspace", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-rooted-policy-"));
    const subset = path.join(root, "subset");
    fs.mkdirSync(subset);
    fs.writeFileSync(path.join(root, "sibling.txt"), "sibling");
    fs.writeFileSync(path.join(subset, "inside.txt"), "inside");
    const { attempt } = await admittedAttempt("required-subset", {
      workspaceDir: root,
      cwd: root,
      sessionRoot: root,
      requireWorkspaceOnly: true,
    });
    const host = createAgentHarnessHostCapabilities({ attempt, pluginId: "codex" });
    try {
      const tools =
        host.capabilities.createToolSurface?.({
          sessionPermissionPolicy: { root: subset, mode: "read-only" },
        }) ?? [];
      const read = tools.find((tool) => tool.name === "read")!;
      expect(tools.some((tool) => tool.name === "write" || tool.name === "exec")).toBe(false);
      await expect(
        read.execute("sibling", { path: path.join(root, "sibling.txt") }),
      ).rejects.toThrow();
      await expect(
        read.execute("inside", { path: path.join(subset, "inside.txt") }),
      ).resolves.toBeDefined();
    } finally {
      host.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
