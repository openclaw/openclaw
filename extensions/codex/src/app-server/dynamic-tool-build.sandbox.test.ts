import fs from "node:fs/promises";
import "./dynamic-tool-build.test-support.js";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { createOpenClawCodingTools } from "openclaw/plugin-sdk/agent-harness";
import { resolveAgentHarnessBeforePromptBuildResult } from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  createMockPluginRegistry,
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { createRemoteShellSandboxFsBridge } from "openclaw/plugin-sdk/sandbox";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { createSandboxTestContext } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { shouldEnableCodexAppServerNativeToolSurface } from "./dynamic-tool-build.js";
import { createCodexDynamicToolBridge } from "./dynamic-tools.js";
import { setCodexTestToolFactory } from "./host-capability.test-support.js";
import * as nativeExecutionPolicy from "./native-execution-policy.js";

const {
  bindProductionCodexHostCapabilities,
  buildDynamicToolsForTest,
  createCodexRuntimePlanFixture,
  createParams,
  createRuntimeDynamicTool,
  hoisted,
} = await import("./dynamic-tool-build.test-support.js");

describe("Codex app-server sandbox shell tools", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);
  const hostCapabilityClosers: Array<() => void> = [];
  let tempDir: string;

  beforeEach(() => {
    hoisted.loadNodeExecAvailability.mockResolvedValue({
      cacheKey: "eligible",
      isAvailable: () => true,
    });
    hoisted.normalizeAgentRuntimeTools.mockClear();
    hoisted.resolveWebSearchToolPolicy.mockClear();
    tempDir = tempDirs.make("openclaw-codex-sandbox-tools-");
  });

  afterEach(() => {
    for (const close of hostCapabilityClosers.splice(0)) {
      close();
    }
    resetGlobalHookRunner();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("exposes OpenClaw sandbox shell tools under distinct names for non-Docker sandbox backends", async () => {
    const execTool = expectDefined(
      createOpenClawCodingTools({ workspaceDir: tempDir }).find((tool) => tool.name === "exec"),
      "assembled exec tool",
    );

    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const params = createParams(sessionFile, workspaceDir);
    setCodexTestToolFactory(params, () => [
      createRuntimeDynamicTool("read"),
      createRuntimeDynamicTool("write"),
      createRuntimeDynamicTool("edit"),
      createRuntimeDynamicTool("apply_patch"),
      execTool,
      createRuntimeDynamicTool("process"),
      createRuntimeDynamicTool("message"),
    ]);
    params.disableTools = false;
    params.runtimePlan = createCodexRuntimePlanFixture();

    const tools = await buildDynamicToolsForTest(params, workspaceDir, {
      sandbox: { enabled: true, backendId: "ssh" } as never,
      nativeToolSurfaceEnabled: false,
    });

    expect(tools.map((tool) => tool.name)).toEqual([
      "read",
      "write",
      "edit",
      "apply_patch",
      "message",
      "sandbox_exec",
      "sandbox_process",
    ]);
    expect(tools.find((tool) => tool.name === "sandbox_exec")?.description).toContain(
      "configured sandbox backend",
    );
    expect(tools.find((tool) => tool.name === "sandbox_exec")?.parameters).not.toHaveProperty(
      "properties.security",
    );
    expect(tools.find((tool) => tool.name === "sandbox_process")?.description).toContain(
      "background shell sessions",
    );
  });

  it("exposes Docker sandbox shell tools when OpenClaw sandboxing disables native Code Mode", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const params = createParams(sessionFile, workspaceDir);
    setCodexTestToolFactory(params, () => [
      createRuntimeDynamicTool("exec"),
      createRuntimeDynamicTool("process"),
      createRuntimeDynamicTool("message"),
    ]);
    params.disableTools = false;
    params.runtimePlan = createCodexRuntimePlanFixture();
    const sandbox = { enabled: true, backendId: "docker" } as never;
    const nativeToolSurfaceEnabled = shouldEnableCodexAppServerNativeToolSurface(params, sandbox);

    const dockerTools = await buildDynamicToolsForTest(params, workspaceDir, {
      sandbox,
      nativeToolSurfaceEnabled,
    });

    expect(nativeToolSurfaceEnabled).toBe(false);
    expect(dockerTools.map((tool) => tool.name)).toEqual([
      "message",
      "sandbox_exec",
      "sandbox_process",
    ]);
  });

  it.each([
    { allow: undefined, expected: ["message", "sandbox_exec", "sandbox_process"] },
    { allow: ["group:runtime"], expected: ["sandbox_exec", "sandbox_process"] },
    { allow: ["exec*"], expected: ["sandbox_exec", "sandbox_process"] },
    { allow: ["exec"], restrictWith: ["process"], expected: ["sandbox_process"] },
    { allow: ["sandbox_process"], restrictWith: ["process"], expected: ["sandbox_process"] },
  ])(
    "keeps Docker shell projections pinned for runtime selectors $allow restricted by $restrictWith",
    async ({ allow, restrictWith, expected }) => {
      const sessionFile = path.join(tempDir, "session.jsonl");
      const workspaceDir = path.join(tempDir, "workspace");
      const params = createParams(sessionFile, workspaceDir);
      setCodexTestToolFactory(params, () => [
        createRuntimeDynamicTool("exec"),
        createRuntimeDynamicTool("process"),
        createRuntimeDynamicTool("message"),
      ]);
      params.disableTools = false;
      params.runtimePlan = createCodexRuntimePlanFixture();
      params.toolsAllow = allow;
      if (restrictWith) {
        initializeGlobalHookRunner(
          createMockPluginRegistry([
            { hookName: "before_prompt_build", handler: () => ({ toolsAllow: allow }) },
            { hookName: "before_prompt_build", handler: () => ({ toolsAllow: restrictWith }) },
          ]),
        );
        const result = await resolveAgentHarnessBeforePromptBuildResult({
          prompt: params.prompt,
          developerInstructions: "",
          messages: [],
          ctx: { agentId: "main", sessionKey: params.sessionKey },
        });
        params.toolsAllow = result.toolsAllow;
      }
      const resolveExecutionPolicy = vi.spyOn(
        nativeExecutionPolicy,
        "resolveCodexNativeExecutionPolicy",
      );

      const tools = await buildDynamicToolsForTest(params, workspaceDir, {
        sandbox: {
          enabled: true,
          backendId: "docker",
          docker: { binds: ["/tmp/openclaw-data:/data:rw"] },
        } as never,
        nativeToolSurfaceEnabled: false,
      });

      expect(resolveExecutionPolicy).toHaveBeenCalledOnce();
      expect(resolveExecutionPolicy).toHaveBeenCalledWith(
        expect.objectContaining({ sandboxAvailable: true }),
      );
      expect(tools.map((tool) => tool.name)).toEqual(expected);
      expect(tools.map((tool) => tool.catalogMode)).toEqual(
        expected.map((name) => (name === "message" ? undefined : "direct-only")),
      );
      if (expected.includes("sandbox_exec")) {
        expect(tools.find((tool) => tool.name === "sandbox_exec")?.description).toContain(
          "Docker container-path bind layout",
        );
      }
    },
  );

  it("exposes node shell but not sandbox shell tools when sandbox routing is disabled", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const params = createParams(sessionFile, workspaceDir);
    setCodexTestToolFactory(params, () => [
      createRuntimeDynamicTool("exec"),
      createRuntimeDynamicTool("process"),
      createRuntimeDynamicTool("message"),
    ]);
    params.disableTools = false;
    params.runtimePlan = createCodexRuntimePlanFixture();

    const disabledSandboxTools = await buildDynamicToolsForTest(params, workspaceDir, {
      sandbox: { enabled: false, backendId: "ssh" } as never,
      nativeToolSurfaceEnabled: false,
    });

    expect(disabledSandboxTools.map((tool) => tool.name)).toEqual([
      "exec",
      "process",
      "message",
      "node_exec",
    ]);
  });

  it.each(["docker", "ssh"])(
    "preserves completion-only %s sandbox exec when policy denies process",
    async (backendId) => {
      const workspaceDir = path.join(tempDir, "workspace");
      await fs.mkdir(workspaceDir, { recursive: true });
      const params = createParams(path.join(tempDir, "session.jsonl"), workspaceDir);
      params.disableTools = false;
      params.runtimePlan = createCodexRuntimePlanFixture();
      params.config = { plugins: { enabled: false } };
      params.agentDir = path.join(tempDir, "agent");
      const buildExecSpec = vi.fn(async () => ({
        // A synthetic backend transport proves dispatch without Docker or SSH access.
        argv: [
          process.execPath,
          "-e",
          'setTimeout(() => process.stdout.write("sandbox execution completed\\n"), 25)',
        ],
        env: {},
        cwd: workspaceDir,
        stdinMode: "pipe-closed" as const,
      }));
      const runShellCommand = vi.fn(async () => {
        throw new Error("Unexpected sandbox filesystem command");
      });
      const sandbox = createSandboxTestContext({
        overrides: {
          backendId,
          workspaceDir,
          agentWorkspaceDir: workspaceDir,
          workspaceAccess: "ro",
          tools: { allow: ["read", "exec"], deny: ["process", "code_execution"] },
          backend: {
            id: backendId,
            runtimeId: "sandbox-exec-only",
            runtimeLabel: "sandbox-exec-only",
            workdir: "/workspace",
            buildExecSpec,
            runShellCommand,
          },
        },
      });
      sandbox.fsBridge = createRemoteShellSandboxFsBridge({
        sandbox,
        runtime: {
          remoteWorkspaceDir: "/workspace",
          remoteAgentWorkspaceDir: "/workspace",
          runRemoteShellScript: runShellCommand,
        },
      });
      await bindProductionCodexHostCapabilities(params, hostCapabilityClosers);
      const nativeToolSurfaceEnabled = shouldEnableCodexAppServerNativeToolSurface(
        params,
        sandbox,
        {
          sandboxExecServerEnabled: true,
        },
      );
      const tools = await buildDynamicToolsForTest(params, workspaceDir, {
        sandbox,
        nativeToolSurfaceEnabled,
      });

      expect(nativeToolSurfaceEnabled).toBe(false);
      expect(tools.map((tool) => tool.name)).toEqual(["read", "sandbox_exec"]);
      const execTool = expectDefined(
        tools.find((tool) => tool.name === "sandbox_exec"),
        "completion-only sandbox exec",
      );
      expect(execTool.catalogMode).toBe("direct-only");
      expect(execTool.parameters).not.toHaveProperty("properties.background");
      expect(execTool.parameters).not.toHaveProperty("properties.yieldMs");
      const bridge = createCodexDynamicToolBridge({
        tools,
        signal: new AbortController().signal,
      });
      const onAgentToolResult = vi.fn();
      const response = await bridge.handleToolCall(
        {
          threadId: "sandbox-thread",
          turnId: "sandbox-turn",
          callId: "sandbox-exec-only",
          tool: "sandbox_exec",
          arguments: { command: "echo sandbox request", background: true, yieldMs: 1 },
        },
        { onAgentToolResult },
      );

      expect(response.success, JSON.stringify(response.contentItems)).toBe(true);
      expect(response.contentItems).toEqual([
        expect.objectContaining({
          type: "inputText",
          text: expect.stringContaining("sandbox execution completed"),
        }),
      ]);
      expect(onAgentToolResult).toHaveBeenCalledWith(
        expect.objectContaining({
          toolName: "sandbox_exec",
          result: expect.objectContaining({
            details: expect.objectContaining({ status: "completed" }),
          }),
        }),
      );
      expect(buildExecSpec).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ command: "echo sandbox request", workdir: "/workspace" }),
      );
    },
  );

  it("honors Codex dynamic tool excludes for sandbox shell exposure", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const params = createParams(sessionFile, workspaceDir);
    setCodexTestToolFactory(params, () => [
      createRuntimeDynamicTool("exec"),
      createRuntimeDynamicTool("process"),
      createRuntimeDynamicTool("message"),
    ]);
    params.disableTools = false;
    params.runtimePlan = createCodexRuntimePlanFixture();

    for (const excludedToolName of ["sandbox_exec", "process"]) {
      const tools = await buildDynamicToolsForTest(params, workspaceDir, {
        sandbox: { enabled: true, backendId: "ssh" } as never,
        nativeToolSurfaceEnabled: false,
        pluginConfig: { codexDynamicToolsExclude: [excludedToolName] },
      });

      expect(tools.map((tool) => tool.name)).toEqual(["message"]);
    }
  });
});
