// Codex tests cover dynamic tool build plugin behavior.
import fs from "node:fs/promises";
import "./dynamic-tool-build.test-support.js";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { createOpenClawCodingTools } from "openclaw/plugin-sdk/agent-harness";
import {
  embeddedAgentLog,
  type EmbeddedRunAttemptParamsV2 as EmbeddedRunAttemptParams,
  wrapToolWithBeforeToolCallHook,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { readMemoryArtifactProvenance } from "openclaw/plugin-sdk/memory-core-host-runtime-core";
import {
  createMockPluginRegistry,
  createOutboundTestPlugin,
  createTestRegistry,
  getActivePluginRegistry,
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import {
  clearRuntimeConfigSnapshot,
  getRuntimeConfigSnapshot,
  getRuntimeConfigSourceSnapshot,
  setRuntimeConfigSnapshot,
} from "openclaw/plugin-sdk/runtime-config-snapshot";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerCodexCompletionCommandTest } from "./dynamic-tool-build.completion.test-support.js";
import {
  disableCodexPluginThreadConfig,
  resolveCodexAppServerExecutionCwd,
  resolveCodexExternalSandboxPolicyForOpenClawSandbox,
  resolveCodexSandboxEnvironmentSelection,
  shouldEnableCodexAppServerNativeToolSurface,
} from "./dynamic-tool-build.js";
import type { RuntimeDynamicToolForTest } from "./dynamic-tool-build.test-support.js";
import {
  filterCodexDynamicTools,
  resolveCodexDynamicToolsLoading,
  resolveCodexDynamicToolsLoadingForRuntime,
} from "./dynamic-tool-profile.js";
import { createCodexDynamicToolBridge } from "./dynamic-tools.js";
import {
  createCodexTestHostCapabilities,
  setCodexTestToolFactory,
} from "./host-capability.test-support.js";
import { prepareCodexNativeExecutionPolicyForRun } from "./native-execution-policy.js";
import {
  CODEX_OPENCLAW_DIRECT_DYNAMIC_TOOL_NAMESPACE,
  flattenCodexDynamicToolFunctions,
} from "./protocol.js";
import { resolveCodexDynamicToolDirectNames } from "./run-attempt-tools.js";
import { createCodexTestModel } from "./test-support.js";

const {
  bindProductionCodexHostCapabilities,
  buildDynamicToolsForTest,
  cleanupDynamicToolBuildFixture,
  createCodexRuntimePlanFixture,
  createParams: createBaseParams,
  createRuntimeDynamicTool,
  hoisted,
} = await import("./dynamic-tool-build.test-support.js");

let tempDir: string;
const hostCapabilityClosers: Array<() => void> = [];

type ToolOptions = NonNullable<Parameters<typeof createOpenClawCodingTools>[0]>;

function createParams(sessionFile: string, workspaceDir: string): EmbeddedRunAttemptParams {
  return {
    ...createBaseParams(sessionFile, workspaceDir),
    disableTools: false,
    runtimePlan: createCodexRuntimePlanFixture(),
  };
}

function shellTestToolNames(tools: readonly { name: string }[]): string[] {
  return tools
    .map((tool) => tool.name)
    .filter((name) => ["message", "gateway_exec", "gateway_process", "node_exec"].includes(name));
}

describe("Codex app-server dynamic tool build", () => {
  it("forwards private yield context and acknowledgment to the lifecycle owner", async () => {
    const workspaceDir = path.join(tempDir, "workspace");
    const params = createParams(path.join(tempDir, "session.jsonl"), workspaceDir);
    let capturedOnYield:
      | ((message: string, acknowledgment?: string) => Promise<void> | void)
      | undefined;
    setCodexTestToolFactory(params, (options) => {
      capturedOnYield = (options as { onYield?: typeof capturedOnYield }).onYield;
      return [];
    });
    const onYieldDetected = vi.fn();

    await buildDynamicToolsForTest(params, workspaceDir, {
      sandbox: null as never,
      onYieldDetected,
    });
    await expectDefined(capturedOnYield, "captured onYield callback")(
      "Resume after the fact-checker replies",
      "Research started; results will follow.",
    );

    expect(onYieldDetected).toHaveBeenCalledWith(
      "Resume after the fact-checker replies",
      "Research started; results will follow.",
    );
  });

  it("preserves the exact memory audience through tool construction", async () => {
    const workspaceDir = path.join(tempDir, "memory-audience-workspace");
    const params = createParams(path.join(tempDir, "memory-audience-session.jsonl"), workspaceDir);
    params.senderIsOwner = true;
    // The adapter must forward, not clone or infer, this host-owned identity.
    params.memoryAudience = Object.freeze({
      kind: "conversation",
      agentId: "main",
      sessionKey: expectDefined(params.sessionKey, "memory audience session key"),
      sessionId: params.sessionId,
    });
    const factory = vi.fn((_options: Parameters<typeof createOpenClawCodingTools>[0]) => []);
    setCodexTestToolFactory(params, factory);

    await buildDynamicToolsForTest(params, workspaceDir);

    expect(factory).toHaveBeenCalledOnce();
    expect(factory.mock.calls[0]?.[0]?.memoryAudience).toBe(params.memoryAudience);
  });

  it.each<[string, string | undefined, string | undefined, string | undefined, boolean]>([
    ["provider-only Telegram", undefined, "telegram", "telegram", true],
    ["explicit webchat before Telegram provider", "webchat", "telegram", "webchat", true],
    ["both channels absent", undefined, undefined, undefined, true],
    ["callback absent", undefined, "telegram", "telegram", false],
  ])(
    "hands the question tools this run's own way to show a prompt: %s",
    async (_name, messageChannel, messageProvider, expectedChannel, hasCallback) => {
      // Codex dispatches dynamic tools itself, so no tool-start handler reserves
      // the prompt. The question tools need this run's own delivery callback.
      const workspaceDir = path.join(tempDir, "question-prompt-workspace");
      const params = createParams(
        path.join(tempDir, "question-prompt-session.jsonl"),
        workspaceDir,
      );
      params.messageChannel = messageChannel;
      params.messageProvider = messageProvider;
      const onToolResult = vi.fn();
      params.onToolResult = hasCallback ? onToolResult : undefined;
      let capturedQuestionPrompt: ToolOptions["questionPrompt"];
      setCodexTestToolFactory(params, (options) => {
        capturedQuestionPrompt = options?.questionPrompt;
        return [];
      });

      await buildDynamicToolsForTest(params, workspaceDir);

      if (!hasCallback) {
        expect(capturedQuestionPrompt).toBeUndefined();
        return;
      }
      expect(capturedQuestionPrompt?.send).toBe(onToolResult);
      expect(capturedQuestionPrompt?.messageChannel).toBe(expectedChannel);
      await expectDefined(capturedQuestionPrompt, "captured question prompt").send({
        text: "Question for you:",
      });
      expect(onToolResult).toHaveBeenCalledExactlyOnceWith({ text: "Question for you:" });
    },
  );

  it("binds a resolver-backed constructed tool surface exactly once", async () => {
    const workspaceDir = path.join(tempDir, "resolver-bound-workspace");
    const params = createParams(path.join(tempDir, "resolver-bound-session.jsonl"), workspaceDir);
    const bindToolSurface = vi.fn(params.hostCapabilities.bindToolSurface);
    params.hostCapabilities = createCodexTestHostCapabilities({ bindToolSurface });
    const factory = vi.fn(() => [createRuntimeDynamicTool("read")]);
    setCodexTestToolFactory(params, factory);
    const resolveCronCreatorToolAuthority = vi.fn(async () => ({
      tools: ["read"],
      provenance: { version: 1 as const, source: "final-executable-surface" as const },
    }));
    const effectiveCwd = path.join(workspaceDir, "native-cwd");

    const tools = await buildDynamicToolsForTest(params, workspaceDir, {
      effectiveCwd,
      resolveCronCreatorToolAuthority,
    });

    expect(factory).toHaveBeenCalledOnce();
    expect(bindToolSurface).toHaveBeenCalledOnce();
    expect(bindToolSurface).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ name: "read" })]),
      { cwd: effectiveCwd },
    );
    expect(tools).toEqual([]);
  });

  it.each([true, false])(
    "requires native paired-device execution enabled=%s",
    async (nativeToolSurfaceEnabled) => {
      const workspaceDir = path.join(tempDir, "paired-node-workspace");
      const params = createParams(path.join(tempDir, "paired-node-session.jsonl"), workspaceDir);
      const factory = vi.fn((options: Parameters<typeof createOpenClawCodingTools>[0]) =>
        nativeToolSurfaceEnabled
          ? [
              ...createOpenClawCodingTools(options).filter((tool) => tool.name === "message"),
              createRuntimeDynamicTool("paired_host_plugin"),
            ]
          : [createRuntimeDynamicTool("exec")],
      );
      setCodexTestToolFactory(params, factory);
      const build = buildDynamicToolsForTest(params, workspaceDir, {
        ...(nativeToolSurfaceEnabled ? {} : { nativeToolSurfaceEnabled }),
        sandbox: {
          enabled: true,
          backendId: "node",
          workspaceDir,
          agentWorkspaceDir: workspaceDir,
          containerWorkdir: "/remote/workspace",
          workspaceAccess: "rw",
          browserAllowHostControl: false,
          placementExecutionMode: "remote-exec",
          placementNodeId: "paired-device-1",
        } as never,
      });
      if (!nativeToolSurfaceEnabled) {
        await expect(build).rejects.toThrow("requires its native exec-server tool surface");
        expect(factory).not.toHaveBeenCalled();
        return;
      }
      const tools = await build;
      expect(tools.map((tool) => tool.name)).toEqual(
        expect.arrayContaining(["message", "paired_host_plugin"]),
      );
      expect(factory).toHaveBeenCalledWith(
        expect.objectContaining({
          toolConstructionPlan: {
            includeBaseCodingTools: false,
            includeShellTools: false,
            includeChannelTools: true,
            includeOpenClawTools: true,
            includePluginTools: true,
          },
        }),
      );
    },
  );

  it("uses the prepared explicit-policy fact to disable the native surface", () => {
    const params = createParams("/tmp/session.jsonl", "/tmp/workspace");

    expect(shouldEnableCodexAppServerNativeToolSurface(params)).toBe(true);
    params.config = { tools: { profile: "coding" } };
    expect(shouldEnableCodexAppServerNativeToolSurface(params)).toBe(true);
    params.conversationToolPolicy = { deny: ["exec"] };
    expect(shouldEnableCodexAppServerNativeToolSurface(params)).toBe(true);
    params.pluginHarnessToolPolicyRestricted = true;
    expect(shouldEnableCodexAppServerNativeToolSurface(params)).toBe(false);
  });

  it.each<{
    name: string;
    input: string[];
    expected: string[];
    excludes?: string[];
    preserveShell?: boolean;
    privateQa?: boolean;
  }>([
    {
      name: "native-owned tools",
      input: [
        "read",
        "write",
        "edit",
        "apply_patch",
        "exec",
        "process",
        "update_plan",
        "progress_card",
        "get_goal",
        "create_goal",
        "update_goal",
        "tool_call",
        "tool_describe",
        "tool_search",
        "web_search",
        "message",
        "heartbeat_respond",
        "sessions_spawn",
      ],
      expected: ["progress_card", "web_search", "message", "heartbeat_respond", "sessions_spawn"],
    },
    {
      name: "disabled native tools with shell replacements",
      input: [
        "read",
        "write",
        "edit",
        "apply_patch",
        "exec",
        "process",
        "progress_card",
        "get_goal",
        "create_goal",
        "update_goal",
        "message",
      ],
      expected: [
        "read",
        "write",
        "edit",
        "apply_patch",
        "exec",
        "process",
        "progress_card",
        "get_goal",
        "create_goal",
        "update_goal",
        "message",
      ],
      preserveShell: true,
    },
    {
      name: "disabled native tools with explicit exclusions",
      input: [
        "read",
        "write",
        "edit",
        "apply_patch",
        "exec",
        "process",
        "progress_card",
        "get_goal",
        "create_goal",
        "update_goal",
        "message",
      ],
      expected: [
        "read",
        "edit",
        "progress_card",
        "get_goal",
        "create_goal",
        "update_goal",
        "message",
      ],
      excludes: ["write", "apply_patch"],
      preserveShell: false,
    },
    {
      name: "additional plugin exclusions",
      input: ["read", "exec", "message", "custom_tool"],
      expected: ["message"],
      excludes: ["custom_tool"],
    },
    {
      name: "private QA native replacements",
      input: [
        "read",
        "write",
        "apply_patch",
        "apply-patch",
        "get_goal",
        "image_generate",
        "message",
      ],
      expected: ["read", "write", "image_generate", "message"],
      privateQa: true,
    },
  ])("filters $name from the dynamic tool profile", (testCase) => {
    const tools = testCase.input.map((name) => ({ name }));
    const config = { codexDynamicToolsExclude: testCase.excludes };
    const env = testCase.privateQa
      ? { OPENCLAW_BUILD_PRIVATE_QA: "1", OPENCLAW_QA_FORCE_RUNTIME: "codex" }
      : undefined;
    const filtered = filterCodexDynamicTools(tools, config, {
      env,
      disabledNativeSurface:
        testCase.preserveShell === undefined
          ? undefined
          : { preserveShell: testCase.preserveShell },
    });
    expect(filtered.map((tool) => tool.name)).toEqual(testCase.expected);
    if (testCase.privateQa) {
      expect(resolveCodexDynamicToolsLoading({}, env)).toBe("direct");
    }
  });

  const policyDeny = ["exec", "process", "write", "edit"];
  it.each<{
    source: string;
    config?: EmbeddedRunAttemptParams["config"];
    conversationToolPolicy?: EmbeddedRunAttemptParams["conversationToolPolicy"];
    sandboxAgentId?: string;
    denied: boolean;
  }>([
    { source: "allowed", sandboxAgentId: "policy", denied: false },
    { source: "conversation", conversationToolPolicy: { deny: policyDeny }, denied: true },
    {
      source: "intersection",
      conversationToolPolicy: { deny: policyDeny },
      config: { tools: { deny: ["apply_patch"] } },
      denied: true,
    },
    { source: "global", config: { tools: { deny: policyDeny } }, denied: true },
    {
      source: "execution owner",
      config: { agents: { entries: { main: { tools: { deny: policyDeny } } } } },
      denied: true,
    },
    {
      source: "retained owner",
      config: { agents: { entries: { main: {}, policy: { tools: { deny: policyDeny } } } } },
      sandboxAgentId: "policy",
      denied: true,
    },
  ])(
    "enforces $source policy when a dynamic write reaches the bridge",
    async ({ source, config, conversationToolPolicy, sandboxAgentId, denied }) => {
      const workspaceDir = path.join(tempDir, "workspace");
      await fs.mkdir(workspaceDir, { recursive: true });
      const targetPath = path.join(workspaceDir, "policy-write.txt");
      const params = createParams(path.join(tempDir, "policy-session.jsonl"), workspaceDir);
      params.agentId = "main";
      params.sandboxSessionKey = sandboxAgentId ? "global" : undefined;
      params.sandboxAgentId = sandboxAgentId;
      params.conversationToolPolicy = conversationToolPolicy;
      params.config = {
        plugins: { enabled: false },
        agents: config?.agents ?? { entries: { main: {}, policy: {} } },
        tools: { ...config?.tools, fs: { workspaceOnly: true } },
      };
      const beforeToolCall = vi.fn(() => ({}));
      initializeGlobalHookRunner(
        createMockPluginRegistry([{ hookName: "before_tool_call", handler: beforeToolCall }]),
      );
      try {
        await bindProductionCodexHostCapabilities(params, hostCapabilityClosers);

        const tools = await buildDynamicToolsForTest(params, workspaceDir, {
          sandboxSessionKey: params.sandboxSessionKey ?? params.sessionKey,
          nativeToolSurfaceEnabled: false,
          sandbox: null,
        });
        const bridge = createCodexDynamicToolBridge({
          tools,
          signal: new AbortController().signal,
          loading: "direct",
          hookContext: {
            agentId: "main",
            sessionKey: params.sessionKey,
            sessionId: params.sessionId,
            runId: params.runId,
            workspaceDir,
          },
        });
        const result = await bridge.handleToolCall({
          threadId: "thread-policy",
          turnId: "turn-policy",
          callId: "write-policy",
          tool: "write",
          arguments: { path: targetPath, content: "allowed owner write" },
        });
        if (denied) {
          await expect(fs.readFile(targetPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
          expect(result.success).toBe(false);
          expect(beforeToolCall).not.toHaveBeenCalled();
          const codingTools = tools.filter(({ name }) =>
            ["read", "write", "edit", "apply_patch", "exec", "process"].includes(name),
          );
          expect(codingTools.map((tool) => tool.name).toSorted()).toEqual(
            source === "intersection" ? ["read"] : ["apply_patch", "read"],
          );
          const nativeTools = await buildDynamicToolsForTest(params, workspaceDir, {
            sandboxSessionKey: params.sandboxSessionKey ?? params.sessionKey,
          });
          expect(nativeTools.map((tool) => tool.name)).not.toContain("gateway_exec");
          expect(nativeTools.map((tool) => tool.name)).not.toContain("gateway_process");
        } else {
          expect(result.success).toBe(true);
          await expect(fs.readFile(targetPath, "utf8")).resolves.toBe("allowed owner write");
          expect(beforeToolCall).toHaveBeenCalledWith(
            expect.objectContaining({ toolName: "write" }),
            expect.objectContaining({ agentId: "main", sessionKey: params.sessionKey }),
          );
        }
      } finally {
        resetGlobalHookRunner();
      }
    },
  );

  it("removes account-wide app access when native tools are restricted", () => {
    expect(
      disableCodexPluginThreadConfig({
        codexPlugins: {
          enabled: true,
          allow_all_plugins: true,
          allow_destructive_actions: "auto",
        },
      }),
    ).toEqual({
      codexPlugins: {
        enabled: false,
        allow_all_plugins: true,
        allow_destructive_actions: "auto",
      },
    });
  });

  beforeEach(async () => {
    hoisted.loadNodeExecAvailability.mockResolvedValue({
      cacheKey: "eligible",
      isAvailable: () => true,
    });
    hoisted.normalizeAgentRuntimeTools.mockClear();
    hoisted.resolveWebSearchToolPolicy.mockClear();
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-tools-"));
  });

  afterEach(async () => {
    await cleanupDynamicToolBuildFixture(tempDir, hostCapabilityClosers);
  });

  const sandboxEnvironment = { environmentId: "sandbox-1", cwd: "/workspace" };

  it.each([
    {
      name: "restricted without a sandbox",
      environment: undefined,
      nativeToolSurfaceEnabled: false,
      expected: [],
    },
    {
      name: "native without a sandbox",
      environment: undefined,
      nativeToolSurfaceEnabled: true,
      expected: undefined,
    },
    {
      name: "native with a sandbox",
      environment: sandboxEnvironment,
      nativeToolSurfaceEnabled: true,
      expected: [sandboxEnvironment],
    },
  ])("preserves the explicit Codex environment selection when $name", (testCase) => {
    expect(
      resolveCodexSandboxEnvironmentSelection(
        testCase.environment,
        testCase.nativeToolSurfaceEnabled,
      ),
    ).toEqual(testCase.expected);
  });

  it("maps sandbox exec-server cwd through the remote workspace mapping", () => {
    expect(
      resolveCodexAppServerExecutionCwd({
        effectiveCwd: "/Users/kevinlin/code/openclaw",
        environment: {
          id: "sandbox-1",
          cwd: "/Users/kevinlin/code/openclaw/sandbox",
        } as never,
        nativeToolSurfaceEnabled: true,
        localWorkspaceRoot: "/Users/kevinlin/code/openclaw",
        remoteWorkspaceRoot: "/home/oai/openclaw-workspaces",
      }),
    ).toBe("/home/oai/openclaw-workspaces/sandbox");
  });

  it.each([
    { nativeToolSurfaceEnabled: true, expected: ["message"] },
    { nativeToolSurfaceEnabled: false, expected: ["view_image", "message"] },
  ])(
    "uses the active native image loader when native tools are $nativeToolSurfaceEnabled",
    async ({ nativeToolSurfaceEnabled, expected }) => {
      const workspaceDir = path.join(tempDir, "workspace");
      const params = createParams(path.join(tempDir, "session.jsonl"), workspaceDir);
      params.model = createCodexTestModel("codex", ["text", "image"]);
      setCodexTestToolFactory(params, () => [
        createRuntimeDynamicTool("view_image"),
        createRuntimeDynamicTool("message"),
      ]);

      const tools = await buildDynamicToolsForTest(params, workspaceDir, {
        nativeToolSurfaceEnabled,
      });

      expect(tools.map((tool) => tool.name)).toEqual(expected);
    },
  );

  it("never lets raw full bypass a requirements-clamped workspace dynamic policy", async () => {
    const workspaceDir = path.join(tempDir, "clamped-workspace");
    const params = createParams(path.join(tempDir, "clamped-session.jsonl"), workspaceDir);
    params.permissionMode = "full";
    params.sessionRoot = workspaceDir;
    params.execOverrides = { host: "gateway", mode: "full" };
    const factoryOptions: unknown[] = [];
    setCodexTestToolFactory(params, (options) => {
      factoryOptions.push(options);
      return [];
    });

    await buildDynamicToolsForTest(params, workspaceDir, {
      sandbox: null as never,
      sessionPermissionPolicy: { mode: "workspace", root: workspaceDir, execMode: "auto" },
    });

    expect(factoryOptions[0]).toMatchObject({
      exec: { host: "gateway", mode: "auto" },
      sessionPermissionPolicy: { mode: "workspace", root: workspaceDir },
    });
  });

  it("pins guarded Gateway shell calls to human approval after stripping model policy", async () => {
    const workspaceDir = path.join(tempDir, "guarded-gateway-workspace");
    const params = createParams(path.join(tempDir, "guarded-gateway.jsonl"), workspaceDir);
    params.permissionMode = "guarded";
    params.sessionRoot = workspaceDir;
    params.execOverrides = { host: "gateway", mode: "ask" };
    await bindProductionCodexHostCapabilities(params, hostCapabilityClosers);

    const tools = await buildDynamicToolsForTest(params, workspaceDir, {
      sessionPermissionPolicy: { mode: "guarded", root: workspaceDir, execMode: "ask" },
    });
    const gatewayExec = expectDefined(
      tools.find((tool) => tool.name === "gateway_exec"),
      "guarded Gateway shell alias",
    );
    expect(gatewayExec.parameters).not.toHaveProperty("properties.host");
    expect(gatewayExec.parameters).not.toHaveProperty("properties.security");
    expect(gatewayExec.parameters).not.toHaveProperty("properties.ask");
  });

  it.each([
    {
      mode: "guarded" as const,
      execMode: "ask" as const,
      command: "echo allowed",
      expected: { status: "completed" },
    },
    {
      mode: "guarded" as const,
      execMode: "ask" as const,
      command: "echo approval required",
      expected: { status: "failed", failureKind: "approval_required" },
    },
    {
      mode: "full" as const,
      execMode: "full" as const,
      command: "echo approval required",
      expected: { status: "completed" },
    },
  ])("enforces $mode collector policy for $command", async (testCase) => {
    const workspaceDir = path.join(tempDir, `${testCase.mode}-allowlisted-workspace`);
    await fs.mkdir(workspaceDir, { recursive: true });
    const params = createParams(
      path.join(tempDir, `${testCase.mode}-allowlisted.jsonl`),
      workspaceDir,
    );
    params.swarmCollector = true;
    params.pluginHarnessToolPolicyRestricted = true;
    params.permissionMode = testCase.mode;
    params.sessionRoot = workspaceDir;
    params.execOverrides = { host: "gateway", mode: testCase.execMode };
    // Guarded mode asks only on an allowlist miss; two arguments exceed this profile.
    params.config = {
      tools: { exec: { safeBins: ["echo"], safeBinProfiles: { echo: { maxPositional: 1 } } } },
    };
    setCodexTestToolFactory(params, (options) =>
      createOpenClawCodingTools(options).filter((tool) => ["exec", "process"].includes(tool.name)),
    );

    const tools = await buildDynamicToolsForTest(params, workspaceDir, {
      nativeToolSurfaceEnabled: shouldEnableCodexAppServerNativeToolSurface(params),
      sessionPermissionPolicy: {
        mode: testCase.mode,
        root: workspaceDir,
        execMode: testCase.execMode,
      },
    });
    const gatewayExec = expectDefined(
      tools.find((tool) => tool.name === "exec"),
      `${testCase.mode} OpenClaw shell replacement`,
    );
    expect.soft(gatewayExec.parameters).not.toHaveProperty("properties.security");
    const result = await gatewayExec.execute(`${testCase.mode}-allowlisted`, {
      command: testCase.command,
      ask: "off",
      security: "full",
    });

    expect(result.details).toMatchObject(testCase.expected);
  });

  registerCodexCompletionCommandTest();

  it.each([
    { thinkLevel: "ultra", modelId: "gpt-5.6-sol", configuredId: "configured-alias" },
  ] as const)("preserves host tool context for $modelId / $thinkLevel", async (testCase) => {
    const workspaceDir = path.join(tempDir, "workspace");
    const params = createParams(path.join(tempDir, "session.jsonl"), workspaceDir);
    const computerContextEpoch = { value: 0 };
    const onToolOutcome = vi.fn();
    const allocateToolOutcomeOrdinal = vi.fn(() => 0);
    const runtimeConfig: EmbeddedRunAttemptParams["config"] = {
      tools: { exec: { mode: "auto", reviewer: { timeoutMs: 1234 } } },
    };
    Object.assign(params, {
      clientCaps: ["tool-events", "inline-widgets"],
      pinnedWidgetAuthoring: true,
      toolBindings: { browser: { kind: "tab", tabId: 7, target: "host" } },
      memberRoleIds: ["maintainer-role"],
      chatId: "native-chat-123",
      chatType: "direct",
      currentChannelId: "D123",
      currentMessagingTarget: "user:U123",
      messageActionTurnCapability: "turn-capability-1",
      messageChannel: "discord",
      messageProvider: "discord-voice",
      taskSuggestionDeliveryMode: "gateway",
      approvalReviewerDeviceId: "device-ios-reviewer",
      senderIsOwner: true,
      delegationCapability: "report_only",
      thinkLevel: testCase.thinkLevel,
      provider: "openai",
      modelId: testCase.configuredId,
      config: runtimeConfig,
      onToolOutcome,
      allocateToolOutcomeOrdinal,
    } satisfies Partial<EmbeddedRunAttemptParams>);
    params.preparedModelRuntime = { metadataSnapshot: { plugins: [] } } as never;
    params.model = {
      ...createCodexTestModel("openai"),
      id: testCase.modelId,
      name: testCase.modelId,
      api: "openai-responses",
    };
    params.runtimePlan = {
      ...createCodexRuntimePlanFixture(),
      observability: {
        resolvedRef: `openai/${testCase.modelId}`,
        provider: "openai",
        modelId: testCase.modelId,
        harnessId: "codex",
      },
    };
    params.inputProvenance = {
      kind: "inter_session",
      sourceSessionKey: "agent:main:subagent:codex-child",
      sourceTool: "subagent_announce",
    };
    params.trustedInternalHandoff = {
      kind: "subagent-completion",
      sourceSessionKey: "agent:main:subagent:codex-child",
      targetSessionKey: "agent:main:session-1",
      targetSessionId: "session-1",
      provider: "codex",
      model: "gpt-5.4-codex",
    };
    params.scheduledToolPolicy = {
      version: 1,
      mode: "account",
      ownerSessionKey: "agent:main:discord:group:ops",
      ownerAccountId: "default",
    };
    const factory = vi.fn((options: Parameters<typeof createOpenClawCodingTools>[0]) =>
      options?.senderIsOwner && options.preparedModelRuntime
        ? [createRuntimeDynamicTool("intent")]
        : [],
    );
    setCodexTestToolFactory(params, factory);
    const onPersistentWebSearchPolicyResolved = vi.fn();

    const tools = await buildDynamicToolsForTest(params, workspaceDir, {
      sandbox: null,
      computerContextEpoch,
      onPersistentWebSearchPolicyResolved,
    });

    expect(factory).toHaveBeenCalledOnce();
    const options = expectDefined(factory.mock.calls[0]?.[0], "constructed tool options");
    expect(options).toMatchObject({
      clientCaps: ["tool-events", "inline-widgets"],
      pinnedWidgetAuthoring: true,
      toolBindings: { browser: { kind: "tab", tabId: 7, target: "host" } },
      memberRoleIds: ["maintainer-role"],
      chatType: "direct",
      nativeChannelId: "native-chat-123",
      currentChannelId: "D123",
      currentMessagingTarget: "user:U123",
      messageActionTurnCapability: "turn-capability-1",
      messageProvider: "discord",
      taskSuggestionDeliveryMode: "gateway",
      approvalReviewerDeviceId: "device-ios-reviewer",
      senderIsOwner: true,
      preparedModelRuntime: params.preparedModelRuntime,
      delegationCapability: "report_only",
      requesterThinkingLevel: testCase.thinkLevel,
      requesterModel: { provider: "openai", model: testCase.modelId },
      modelProvider: "openai",
      modelApi: "openai-responses",
      onToolOutcome,
      allocateToolOutcomeOrdinal,
      inputProvenance: params.inputProvenance,
      trustedInternalHandoff: params.trustedInternalHandoff,
      scheduledToolPolicy: params.scheduledToolPolicy,
    });
    expect(options.computerContextEpoch).toBe(computerContextEpoch);
    expect(options.config).toBe(runtimeConfig);
    expect(options.exec?.config).toBe(runtimeConfig);
    expect(options.exec?.mode).toBeUndefined();
    expect(tools.map((tool) => tool.name)).toContain("intent");
    expect(hoisted.resolveWebSearchToolPolicy).toHaveBeenCalledWith(
      expect.objectContaining({
        inputProvenance: params.inputProvenance,
        trustedInternalHandoff: params.trustedInternalHandoff,
        scheduledToolPolicy: params.scheduledToolPolicy,
      }),
    );
    expect(onPersistentWebSearchPolicyResolved).toHaveBeenCalledWith(true);
  });

  it.each([{ toolsAllow: undefined }, { toolsAllow: ["read"] }, { toolsAllow: [] }])(
    "preserves the collector handoff and dynamic tool through allowlist %j",
    async ({ toolsAllow }) => {
      const workspaceDir = path.join(tempDir, "workspace");
      const params = createParams(path.join(tempDir, "collector-session.jsonl"), workspaceDir);
      params.toolsAllow = toolsAllow;
      params.swarmCollector = true;
      params.pluginHarnessToolPolicyRestricted = true;
      params.swarmOutputSchema = {
        type: "object",
        properties: { answer: { type: "string" } },
        required: ["answer"],
      };
      // An independent host result: the factory must not repair dropped attempt fields.
      const output = {
        ...createRuntimeDynamicTool("structured_output"),
        catalogMode: "direct-only" as const,
      };
      const factory = vi.fn(() => [createRuntimeDynamicTool("read"), output]);
      setCodexTestToolFactory(params, factory);
      const tools = await buildDynamicToolsForTest(params, workspaceDir, {
        sandbox: null,
        nativeToolSurfaceEnabled: shouldEnableCodexAppServerNativeToolSurface(params),
      });

      expect(factory).toHaveBeenCalledWith(
        expect.objectContaining({
          swarmCollector: true,
          swarmOutputSchema: params.swarmOutputSchema,
          ...(toolsAllow ? { runtimeToolAllowlist: [...toolsAllow, "structured_output"] } : {}),
        }),
      );
      expect(shouldEnableCodexAppServerNativeToolSurface(params)).toBe(false);
      expect(tools.map((tool) => tool.name).toSorted()).toEqual(
        [...(toolsAllow ?? ["read"]), "structured_output"].toSorted(),
      );
      const bridge = createCodexDynamicToolBridge({
        tools,
        signal: new AbortController().signal,
      });
      const outputSpec = expectDefined(
        flattenCodexDynamicToolFunctions(bridge.specs).find(
          (tool) => tool.name === "structured_output",
        ),
        "collector dynamic tool spec",
      );
      expect(outputSpec.deferLoading).not.toBe(true);
      const args = { result: { answer: "ok" } };
      const response = await bridge.handleToolCall({
        threadId: "collector-thread",
        turnId: "collector-turn",
        tool: "structured_output",
        callId: "collector-result",
        arguments: args,
      });
      expect(response).toMatchObject({
        success: true,
        contentItems: [{ type: "inputText", text: "structured_output done" }],
      });
      expect(output.execute).toHaveBeenCalledWith(
        "collector-result",
        args,
        expect.any(AbortSignal),
        undefined,
      );
    },
  );

  it.each(["searchable", "direct"] as const)(
    "keeps regular delegation model-only with %s loading while ordinary tools stay scriptable",
    async (loading) => {
      const workspaceDir = path.join(tempDir, "workspace");
      const params = createParams(path.join(tempDir, "session.jsonl"), workspaceDir);
      params.config = { tools: { exec: { mode: "ask" } } };
      setCodexTestToolFactory(params, (options) =>
        createOpenClawCodingTools(options).filter((tool) =>
          ["openclaw", "message", "session_status"].includes(tool.name),
        ),
      );

      const tools = await buildDynamicToolsForTest(params, workspaceDir, {
        sandbox: null,
        isHostScopedToolActive: () => false,
      });
      expect(tools.map((tool) => tool.name).toSorted()).toEqual([
        "message",
        "openclaw",
        "session_status",
      ]);
      const bridge = createCodexDynamicToolBridge({
        tools,
        signal: new AbortController().signal,
        loading,
        directToolNames: resolveCodexDynamicToolDirectNames(params, tools, false),
      });

      expect(bridge.specs).toContainEqual({
        type: "namespace",
        name: CODEX_OPENCLAW_DIRECT_DYNAMIC_TOOL_NAMESPACE,
        description: "",
        tools: [expect.objectContaining({ type: "function", name: "openclaw" })],
      });
      expect(bridge.specs).toContainEqual(
        expect.objectContaining({ type: "function", name: "message" }),
      );
      const ordinarySpec = expect.objectContaining({ type: "function", name: "session_status" });
      expect(bridge.specs).toContainEqual(
        loading === "direct"
          ? ordinarySpec
          : {
              type: "namespace",
              name: "openclaw",
              description: "",
              tools: [expect.objectContaining({ name: "session_status", deferLoading: true })],
            },
      );
    },
  );

  it.each(["core policy", "Codex excludes", "turn allowlist"])(
    "filters the real regular delegate when denied by %s",
    async (policy) => {
      const workspaceDir = path.join(tempDir, "workspace");
      const params = createParams(path.join(tempDir, "session.jsonl"), workspaceDir);
      params.config = policy === "core policy" ? { tools: { deny: ["openclaw"] } } : {};
      params.toolsAllow = policy === "turn allowlist" ? ["message"] : ["openclaw", "message"];
      setCodexTestToolFactory(params, (options) =>
        createOpenClawCodingTools(options).filter((tool) =>
          ["openclaw", "message"].includes(tool.name),
        ),
      );

      const tools = await buildDynamicToolsForTest(params, workspaceDir, {
        sandbox: null,
        isHostScopedToolActive: () => false,
        pluginConfig: policy === "Codex excludes" ? { codexDynamicToolsExclude: ["openclaw"] } : {},
      });

      expect(tools.map((tool) => tool.name)).toEqual(["message"]);
    },
  );

  it.each([
    {
      label: "active exact host scope",
      hostActive: true,
      toolsAllow: ["openclaw"],
      expected: ["openclaw"],
    },
    { label: "inactive host scope", hostActive: false, toolsAllow: ["openclaw"], expected: [] },
    {
      label: "a wider public allowlist",
      hostActive: true,
      toolsAllow: ["openclaw", "read"],
      expected: [],
    },
  ])(
    "applies the host-tool exclusion exception only for $label",
    async ({ hostActive, toolsAllow, expected }) => {
      const workspaceDir = path.join(tempDir, "workspace");
      const params = createParams(path.join(tempDir, "session.jsonl"), workspaceDir);
      params.toolsAllow = toolsAllow;
      setCodexTestToolFactory(params, () => [
        { ...createRuntimeDynamicTool("openclaw"), catalogMode: "direct-only" },
      ]);
      const tools = await buildDynamicToolsForTest(params, workspaceDir, {
        isHostScopedToolActive: (toolName) => hostActive && toolName === "openclaw",
        pluginConfig: { codexDynamicToolsExclude: ["openclaw"] },
      });
      expect(tools.map((tool) => tool.name)).toEqual(expected);
    },
  );

  it.each([
    { name: "a nano model without tool search", model: "openai/gpt-5.4-nano", options: {} },
    {
      name: "a remote connection",
      model: "openai/gpt-5.5",
      options: { connectionClass: "remote" as const },
    },
  ])("uses direct tools for $name", ({ model, options }) => {
    const tools = [createRuntimeDynamicTool("message"), createRuntimeDynamicTool("web_search")];
    const loading = resolveCodexDynamicToolsLoadingForRuntime({}, model, options);
    const bridge = createCodexDynamicToolBridge({
      tools,
      signal: new AbortController().signal,
      loading,
    });
    expect(loading).toBe("direct");
    expect(resolveCodexDynamicToolsLoadingForRuntime({}, "gpt-5.4-nano")).toBe("direct");
    expect(resolveCodexDynamicToolsLoadingForRuntime({}, "gpt-5.5")).toBe("searchable");
    expect(resolveCodexDynamicToolsLoadingForRuntime({}, "openai/gpt-5.5")).toBe("searchable");
    expect(bridge.specs).toHaveLength(2);
    expect(flattenCodexDynamicToolFunctions(bridge.specs).map((tool) => tool.name)).toEqual([
      "message",
      "web_search",
    ]);
    expect(bridge.specs.some((tool) => tool.type === "namespace")).toBe(false);
    const webSearch = flattenCodexDynamicToolFunctions(bridge.specs).find(
      (tool) => tool.name === "web_search",
    );
    expect(webSearch).not.toHaveProperty("deferLoading");
    expect(webSearch).not.toHaveProperty("namespace");
  });

  it.each(["unreadable entry", "non-object schema"])(
    "quarantines a plugin's %s before Codex filtering",
    async (invalid) => {
      const warn = vi.spyOn(embeddedAgentLog, "warn").mockImplementation(() => undefined);
      const messageTool = createRuntimeDynamicTool("message");
      const sourceTools: RuntimeDynamicToolForTest[] =
        invalid === "unreadable entry"
          ? new Proxy([messageTool], {
              get(target, property, receiver) {
                if (property === "0") {
                  throw new Error("fuzzplugin tool entry getter exploded");
                }
                if (property === "1") {
                  return messageTool;
                }
                if (property === "length") {
                  return 2;
                }
                return Reflect.get(target, property, receiver);
              },
            })
          : [
              {
                ...createRuntimeDynamicTool("dofbot_move_angles"),
                parameters: { type: "array", items: { type: "number" } },
              },
              messageTool,
            ];
      const workspaceDir = path.join(tempDir, "workspace");
      const params = createParams(path.join(tempDir, "session.jsonl"), workspaceDir);
      setCodexTestToolFactory(params, () => sourceTools);

      await expect(buildDynamicToolsForTest(params, workspaceDir)).resolves.toEqual([messageTool]);
      if (invalid === "non-object schema") {
        expect(warn).toHaveBeenCalledWith(
          "codex app-server quarantined 1 unsupported runtime tool schema before dynamic tool registration",
          expect.objectContaining({
            runId: "run-1",
            sessionId: "session-1",
            diagnostics: [
              {
                index: 0,
                tool: "dofbot_move_angles",
                violations: ['dofbot_move_angles.parameters.type must be "object"'],
                violationCount: 1,
              },
            ],
          }),
        );
      }
    },
  );

  it("maps Podman sandbox network config into Codex external sandbox policy", () => {
    expect(
      resolveCodexExternalSandboxPolicyForOpenClawSandbox({
        enabled: true,
        backendId: "podman",
        docker: { network: "none" },
      } as never),
    ).toEqual({ type: "externalSandbox", networkAccess: "restricted" });

    expect(
      resolveCodexExternalSandboxPolicyForOpenClawSandbox({
        enabled: true,
        backendId: "Podman",
        docker: { network: "bridge" },
      } as never),
    ).toEqual({ type: "externalSandbox", networkAccess: "enabled" });
  });

  it.each([
    {
      label: "an active sandbox",
      options: { sandbox: { enabled: true, backendId: "docker" } as never },
      params: {},
      pluginConfig: {},
    },
    {
      label: "a node-default execution policy",
      options: {},
      params: { execOverrides: { host: "node" } },
      pluginConfig: {},
    },
  ])("does not expose the Gateway shell path under $label", async (testCase) => {
    const workspaceDir = path.join(tempDir, "workspace");
    const params = createParams(path.join(tempDir, "gateway-policy-session.jsonl"), workspaceDir);
    setCodexTestToolFactory(params, () => [
      createRuntimeDynamicTool("exec"),
      createRuntimeDynamicTool("process"),
      createRuntimeDynamicTool("message"),
    ]);
    Object.assign(params, testCase.params);

    const tools = await buildDynamicToolsForTest(params, workspaceDir, {
      nativeToolSurfaceEnabled: true,
      pluginConfig: testCase.pluginConfig,
      ...testCase.options,
    });

    expect(tools.map((tool) => tool.name)).not.toContain("gateway_exec");
    expect(tools.map((tool) => tool.name)).not.toContain("gateway_process");
  });

  it.each([
    { excluded: "process", expected: ["message", "gateway_exec"] },
    { excluded: "exec", expected: ["message"] },
  ])("applies the partial Gateway shell exclusion for $excluded", async (testCase) => {
    const workspaceDir = path.join(tempDir, "workspace");
    const params = createParams(path.join(tempDir, "gateway-exclusion.jsonl"), workspaceDir);
    params.execOverrides = { host: "gateway" };
    await bindProductionCodexHostCapabilities(params, hostCapabilityClosers);

    const tools = await buildDynamicToolsForTest(params, workspaceDir, {
      nativeToolSurfaceEnabled: true,
      pluginConfig: { codexDynamicToolsExclude: [testCase.excluded] },
    });

    expect(shellTestToolNames(tools)).toEqual(testCase.expected);
  });

  it("shares discovery across attempt catalogs but refreshes the next attempt", async () => {
    const workspaceDir = path.join(tempDir, "workspace");
    const params = createParams(path.join(tempDir, "catalog-discovery.jsonl"), workspaceDir);
    setCodexTestToolFactory(params, () => [createRuntimeDynamicTool("exec")]);
    hoisted.loadNodeExecAvailability.mockClear();
    for (const available of [true, false]) {
      hoisted.loadNodeExecAvailability.mockResolvedValue({
        cacheKey: String(available),
        isAvailable: () => available,
      });
      const nodeExecAvailability = {};
      for (const ignoreRuntimePlan of [false, true]) {
        const tools = await buildDynamicToolsForTest(params, workspaceDir, {
          nodeExecAvailability,
          ignoreRuntimePlan,
        });
        expect(tools.some((tool) => tool.name === "node_exec")).toBe(available);
      }
    }
    expect(hoisted.loadNodeExecAvailability).toHaveBeenCalledTimes(2);
  });

  it("propagates cancellation during node discovery without publishing tools", async () => {
    const workspaceDir = path.join(tempDir, "workspace");
    const params = createParams(path.join(tempDir, "cancel-discovery.jsonl"), workspaceDir);
    setCodexTestToolFactory(params, () => [createRuntimeDynamicTool("exec")]);
    const runAbortController = new AbortController();
    const reason = new Error("synthetic attempt cancelled");
    hoisted.loadNodeExecAvailability.mockImplementationOnce(async (signal: AbortSignal) => {
      expect(signal).toBe(runAbortController.signal);
      runAbortController.abort(reason);
      return { cacheKey: "eligible", isAvailable: () => true };
    });
    await expect(
      buildDynamicToolsForTest(params, workspaceDir, { runAbortController }),
    ).rejects.toBe(reason);
  });

  it("exposes pinned node shell tools for node-targeted Codex app-server runs", async () => {
    const execTool = {
      ...createRuntimeDynamicTool("exec"),
      parameters: {
        type: "object",
        properties: {
          command: { type: "string" },
          workdir: { type: "string" },
          host: { type: "string" },
          security: { type: "string" },
          ask: { type: "string" },
          node: { type: "string" },
          background: { type: "boolean" },
          yieldMs: { type: "number" },
          pty: { type: "boolean" },
          elevated: { type: "boolean" },
        },
        required: ["command", "host", "node", "background", "yieldMs", "pty", "elevated"],
        additionalProperties: false,
      },
    };
    vi.mocked(execTool.execute).mockResolvedValueOnce({
      content: [
        {
          type: "text",
          text: "Command still running (session exec-1, pid 123). Use process (list/poll/log/write/send-keys/submit/paste/kill/clear/remove) for follow-up.",
        },
      ],
      details: { status: "running" },
    });

    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const params = createParams(sessionFile, workspaceDir);
    setCodexTestToolFactory(params, () => [execTool, createRuntimeDynamicTool("message")]);
    params.execOverrides = {
      host: "node",
      node: "mac-mini",
      security: "full",
      ask: "off",
    };

    const nativeToolSurfaceEnabled = shouldEnableCodexAppServerNativeToolSurface(params);
    const tools = await buildDynamicToolsForTest(params, workspaceDir, {
      nativeToolSurfaceEnabled,
    });

    expect(nativeToolSurfaceEnabled).toBe(false);
    expect(tools.map((tool) => tool.name)).toEqual(["message", "node_exec"]);
    const nodeExec = tools.find((tool) => tool.name === "node_exec");
    expect(nodeExec?.description).toContain("host=node internally");
    expect(nodeExec?.description).toContain("background follow-up is unavailable");
    expect(nodeExec?.parameters).toEqual({
      type: "object",
      properties: {
        command: { type: "string" },
        workdir: { type: "string" },
      },
      required: ["command"],
      additionalProperties: false,
    });
    const result = await nodeExec?.execute(
      "call-1",
      {
        command: "pwd",
        host: "gateway",
        node: "model-selected-node",
        security: "full",
        ask: "off",
        background: true,
        yieldMs: 10,
        pty: true,
        elevated: true,
      },
      undefined,
    );
    expect(execTool.execute).toHaveBeenCalledWith(
      "call-1",
      {
        command: "pwd",
        host: "node",
        node: "mac-mini",
      },
      undefined,
      undefined,
    );
    expect(result?.content).toEqual([
      {
        type: "text",
        text: "Command still running (session exec-1, pid 123). Remote-node background follow-up is unavailable. Wait for the command to complete.",
      },
    ]);

    const runtimePolicySessionFile = path.join(tempDir, "runtime-policy-session.jsonl");
    const runtimePolicyParams = createParams(runtimePolicySessionFile, workspaceDir);
    setCodexTestToolFactory(runtimePolicyParams, () => [
      execTool,
      createRuntimeDynamicTool("message"),
    ]);
    runtimePolicyParams.sessionKey = "agent:main:session-1";
    runtimePolicyParams.sandboxSessionKey = "agent:policy:session-1";
    runtimePolicyParams.sandboxAgentId = "policy";
    runtimePolicyParams.config = {
      agents: {
        entries: {
          main: { tools: { exec: { host: "gateway" } } },
          policy: { tools: { exec: { host: "node", node: "worker-1" } } },
        },
      },
    } as never;
    const runtimePolicyNativeToolSurfaceEnabled = shouldEnableCodexAppServerNativeToolSurface(
      runtimePolicyParams,
      undefined,
      { agentId: "policy", runtimeSessionKey: "agent:policy:session-1" },
    );
    const runtimePolicyTools = await buildDynamicToolsForTest(runtimePolicyParams, workspaceDir, {
      sandboxSessionKey: "agent:policy:session-1",
      nativeToolSurfaceEnabled: runtimePolicyNativeToolSurfaceEnabled,
      sessionAgentId: "main",
    });

    expect(runtimePolicyNativeToolSurfaceEnabled).toBe(false);
    expect(runtimePolicyTools.map((tool) => tool.name)).toEqual(["message", "node_exec"]);
  });

  it("does not expose Gateway process sessions as remote-node control in auto host runs", async () => {
    const sessionFile = path.join(tempDir, "auto-node-session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const params = createParams(sessionFile, workspaceDir);
    await bindProductionCodexHostCapabilities(params, hostCapabilityClosers);
    const tools = await buildDynamicToolsForTest(params, workspaceDir, {
      sandbox: null,
      nativeToolSurfaceEnabled: true,
    });

    expect(shellTestToolNames(tools)).toEqual([
      "message",
      "gateway_exec",
      "gateway_process",
      "node_exec",
    ]);
    const bridge = createCodexDynamicToolBridge({
      tools,
      signal: new AbortController().signal,
      loading: "direct",
    });
    const nodeList = await bridge.handleToolCall({
      threadId: "auto-thread",
      turnId: "auto-turn",
      tool: "node_process",
      callId: "node-process-list",
      arguments: { action: "list" },
    });
    expect(nodeList.success).toBe(false);
    expect(nodeList.contentItems).toEqual([
      { type: "inputText", text: "Unknown OpenClaw tool: node_process" },
    ]);
    const nodeExec = tools.find((tool) => tool.name === "node_exec");
    expect(nodeExec?.description).toContain(
      "The sole connected node that can execute commands is selected automatically; select by name or id when several can.",
    );
    expect(nodeExec?.parameters).toMatchObject({
      type: "object",
      properties: {
        command: { type: "string" },
        node: { type: "string" },
      },
      required: ["command"],
    });
    expect(nodeExec?.parameters).not.toHaveProperty("properties.host");
    expect(nodeExec?.parameters).not.toHaveProperty("properties.security");
    expect(nodeExec?.parameters).not.toHaveProperty("properties.ask");
    const boundAutoParams = createParams(
      path.join(tempDir, "bound-auto-node-session.jsonl"),
      workspaceDir,
    );
    boundAutoParams.config = {
      tools: { exec: { host: "auto", node: "bound-mac-mini" } },
    } as never;
    await bindProductionCodexHostCapabilities(boundAutoParams, hostCapabilityClosers);
    const boundAutoTools = await buildDynamicToolsForTest(boundAutoParams, workspaceDir, {
      nativeToolSurfaceEnabled: true,
    });
    const boundNodeExec = boundAutoTools.find((tool) => tool.name === "node_exec");
    expect(boundNodeExec?.parameters).toMatchObject({
      type: "object",
      properties: { command: { type: "string" } },
      required: ["command"],
    });
    expect(boundNodeExec?.parameters).not.toHaveProperty("properties.node");
    const gatewayParams = createParams(
      path.join(tempDir, "gateway-node-session.jsonl"),
      workspaceDir,
    );
    gatewayParams.execOverrides = { host: "gateway" };
    await bindProductionCodexHostCapabilities(gatewayParams, hostCapabilityClosers);
    const gatewayTools = await buildDynamicToolsForTest(gatewayParams, workspaceDir, {
      nativeToolSurfaceEnabled: true,
    });
    expect(shellTestToolNames(gatewayTools)).toEqual([
      "message",
      "gateway_exec",
      "gateway_process",
    ]);

    const allowlistedParams = {
      ...gatewayParams,
      toolsAllow: ["message"],
    } as EmbeddedRunAttemptParams;
    const allowlistedTools = await buildDynamicToolsForTest(allowlistedParams, workspaceDir, {
      nativeToolSurfaceEnabled: true,
    });
    expect(shellTestToolNames(allowlistedTools)).toEqual(["message"]);
  });

  it("restores the policy-filtered OpenClaw shell when a finite allowlist disables native Code Mode", async () => {
    const execTool = createRuntimeDynamicTool("exec");
    const processTool = createRuntimeDynamicTool("process");
    const messageTool = createRuntimeDynamicTool("message");

    const workspaceDir = path.join(tempDir, "workspace");
    const params = createParams(path.join(tempDir, "restricted-session.jsonl"), workspaceDir);
    setCodexTestToolFactory(params, () => [execTool, processTool, messageTool]);
    params.toolsAllow = ["exec", "process", "message"];
    const nativeToolSurfaceEnabled = shouldEnableCodexAppServerNativeToolSurface(params);

    const tools = await buildDynamicToolsForTest(params, workspaceDir, {
      nativeToolSurfaceEnabled,
    });

    expect(nativeToolSurfaceEnabled).toBe(false);
    expect(tools.map((tool) => tool.name)).toEqual(["exec", "process", "message", "node_exec"]);
    expect(
      tools
        .filter((tool) => ["exec", "process", "node_exec"].includes(tool.name))
        .map((tool) => tool.catalogMode),
    ).toEqual(["direct-only", "direct-only", "direct-only"]);

    const bridge = createCodexDynamicToolBridge({
      tools,
      signal: new AbortController().signal,
      loading: "direct",
    });
    expect(bridge.specs).toContainEqual({
      type: "namespace",
      name: CODEX_OPENCLAW_DIRECT_DYNAMIC_TOOL_NAMESPACE,
      description: "",
      tools: expect.arrayContaining([
        expect.objectContaining({ name: "exec" }),
        expect.objectContaining({ name: "process" }),
        expect.objectContaining({ name: "node_exec" }),
      ]),
    });
    await bridge.handleToolCall({
      threadId: "restricted-thread",
      turnId: "restricted-turn",
      tool: "exec",
      callId: "restricted-exec",
      arguments: { command: "echo restored" },
    });
    expect(execTool.execute).toHaveBeenCalledWith(
      "restricted-exec",
      { command: "echo restored" },
      expect.any(AbortSignal),
      undefined,
    );

    const excludedTools = await buildDynamicToolsForTest(params, workspaceDir, {
      nativeToolSurfaceEnabled,
      pluginConfig: { codexDynamicToolsExclude: ["exec", "process"] },
    });
    expect(excludedTools.map((tool) => tool.name)).toEqual(["message"]);

    const messageOnlyTools = await buildDynamicToolsForTest(
      { ...params, toolsAllow: ["message"] },
      workspaceDir,
      { nativeToolSurfaceEnabled: false },
    );
    expect(messageOnlyTools.map((tool) => tool.name)).toEqual(["message"]);
  });

  it.each([
    { allow: ["cron"], expected: ["automations"] },
    { allow: ["group:fs"], expected: ["read", "write", "edit", "apply_patch"] },
    { allow: ["web_*"], expected: ["web_search", "web_fetch"] },
    { allow: ["*fetch"], expected: ["web_fetch"] },
    { allow: ["group:runtime"], expected: ["exec", "process"] },
  ])(
    "preserves shared runtime selectors in Codex dynamic tools: $allow",
    async ({ allow, expected }) => {
      const workspaceDir = path.join(tempDir, "workspace");
      const params = createParams(path.join(tempDir, "selector-session.jsonl"), workspaceDir);
      setCodexTestToolFactory(params, () =>
        [
          "automations",
          "read",
          "write",
          "edit",
          "apply_patch",
          "web_search",
          "web_fetch",
          "exec",
          "process",
          "message",
        ].map(createRuntimeDynamicTool),
      );
      params.execOverrides = { host: "gateway" };
      params.toolsAllow = allow;

      const tools = await buildDynamicToolsForTest(params, workspaceDir, {
        nativeToolSurfaceEnabled: false,
      });

      expect(tools.map((tool) => tool.name)).toEqual(expected);
    },
  );

  it.each([false, true])(
    "selects the tool auth profile store when provided=%s",
    async (separateToolStore) => {
      const workspaceDir = path.join(tempDir, "workspace");
      const params = createParams(path.join(tempDir, "session.jsonl"), workspaceDir);
      const oauthProfile = {
        provider: "openai",
        type: "oauth",
        access: "transport-token",
        refresh: "transport-refresh",
        expires: 4_000_000_000_000,
      } as const;
      const authProfileStore: EmbeddedRunAttemptParams["authProfileStore"] = separateToolStore
        ? { version: 1, profiles: { "openai:work": oauthProfile } }
        : {
            version: 1,
            profiles: {
              "openai:api-key-backup": {
                provider: "openai",
                type: "api_key",
                key: "not-a-real-key",
              },
            },
          };
      const toolAuthProfileStore: EmbeddedRunAttemptParams["toolAuthProfileStore"] =
        separateToolStore
          ? {
              version: 1,
              profiles: {
                "openai:work": oauthProfile,
                "xai:work": {
                  provider: "xai",
                  type: "oauth",
                  access: "xai-token",
                  refresh: "xai-refresh",
                  expires: 4_000_000_000_000,
                },
              },
            }
          : undefined;
      params.authProfileStore = authProfileStore;
      params.toolAuthProfileStore = toolAuthProfileStore;
      params.messageActionTurnCapability = "turn-capability-1";
      const factory = vi.fn((_options: Parameters<typeof createOpenClawCodingTools>[0]) => []);
      setCodexTestToolFactory(params, factory);

      await buildDynamicToolsForTest(params, workspaceDir, { sandbox: null });

      expect(factory).toHaveBeenCalledOnce();
      expect(factory.mock.calls[0]?.[0]?.authProfileStore).toBe(
        toolAuthProfileStore ?? authProfileStore,
      );
      expect(factory.mock.calls[0]?.[0]?.messageActionTurnCapability).toBe("turn-capability-1");
    },
  );

  it("quarantines exposed Codex memory writes and edits after a network tool", async () => {
    vi.stubEnv("OPENCLAW_BUILD_PRIVATE_QA", "1");
    vi.stubEnv("OPENCLAW_QA_FORCE_RUNTIME", "codex");
    const workspaceDir = path.join(tempDir, "workspace");
    await fs.mkdir(path.join(workspaceDir, "memory"), { recursive: true });
    {
      let turnTainted = false;
      const params = createParams(path.join(tempDir, "session.jsonl"), workspaceDir);
      params.config = { tools: { fs: { workspaceOnly: true } } };
      params.provider = "openai";
      params.model = createCodexTestModel("openai");
      params.senderIsOwner = true;
      params.onToolOutcome = vi.fn((outcome) => {
        if (!outcome.presentationOnly && outcome.resultContentSource === "network") {
          turnTainted = true;
        }
      });
      params.isTurnTainted = () => turnTainted;
      setCodexTestToolFactory(params, (options) => {
        const filesystemTools = createOpenClawCodingTools(options).filter((tool) =>
          ["write", "edit"].includes(tool.name),
        );
        const networkTool = wrapToolWithBeforeToolCallHook(
          { ...createRuntimeDynamicTool("web_fetch"), resultContentSource: "network" },
          {
            agentId: "main",
            sessionKey: options?.sessionKey,
            sessionId: options?.sessionId,
            runId: options?.runId,
            onToolOutcome: options?.onToolOutcome,
          },
          { emitDiagnostics: false },
        );
        return [...filesystemTools, networkTool];
      });

      const tools = await buildDynamicToolsForTest(params, workspaceDir, {
        sandbox: null as never,
      });
      const tool = (name: string) =>
        expectDefined(
          tools.find((candidate) => candidate.name === name),
          `Codex ${name} dynamic tool`,
        );
      await tool("write").execute("codex-trusted-write", {
        path: "memory/trusted.md",
        content: "owner note\n",
      });
      await tool("web_fetch").execute("codex-network-call", {});
      expect(params.onToolOutcome).toHaveBeenCalledWith(
        expect.objectContaining({ toolName: "web_fetch", resultContentSource: "network" }),
      );
      expect(params.isTurnTainted()).toBe(true);

      await tool("write").execute("codex-network-write", {
        path: "memory/network.md",
        content: "network note\n",
      });
      await tool("edit").execute("codex-network-edit", {
        path: "memory/trusted.md",
        edits: [{ oldText: "owner note", newText: "network edit" }],
      });

      const freshParams = createParams(path.join(tempDir, "fresh-session.jsonl"), workspaceDir);
      freshParams.config = params.config;
      freshParams.provider = "openai";
      freshParams.model = createCodexTestModel("openai");
      freshParams.runId = "codex-fresh-run";
      freshParams.senderIsOwner = true;
      freshParams.sessionId = "codex-fresh-session";
      freshParams.sessionKey = "agent:main:codex-fresh-session";
      freshParams.isTurnTainted = () => false;
      const freshTools = await buildDynamicToolsForTest(freshParams, workspaceDir, {
        sandbox: null as never,
      });
      await expectDefined(
        freshTools.find((candidate) => candidate.name === "write"),
        "fresh Codex write tool",
      ).execute("codex-fresh-write", {
        path: "memory/fresh.md",
        content: "fresh owner note\n",
      });

      await expect(
        Promise.all(
          ["memory/trusted.md", "memory/network.md", "memory/fresh.md"].map((relativePath) =>
            readMemoryArtifactProvenance({ workspaceDir, relativePath }),
          ),
        ),
      ).resolves.toEqual([
        expect.objectContaining({ originClass: "untrusted" }),
        expect.objectContaining({ originClass: "untrusted" }),
        expect.objectContaining({ originClass: "agent" }),
      ]);
      await expect(fs.readFile(path.join(workspaceDir, "memory/trusted.md"), "utf8")).resolves.toBe(
        "network edit\n",
      );
      await expect(fs.readFile(path.join(workspaceDir, "memory/network.md"), "utf8")).resolves.toBe(
        "network note\n",
      );
    }
  });

  it("builds the durable registered-tool superset without loading a provider runtime", async () => {
    const sessionFile = path.join(tempDir, "session-registered-tools.jsonl");
    const workspaceDir = path.join(tempDir, "workspace-registered-tools");
    const params = createParams(sessionFile, workspaceDir);
    const runtimePlan = createCodexRuntimePlanFixture();
    const planNormalize = vi.fn((tools: RuntimeDynamicToolForTest[]) =>
      tools.map((tool) => ({ ...tool, description: `turn:${tool.description}` })),
    );
    runtimePlan.tools.normalize = planNormalize as typeof runtimePlan.tools.normalize;
    params.runtimePlan = runtimePlan;
    const messageTool = createRuntimeDynamicTool("message");
    const heartbeatTool = createRuntimeDynamicTool("heartbeat_respond");
    const invalidTool = {
      ...createRuntimeDynamicTool("invalid_registered_tool"),
      parameters: { type: "array", items: { type: "string" } },
    };
    setCodexTestToolFactory(params, (options) => [
      messageTool,
      ...(options?.enableHeartbeatTool === true ? [heartbeatTool, invalidTool] : []),
    ]);

    const turnTools = await buildDynamicToolsForTest(params, workspaceDir, {
      sandbox: null as never,
    });
    const registeredTools = await buildDynamicToolsForTest(params, workspaceDir, {
      forceHeartbeatTool: true,
      ignoreDisableMessageTool: true,
      ignoreRuntimePlan: true,
      sandbox: null as never,
    });

    expect(planNormalize).toHaveBeenCalledOnce();
    expect(hoisted.normalizeAgentRuntimeTools).toHaveBeenCalledTimes(2);
    expect(hoisted.normalizeAgentRuntimeTools.mock.calls[0]?.[0]).toMatchObject({
      runtimePlan,
    });
    expect(hoisted.normalizeAgentRuntimeTools.mock.calls[1]?.[0]).toMatchObject({
      allowProviderRuntimePluginLoad: false,
      runtimePlan: undefined,
    });
    expect(hoisted.normalizeAgentRuntimeTools.mock.calls[1]?.[0]).not.toHaveProperty(
      "runtimeHandle",
    );
    expect(turnTools.map((tool) => tool.name)).toEqual(["message"]);
    expect(turnTools[0]?.description).toBe(`turn:${messageTool.description}`);
    expect(registeredTools.map((tool) => tool.name)).toEqual(["message", "heartbeat_respond"]);
    expect(registeredTools.map((tool) => tool.description)).toEqual([
      messageTool.description,
      heartbeatTool.description,
    ]);
    expect(hoisted.resolveWebSearchToolPolicy).not.toHaveBeenCalled();
  });

  it("enables gateway subagent binding for forced private QA Codex runs", async () => {
    vi.stubEnv("OPENCLAW_BUILD_PRIVATE_QA", "1");
    vi.stubEnv("OPENCLAW_QA_FORCE_RUNTIME", "codex");
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const params = createParams(sessionFile, workspaceDir);
    const factoryOptions: unknown[] = [];
    setCodexTestToolFactory(params, (options) => {
      factoryOptions.push(options);
      return [createRuntimeDynamicTool("sessions_spawn")];
    });

    const tools = await buildDynamicToolsForTest(params, workspaceDir, { sandbox: null as never });

    expect(factoryOptions).toHaveLength(1);
    const factoryOption = factoryOptions[0] as { allowGatewaySubagentBinding?: unknown };
    expect(factoryOption.allowGatewaySubagentBinding).toBe(true);
    expect(tools.map((tool) => tool.name)).toEqual(["sessions_spawn"]);
  });

  it.each([
    { label: "unresolved", sandbox: undefined, expectedExecHost: "sandbox" },
    { label: "resolved absent", sandbox: null, expectedExecHost: "gateway" },
  ])(
    "preserves prepared execution policy and restricted allowlists with $label sandbox",
    async ({ sandbox, expectedExecHost }) => {
      const workspaceDir = path.join(tempDir, "workspace");
      const params = createParams(path.join(tempDir, "session.jsonl"), workspaceDir);
      params.config = { agents: { defaults: { sandbox: { mode: "all" } } } };
      const prepared = await prepareCodexNativeExecutionPolicyForRun(params, { sandbox });
      expect(prepared.policy.effectiveExecHost).toBe(expectedExecHost);
      const nodePolicy = await prepareCodexNativeExecutionPolicyForRun(
        { ...params, execOverrides: { host: "node", node: "synthetic-node" } },
        { sandbox },
      );
      const cases: Array<[string[] | undefined, typeof prepared, boolean]> = [
        [undefined, prepared, true],
        [["*"], prepared, true],
        [[], prepared, false],
        [["message"], prepared, false],
        [["*"], nodePolicy, false],
      ];
      for (const [toolsAllow, nativeExecutionPolicy, enabled] of cases) {
        params.toolsAllow = toolsAllow;
        expect(
          shouldEnableCodexAppServerNativeToolSurface(params, sandbox, { nativeExecutionPolicy }),
        ).toBe(enabled);
      }
    },
  );

  it("disables Codex native tool surfaces when all tools are disabled", () => {
    const workspaceDir = path.join(tempDir, "workspace");
    const params = createParams(path.join(tempDir, "session.jsonl"), workspaceDir);
    params.disableTools = true;

    expect(shouldEnableCodexAppServerNativeToolSurface(params)).toBe(false);
  });

  it("disables Codex native tool surfaces when the effective exec target is node", () => {
    const workspaceDir = path.join(tempDir, "workspace");
    const sessionParams = createParams(path.join(tempDir, "session.jsonl"), workspaceDir);
    sessionParams.execOverrides = {
      host: "node",
      node: "mac-mini",
      security: "full",
      ask: "off",
    };

    expect(shouldEnableCodexAppServerNativeToolSurface(sessionParams)).toBe(false);

    sessionParams.toolsAllow = ["*"];
    expect(shouldEnableCodexAppServerNativeToolSurface(sessionParams)).toBe(false);

    const globalParams = createParams(path.join(tempDir, "global-session.jsonl"), workspaceDir);
    globalParams.config = { tools: { exec: { host: "node" } } } as never;

    expect(shouldEnableCodexAppServerNativeToolSurface(globalParams)).toBe(false);

    const autoOverrideParams = createParams(
      path.join(tempDir, "auto-override-session.jsonl"),
      workspaceDir,
    );
    autoOverrideParams.config = { tools: { exec: { host: "node" } } } as never;
    autoOverrideParams.execOverrides = { host: "auto" };

    expect(shouldEnableCodexAppServerNativeToolSurface(autoOverrideParams)).toBe(true);

    const agentParams = createParams(path.join(tempDir, "agent-session.jsonl"), workspaceDir);
    agentParams.config = {
      agents: {
        entries: { main: { tools: { exec: { host: "node" } } } },
      },
    } as never;

    expect(
      shouldEnableCodexAppServerNativeToolSurface(agentParams, undefined, {
        agentId: "main",
      }),
    ).toBe(false);

    const runtimePolicyParams = createParams(
      path.join(tempDir, "runtime-policy-session.jsonl"),
      workspaceDir,
    );
    runtimePolicyParams.sessionKey = "agent:main:session-1";
    runtimePolicyParams.sandboxSessionKey = "agent:policy:session-1";
    runtimePolicyParams.config = {
      agents: {
        entries: {
          main: { tools: { exec: { host: "gateway" } } },
          policy: { tools: { exec: { host: "node", node: "worker-1" } } },
        },
      },
    } as never;

    expect(shouldEnableCodexAppServerNativeToolSurface(runtimePolicyParams)).toBe(false);
  });

  it("keeps sandbox exec-server native surfaces behind sandbox tool policy", () => {
    const workspaceDir = path.join(tempDir, "workspace");
    const params = createParams(path.join(tempDir, "session.jsonl"), workspaceDir);
    const sandbox = {
      enabled: true,
      backendId: "docker",
      backend: {},
      tools: {
        allow: ["exec", "process", "read", "write", "edit", "apply_patch"],
        deny: [],
      },
    };

    expect(
      shouldEnableCodexAppServerNativeToolSurface(params, sandbox as never, {
        sandboxExecServerEnabled: true,
      }),
    ).toBe(true);

    expect(
      shouldEnableCodexAppServerNativeToolSurface(
        params,
        {
          ...sandbox,
          backendId: "node",
          backend: undefined,
          placementExecutionMode: "remote-exec",
          placementNodeId: "device-1",
        } as never,
        { sandboxExecServerEnabled: true },
      ),
    ).toBe(true);

    expect(
      shouldEnableCodexAppServerNativeToolSurface(
        params,
        {
          ...sandbox,
          tools: { allow: ["exec"], deny: [] },
        } as never,
        { sandboxExecServerEnabled: true },
      ),
    ).toBe(false);

    expect(
      shouldEnableCodexAppServerNativeToolSurface(
        params,
        {
          ...sandbox,
          tools: { allow: [], deny: ["write"] },
        } as never,
        { sandboxExecServerEnabled: true },
      ),
    ).toBe(false);

    params.toolsAllow = ["message"];
    expect(
      shouldEnableCodexAppServerNativeToolSurface(params, sandbox as never, {
        sandboxExecServerEnabled: true,
      }),
    ).toBe(false);
  });

  it.each(["text", "initial audio", "accepted audio steering"])(
    "applies inbound TTS to a final dynamic message for %s",
    async (input) => {
      const workspaceDir = path.join(tempDir, "workspace");
      vi.stubEnv("OPENCLAW_STATE_DIR", path.join(tempDir, "state"));
      const synthesize = vi.fn(async (_request: { text: string }) => ({
        audioBuffer: Buffer.from("synthetic speech"),
        fileExtension: ".ogg",
        outputFormat: "ogg",
        voiceCompatible: true,
      }));
      const sendMedia = vi.fn(async (_context: { mediaUrl?: string }) => ({
        channel: "whatsapp",
        messageId: "voice-reply",
      }));
      const sendText = vi.fn(async () => ({ channel: "whatsapp", messageId: "text-reply" }));
      const channel = createOutboundTestPlugin({
        id: "whatsapp",
        capabilities: {
          chatTypes: ["direct"],
          media: true,
          tts: { voice: { synthesisTarget: "voice-note" } },
        },
        outbound: {
          deliveryMode: "direct",
          resolveTarget: ({ to }) => ({ ok: true, to: to ?? "+12025550123" }),
          sendText,
          sendMedia,
        },
      });
      channel.config.listAccountIds = () => ["default"];
      const registry = createTestRegistry([
        { pluginId: "whatsapp", source: "test", plugin: channel },
      ]);
      registry.speechProviders.push({
        pluginId: "test-speech",
        source: "test",
        provider: { id: "test-speech", label: "Test speech", isConfigured: () => true, synthesize },
      });
      const previousRegistry = getActivePluginRegistry();
      const previousRuntimeConfig = getRuntimeConfigSnapshot();
      const previousSourceConfig = getRuntimeConfigSourceSnapshot();
      setActivePluginRegistry(registry);
      try {
        const params = createParams(path.join(tempDir, "session.jsonl"), workspaceDir);
        params.config = {
          tts: { auto: "inbound", provider: "test-speech" },
          channels: { whatsapp: { allowFrom: ["*"] } },
        };
        // Match Gateway config ownership so earlier tool construction cannot supply TTS policy.
        setRuntimeConfigSnapshot(params.config, params.config);
        params.messageChannel = "whatsapp";
        params.currentInboundAudio = input === "initial audio";
        const replyOperation = { acceptedSteeredInboundAudio: false };
        params.replyOperation = replyOperation as EmbeddedRunAttemptParams["replyOperation"];
        params.sourceReplyDeliveryMode = "message_tool_only";
        setCodexTestToolFactory(params, (options) =>
          createOpenClawCodingTools(options).filter((tool) => tool.name === "message"),
        );
        const tools = await buildDynamicToolsForTest(params, workspaceDir, {
          sandbox: null as never,
        });
        // Accepted steering must reach tools that were already constructed.
        replyOperation.acceptedSteeredInboundAudio = input === "accepted audio steering";
        const bridge = createCodexDynamicToolBridge({
          tools,
          signal: new AbortController().signal,
        });

        const result = await bridge.handleToolCall({
          threadId: "thread-1",
          turnId: "turn-1",
          callId: "voice-final",
          namespace: null,
          tool: "message",
          arguments: {
            action: "send",
            channel: "whatsapp",
            target: "+12025550123",
            message: "Here is the requested spoken reply.",
            final: true,
          },
        });

        const expectsVoice = input !== "text";
        expect(result.success, JSON.stringify(result.contentItems)).toBe(true);
        expect(synthesize).toHaveBeenCalledTimes(expectsVoice ? 1 : 0);
        expect(sendMedia).toHaveBeenCalledTimes(expectsVoice ? 1 : 0);
        if (expectsVoice) {
          expect(sendMedia).toHaveBeenCalledWith(expect.objectContaining({ audioAsVoice: true }));
        } else {
          expect(sendText).toHaveBeenCalledOnce();
        }
      } finally {
        if (previousRuntimeConfig) {
          setRuntimeConfigSnapshot(previousRuntimeConfig, previousSourceConfig ?? undefined);
        } else {
          clearRuntimeConfigSnapshot();
        }
        for (const [sent] of sendMedia.mock.calls) {
          if (sent.mediaUrl) {
            await fs.rm(sent.mediaUrl, { force: true });
          }
        }
        if (previousRegistry) {
          setActivePluginRegistry(previousRegistry);
        } else {
          resetPluginRuntimeStateForTest();
        }
      }
    },
  );

  it.each([
    { sessionKey: "agent:main:main", required: undefined, expected: false },
    { sessionKey: "agent:main:subagent:child", required: undefined, expected: true },
    { sessionKey: "agent:main:subagent:child", required: false, expected: false },
    { sessionKey: "agent:main:main", required: true, expected: true },
  ])(
    "publishes the constructed target requirement for $sessionKey / $required",
    async ({ sessionKey, required, expected }) => {
      const workspaceDir = path.join(tempDir, "workspace");
      const params = createParams(path.join(tempDir, "session.jsonl"), workspaceDir);
      params.sessionKey = sessionKey;
      params.requireExplicitMessageTarget = required;
      const factory = vi.fn((_options: Parameters<typeof createOpenClawCodingTools>[0]) => []);
      const onMessageToolTargetResolved = vi.fn();
      setCodexTestToolFactory(params, factory);
      await buildDynamicToolsForTest(params, workspaceDir, { onMessageToolTargetResolved });
      expect(factory.mock.calls[0]?.[0]?.requireExplicitMessageTarget).toBe(expected);
      expect(onMessageToolTargetResolved).toHaveBeenCalledExactlyOnceWith(expected);
    },
  );
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
