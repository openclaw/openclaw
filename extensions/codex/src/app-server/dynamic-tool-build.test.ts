import fs from "node:fs/promises";
import "./dynamic-tool-build.test-support.js";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { createOpenClawCodingTools, type AnyAgentTool } from "openclaw/plugin-sdk/agent-harness";
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
  withAdmittedSessionTurnForTest,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { setRuntimeConfigSnapshot } from "openclaw/plugin-sdk/runtime-config-snapshot";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { registerCodexCompletionCommandTest } from "./dynamic-tool-build.completion.test-support.js";
import {
  disableCodexPluginThreadConfig,
  resolveCodexAppServerExecutionCwd,
  resolveCodexExternalSandboxPolicyForOpenClawSandbox,
  resolveCodexSandboxEnvironmentSelection,
  shouldEnableCodexAppServerNativeToolSurface,
} from "./dynamic-tool-build.js";
import { resolveCodexDynamicToolsLoadingForRuntime } from "./dynamic-tool-profile.js";
import { createBridge } from "./dynamic-tools.test-support.js";
import {
  createCodexTestHostCapabilities,
  setCodexTestToolFactory,
} from "./host-capability.test-support.js";
import { prepareTestNativeExecutionPolicy } from "./native-execution-policy.test-support.js";
import {
  CODEX_OPENCLAW_DIRECT_DYNAMIC_TOOL_NAMESPACE,
  flattenCodexDynamicToolFunctions,
  type JsonObject,
} from "./protocol.js";
import { resolveCodexDynamicToolDirectNames } from "./run-attempt-tools.js";
import { createCodexTestModel } from "./test-support.js";

const {
  bindProductionCodexHostCapabilities,
  buildDynamicToolsForTest,
  cleanupDynamicToolBuildFixture,
  setupDynamicToolBuildFixture,
  createCodexRuntimePlanFixture,
  createParams: createBaseParams,
  createRuntimeDynamicTool,
  hoisted,
} = await import("./dynamic-tool-build.test-support.js");

let tempDir: string;
let workspaceDir: string;
let params: EmbeddedRunAttemptParams;
const hostCapabilityClosers: Array<() => void> = [];

type ToolOptions = Parameters<typeof createOpenClawCodingTools>[0];
const retainedOwnerConfig = {
  agents: {
    entries: {
      main: { tools: { exec: { host: "gateway" as const } } },
      policy: { tools: { exec: { host: "node" as const, node: "worker-1" } } },
    },
  },
};

function createParams(
  sessionFile: string,
  workspace: string,
  overrides: Partial<EmbeddedRunAttemptParams> = {},
): EmbeddedRunAttemptParams {
  return createBaseParams(sessionFile, workspace, {
    disableTools: false,
    runtimePlan: createCodexRuntimePlanFixture(),
    ...overrides,
  });
}

async function nativeSurface(
  attempt: EmbeddedRunAttemptParams,
  sandbox?: Parameters<typeof shouldEnableCodexAppServerNativeToolSurface>[1],
  options: Omit<
    Parameters<typeof shouldEnableCodexAppServerNativeToolSurface>[2],
    "nativeExecutionPolicy"
  > = {},
) {
  return shouldEnableCodexAppServerNativeToolSurface(attempt, sandbox, {
    ...options,
    nativeExecutionPolicy: await prepareTestNativeExecutionPolicy(attempt, { sandbox, ...options }),
  });
}

function buildTools(options: Parameters<typeof buildDynamicToolsForTest>[2] = {}) {
  return buildDynamicToolsForTest(params, workspaceDir, options);
}

function mockTools(names: string[] = [], extra: AnyAgentTool[] = []) {
  const factory = vi.fn((_options: ToolOptions) => [
    ...names.map(createRuntimeDynamicTool),
    ...extra,
  ]);
  setCodexTestToolFactory(params, factory);
  return factory;
}

function realTools(...names: string[]) {
  setCodexTestToolFactory(params, (options) =>
    createOpenClawCodingTools(options).filter((tool) => names.includes(tool.name)),
  );
}

function toolNamed(tools: AnyAgentTool[], name: string) {
  const found = tools.find((tool) => tool.name === name);
  return expectDefined(found, `Codex ${name} tool`);
}

function call(
  bridge: ReturnType<typeof createBridge>,
  tool: string,
  args: JsonObject,
  callId = tool,
) {
  return bridge.handleToolCall({
    threadId: "thread-1",
    turnId: "turn-1",
    callId,
    tool,
    arguments: args,
  });
}

function shellTestToolNames(tools: readonly { name: string }[]): string[] {
  return tools
    .map((tool) => tool.name)
    .filter((name) => ["message", "gateway_exec", "gateway_process", "node_exec"].includes(name));
}
function namespaceSpec(name: string, tools: unknown) {
  return { type: "namespace", name, description: "", tools };
}
function textContent<T extends "text" | "inputText">(text: string, type: T) {
  return [{ type, text }];
}

it.each<[string, string | undefined, string | undefined, string | undefined, boolean]>([
  ["provider-only Telegram", undefined, "telegram", "telegram", true],
  ["explicit webchat before Telegram provider", "webchat", "telegram", "webchat", true],
  ["both channels absent", undefined, undefined, undefined, true],
  ["callback absent", undefined, "telegram", "telegram", false],
])(
  "binds question prompt routing: %s",
  async (_name, messageChannel, messageProvider, expectedChannel, hasCallback) => {
    params.messageChannel = messageChannel;
    params.messageProvider = messageProvider;
    const onToolResult = vi.fn();
    params.onToolResult = hasCallback ? onToolResult : undefined;
    const factory = mockTools();
    await buildTools();
    const question = factory.mock.calls[0]?.[0]?.questionPrompt;

    if (!hasCallback) {
      expect(question).toBeUndefined();
      return;
    }
    expect(question).toMatchObject({
      send: onToolResult,
      messageChannel: expectedChannel,
    });
    await expectDefined(question, "question prompt").send({ text: "Question for you:" });
    expect(onToolResult).toHaveBeenCalledExactlyOnceWith({ text: "Question for you:" });
  },
);

it("binds a resolver-backed constructed tool surface exactly once", async () => {
  const bindToolSurface = vi.fn(params.hostCapabilities.bindToolSurface);
  params.hostCapabilities = createCodexTestHostCapabilities({ bindToolSurface });
  const factory = mockTools(["read"]);
  const resolveCronCreatorToolAuthority = vi.fn(async () => ({
    tools: ["read"],
    provenance: { version: 1 as const, source: "final-executable-surface" as const },
  }));
  const effectiveCwd = path.join(workspaceDir, "native-cwd");

  const tools = await buildTools({
    effectiveCwd,
    resolveCronCreatorToolAuthority,
  });

  expect(factory).toHaveBeenCalledOnce();
  expect(bindToolSurface).toHaveBeenCalledExactlyOnceWith(
    expect.arrayContaining([expect.objectContaining({ name: "read" })]),
    { cwd: effectiveCwd, nativeLocalExecution: true },
  );
  expect(tools).toEqual([]);
});

it.each([true, false])("requires native paired-node execution: %s", async (native) => {
  const factory = vi.fn((options: Parameters<typeof createOpenClawCodingTools>[0]) =>
    native
      ? [
          ...createOpenClawCodingTools(options).filter((tool) => tool.name === "message"),
          createRuntimeDynamicTool("paired_host_plugin"),
        ]
      : [createRuntimeDynamicTool("exec")],
  );
  setCodexTestToolFactory(params, factory);
  const build = buildTools({
    ...(native ? {} : { nativeToolSurfaceEnabled: false }),
    sandbox: {
      enabled: true,
      backendId: "node",
      placementExecutionMode: "remote-exec",
      placementNodeId: "paired-device-1",
    } as never,
  });
  if (!native) {
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
});

const policyDeny = ["exec", "process", "write", "edit"];
function policyCase(source: string, overrides: Partial<EmbeddedRunAttemptParams>, denied = true) {
  return { source, ...overrides, denied };
}
it.each([
  policyCase("allowed", { sandboxAgentId: "policy" }, false),
  policyCase("conversation", { conversationToolPolicy: { deny: policyDeny } }),
  policyCase("intersection", {
    conversationToolPolicy: { deny: policyDeny },
    config: { tools: { deny: ["apply_patch"] } },
  }),
  policyCase("global", { config: { tools: { deny: policyDeny } } }),
  policyCase("execution owner", {
    config: { agents: { entries: { main: { tools: { deny: policyDeny } } } } },
  }),
  policyCase("retained owner", {
    config: { agents: { entries: { main: {}, policy: { tools: { deny: policyDeny } } } } },
    sandboxAgentId: "policy",
  }),
])(
  "enforces $source dynamic-write policy",
  async ({ source, config, conversationToolPolicy, sandboxAgentId, denied }) => {
    await fs.mkdir(workspaceDir, { recursive: true });
    const targetPath = path.join(workspaceDir, "policy-write.txt");
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
    await bindProductionCodexHostCapabilities(params, hostCapabilityClosers);

    const tools = await buildTools({
      sandboxSessionKey: params.sandboxSessionKey ?? params.sessionKey,
      nativeToolSurfaceEnabled: false,
      sandbox: null,
    });
    const bridge = createBridge(tools, {
      loading: "direct",
      hookContext: {
        agentId: "main",
        sessionKey: params.sessionKey,
        sessionId: params.sessionId,
        runId: params.runId,
        workspaceDir,
      },
    });
    const result = await call(bridge, "write", {
      path: targetPath,
      content: "allowed owner write",
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
      const nativeTools = await buildTools({
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
  },
);

it("removes account-wide app access when native tools are restricted", () => {
  const enabled = {
    enabled: true,
    allow_all_plugins: true,
    allow_destructive_actions: "auto",
  } as const;
  const expected = { codexPlugins: { ...enabled, enabled: false } };
  expect(disableCodexPluginThreadConfig({ codexPlugins: enabled })).toEqual(expected);
});

beforeEach(async () => {
  tempDir = await setupDynamicToolBuildFixture();
  workspaceDir = path.join(tempDir, "workspace");
  params = createParams(path.join(tempDir, "session.jsonl"), workspaceDir);
});

afterEach(async () => {
  resetGlobalHookRunner();
  await cleanupDynamicToolBuildFixture(tempDir, hostCapabilityClosers);
});

const sandboxEnvironment = { environmentId: "sandbox-1", cwd: "/workspace" };

it.each([
  ["restricted without a sandbox", undefined, false, []],
  ["native without a sandbox", undefined, true, undefined],
  ["native with a sandbox", sandboxEnvironment, true, [sandboxEnvironment]],
] as const)("selects the explicit run environment: %s", (_name, environment, native, expected) => {
  expect(resolveCodexSandboxEnvironmentSelection(environment, native)).toEqual(expected);
});

it("maps sandbox exec-server cwd through the remote workspace mapping", () => {
  expect(
    resolveCodexAppServerExecutionCwd({
      effectiveCwd: "/Users/kevinlin/code/openclaw",
      environment: { id: "sandbox-1", cwd: "/Users/kevinlin/code/openclaw/sandbox" } as never,
      nativeToolSurfaceEnabled: true,
      localWorkspaceRoot: "/Users/kevinlin/code/openclaw",
      remoteWorkspaceRoot: "/home/oai/openclaw-workspaces",
    }),
  ).toBe("/home/oai/openclaw-workspaces/sandbox");
});

it.each([true, false])("uses native images when native=%s", async (nativeToolSurfaceEnabled) => {
  params.model = createCodexTestModel("codex", ["text", "image"]);
  mockTools(["view_image", "message"]);

  const tools = await buildTools({ nativeToolSurfaceEnabled });

  expect(tools.map((tool) => tool.name)).toEqual(
    nativeToolSurfaceEnabled ? ["message"] : ["view_image", "message"],
  );
});

it("never lets raw full bypass a requirements-clamped workspace dynamic policy", async () => {
  params.permissionMode = "full";
  params.sessionRoot = workspaceDir;
  params.execOverrides = { host: "gateway", mode: "full" };
  const factory = mockTools();

  await buildTools({
    sandbox: null as never,
    sessionPermissionPolicy: { mode: "workspace", root: workspaceDir, execMode: "auto" },
  });

  expect(factory.mock.calls[0]?.[0]).toMatchObject({
    exec: { host: "gateway", mode: "auto" },
    sessionPermissionPolicy: { mode: "workspace", root: workspaceDir },
  });
});

it("pins guarded Gateway shell calls to human approval after stripping model policy", async () => {
  params.permissionMode = "guarded";
  params.sessionRoot = workspaceDir;
  params.execOverrides = { host: "gateway", mode: "ask" };
  await bindProductionCodexHostCapabilities(params, hostCapabilityClosers);

  const tools = await buildTools({
    sessionPermissionPolicy: { mode: "guarded", root: workspaceDir, execMode: "ask" },
  });
  const gatewayExec = toolNamed(tools, "gateway_exec");
  expect(gatewayExec.parameters).not.toHaveProperty("properties.host");
  expect(gatewayExec.parameters).not.toHaveProperty("properties.security");
  expect(gatewayExec.parameters).not.toHaveProperty("properties.ask");
});

it.each([
  ["guarded", "ask", "echo allowed", { status: "completed" }],
  [
    "guarded",
    "ask",
    "echo approval required",
    { status: "failed", failureKind: "approval_required" },
  ],
  ["full", "full", "echo approval required", { status: "completed" }],
] as const)(
  "enforces %s collector policy for %s / %s",
  async (mode, execMode, command, expected) => {
    await fs.mkdir(workspaceDir, { recursive: true });
    params.swarmCollector = true;
    params.pluginHarnessToolPolicyRestricted = true;
    params.permissionMode = mode;
    params.sessionRoot = workspaceDir;
    params.execOverrides = { host: "gateway", mode: execMode };
    // Guarded mode asks only on an allowlist miss; two arguments exceed this profile.
    params.config = {
      tools: { exec: { safeBins: ["echo"], safeBinProfiles: { echo: { maxPositional: 1 } } } },
    };
    realTools("exec", "process");

    const tools = await buildTools({
      nativeToolSurfaceEnabled: await nativeSurface(params),
      sessionPermissionPolicy: { mode, root: workspaceDir, execMode },
    });
    const gatewayExec = toolNamed(tools, "exec");
    expect.soft(gatewayExec.parameters).not.toHaveProperty("properties.security");
    const result = await gatewayExec.execute(`${mode}-allowlisted`, {
      command,
      ask: "off",
      security: "full",
    });

    expect(result.details).toMatchObject(expected);
  },
);

registerCodexCompletionCommandTest();

it.each([{ toolsAllow: undefined }, { toolsAllow: ["read"] }, { toolsAllow: [] }])(
  "preserves collector handoff with allowlist %j",
  async ({ toolsAllow }) => {
    params.toolsAllow = toolsAllow;
    params.swarmCollector = true;
    params.pluginHarnessToolPolicyRestricted = true;
    params.swarmOutputSchema = {
      type: "object",
      properties: { answer: { type: "string" } },
      required: ["answer"],
    };
    const output = {
      ...createRuntimeDynamicTool("structured_output"),
      catalogMode: "direct-only" as const,
    };
    const factory = mockTools(["read"], [output]);
    const tools = await buildTools({
      sandbox: null,
      nativeToolSurfaceEnabled: await nativeSurface(params),
    });

    expect(factory).toHaveBeenCalledWith(
      expect.objectContaining({
        swarmCollector: true,
        swarmOutputSchema: params.swarmOutputSchema,
        ...(toolsAllow ? { runtimeToolAllowlist: [...toolsAllow, "structured_output"] } : {}),
      }),
    );
    expect(await nativeSurface(params)).toBe(false);
    expect(tools.map((tool) => tool.name).toSorted()).toEqual(
      [...(toolsAllow ?? ["read"]), "structured_output"].toSorted(),
    );
    const bridge = createBridge(tools);
    const outputSpec = flattenCodexDynamicToolFunctions(bridge.specs).find(
      (tool) => tool.name === "structured_output",
    );
    expect(expectDefined(outputSpec, "collector tool spec").deferLoading).not.toBe(true);
    const args = { result: { answer: "ok" } };
    const response = await call(bridge, "structured_output", args, "collector-result");
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
  "keeps delegation model-only (%s loading)",
  async (loading) => {
    params.config = { tools: { exec: { mode: "ask" } } };
    realTools("openclaw", "message", "session_status");

    const tools = await buildTools({
      sandbox: null,
      isHostScopedToolActive: () => false,
    });
    expect(tools.map((tool) => tool.name).toSorted()).toEqual([
      "message",
      "openclaw",
      "session_status",
    ]);
    const bridge = createBridge(tools, {
      loading,
      directToolNames: resolveCodexDynamicToolDirectNames(params, tools, false),
    });

    expect(bridge.specs).toContainEqual(
      namespaceSpec(CODEX_OPENCLAW_DIRECT_DYNAMIC_TOOL_NAMESPACE, [
        expect.objectContaining({ type: "function", name: "openclaw" }),
      ]),
    );
    expect(bridge.specs).toContainEqual(
      expect.objectContaining({ type: "function", name: "message" }),
    );
    const ordinarySpec = expect.objectContaining({ type: "function", name: "session_status" });
    expect(bridge.specs).toContainEqual(
      loading === "direct"
        ? ordinarySpec
        : namespaceSpec("openclaw", [
            expect.objectContaining({ name: "session_status", deferLoading: true }),
          ]),
    );
  },
);

it.each(["core policy", "Codex excludes", "turn allowlist"])(
  "denies real delegation via %s",
  async (policy) => {
    params.config = policy === "core policy" ? { tools: { deny: ["openclaw"] } } : {};
    params.toolsAllow = policy === "turn allowlist" ? ["message"] : ["openclaw", "message"];
    realTools("openclaw", "message");

    const tools = await buildTools({
      sandbox: null,
      isHostScopedToolActive: () => false,
      pluginConfig: policy === "Codex excludes" ? { codexDynamicToolsExclude: ["openclaw"] } : {},
    });

    expect(tools.map((tool) => tool.name)).toEqual(["message"]);
  },
);

it.each([
  ["active exact host scope", true, ["openclaw"], ["openclaw"]],
  ["inactive host scope", false, ["openclaw"], []],
  ["a wider public allowlist", true, ["openclaw", "read"], []],
] as const)(
  "limits host-tool exceptions to %s",
  async (_label, hostActive, toolsAllow, expected) => {
    params.toolsAllow = [...toolsAllow];
    setCodexTestToolFactory(params, () => [
      { ...createRuntimeDynamicTool("openclaw"), catalogMode: "direct-only" },
    ]);
    const tools = await buildTools({
      isHostScopedToolActive: (toolName) => hostActive && toolName === "openclaw",
      pluginConfig: { codexDynamicToolsExclude: ["openclaw"] },
    });
    expect(tools.map((tool) => tool.name)).toEqual(expected);
  },
);

it.each([
  ["openai/gpt-5.4-nano", undefined],
  ["openai/gpt-5.5", "remote"],
] as const)("uses direct tools for %s / %s", (model, connectionClass) => {
  const tools = ["message", "web_search"].map(createRuntimeDynamicTool);
  const loading = resolveCodexDynamicToolsLoadingForRuntime({}, model, { connectionClass });
  const bridge = createBridge(tools, { loading });
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
  "quarantines plugin %s before filtering",
  async (invalid) => {
    const warn = vi.spyOn(embeddedAgentLog, "warn").mockImplementation(() => undefined);
    const messageTool = createRuntimeDynamicTool("message");
    const sourceTools: AnyAgentTool[] =
      invalid === "unreadable entry"
        ? new Proxy([messageTool, messageTool], {
            get(target, property, receiver) {
              if (property === "0") {
                throw new Error("fuzzplugin tool entry getter exploded");
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
    setCodexTestToolFactory(params, () => sourceTools);

    await expect(buildTools()).resolves.toEqual([messageTool]);
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

it.each([
  ["podman", "none", "restricted"],
  ["Podman", "bridge", "enabled"],
])("maps %s network %s into Codex external sandbox policy", (backendId, network, networkAccess) => {
  expect(
    resolveCodexExternalSandboxPolicyForOpenClawSandbox({
      enabled: true,
      backendId,
      docker: { network },
    } as never),
  ).toEqual({ type: "externalSandbox", networkAccess });
});

it.each([
  ["sandbox", undefined],
  ["node", undefined],
  ["gateway", "process"],
  ["gateway", "exec"],
] as const)("filters Gateway shell aliases under %s / %s", async (host, excluded) => {
  if (host === "gateway") {
    params.execOverrides = { host };
    await bindProductionCodexHostCapabilities(params, hostCapabilityClosers);
  } else {
    if (host === "node") {
      params.execOverrides = { host };
    }
    mockTools(["exec", "process", "message"]);
  }
  const tools = await buildTools({
    nativeToolSurfaceEnabled: true,
    ...(host === "sandbox" ? { sandbox: { enabled: true, backendId: "docker" } as never } : {}),
    pluginConfig: { codexDynamicToolsExclude: excluded ? [excluded] : [] },
  });
  if (excluded) {
    expect(shellTestToolNames(tools)).toEqual(
      excluded === "process" ? ["message", "gateway_exec"] : ["message"],
    );
  } else {
    expect(tools.map((tool) => tool.name)).not.toContain("gateway_exec");
    expect(tools.map((tool) => tool.name)).not.toContain("gateway_process");
  }
});

it("shares discovery across attempt catalogs but refreshes the next attempt", async () => {
  mockTools(["exec"]);
  hoisted.loadNodeExecAvailability.mockClear();
  for (const available of [true, false]) {
    hoisted.loadNodeExecAvailability.mockResolvedValue({
      cacheKey: String(available),
      isAvailable: () => available,
    });
    const nodeExecAvailability = {};
    for (const ignoreRuntimePlan of [false, true]) {
      const tools = await buildTools({
        nodeExecAvailability,
        ignoreRuntimePlan,
      });
      expect(tools.some((tool) => tool.name === "node_exec")).toBe(available);
    }
  }
  expect(hoisted.loadNodeExecAvailability).toHaveBeenCalledTimes(2);
});

it("propagates cancellation during node discovery without publishing tools", async () => {
  mockTools(["exec"]);
  const runAbortController = new AbortController();
  const reason = new Error("synthetic attempt cancelled");
  hoisted.loadNodeExecAvailability.mockImplementationOnce(async (signal: AbortSignal) => {
    expect(signal).toBe(runAbortController.signal);
    runAbortController.abort(reason);
    return { cacheKey: "eligible", isAvailable: () => true };
  });
  await expect(buildTools({ runAbortController })).rejects.toBe(reason);
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
        pty: { type: "boolean" },
        elevated: { type: "boolean" },
        yieldMs: { type: "number" },
      },
      required: ["command", "host", "node", "background", "yieldMs", "pty", "elevated"],
      additionalProperties: false,
    },
  };
  vi.mocked(execTool.execute).mockResolvedValueOnce({
    content: textContent(
      "Command still running (session exec-1, pid 123). Use process (list/poll/log/write/send-keys/submit/paste/kill/clear/remove) for follow-up.",
      "text",
    ),
    details: { status: "running" },
  });

  setCodexTestToolFactory(params, () => [execTool, createRuntimeDynamicTool("message")]);
  params.execOverrides = {
    host: "node",
    node: "mac-mini",
    security: "full",
    ask: "off",
  };

  const nativeToolSurfaceEnabled = await nativeSurface(params);
  const tools = await buildTools({
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
  expect(result?.content).toEqual(
    textContent(
      "Command still running (session exec-1, pid 123). Remote-node background follow-up is unavailable. Wait for the command to complete.",
      "text",
    ),
  );

  const retained = createParams(path.join(tempDir, "runtime-policy-session.jsonl"), workspaceDir, {
    sandboxSessionKey: "agent:policy:session-1",
    sandboxAgentId: "policy",
    config: retainedOwnerConfig,
  });
  setCodexTestToolFactory(retained, () => [execTool, createRuntimeDynamicTool("message")]);
  const retainedNative = await nativeSurface(retained, undefined, {
    agentId: "policy",
    runtimeSessionKey: retained.sandboxSessionKey,
  });
  const retainedTools = await buildDynamicToolsForTest(retained, workspaceDir, {
    sandboxSessionKey: retained.sandboxSessionKey,
    nativeToolSurfaceEnabled: retainedNative,
    sessionAgentId: "main",
  });
  expect(retainedNative).toBe(false);
  expect(retainedTools.map((tool) => tool.name)).toEqual(["message", "node_exec"]);
});

it.each(["auto", "bound auto", "gateway"])(
  "separates %s shell and Gateway sessions",
  async (name) => {
    if (name === "gateway") {
      params.execOverrides = { host: "gateway" };
    }
    if (name === "bound auto") {
      params.config = { tools: { exec: { host: "auto", node: "bound-mac-mini" } } };
    }
    await bindProductionCodexHostCapabilities(params, hostCapabilityClosers);
    const tools = await buildTools({ sandbox: null, nativeToolSurfaceEnabled: true });
    expect(shellTestToolNames(tools)).toEqual([
      "message",
      "gateway_exec",
      "gateway_process",
      ...(name === "gateway" ? [] : ["node_exec"]),
    ]);
    if (name === "gateway") {
      const narrowed = await buildDynamicToolsForTest(
        { ...params, toolsAllow: ["message"] },
        workspaceDir,
        { nativeToolSurfaceEnabled: true },
      );
      expect(shellTestToolNames(narrowed)).toEqual(["message"]);
      return;
    }
    const nodeExec = toolNamed(tools, "node_exec");
    expect(nodeExec.parameters).toMatchObject({
      type: "object",
      properties: { command: { type: "string" } },
      required: ["command"],
    });
    if (name === "bound auto") {
      expect(nodeExec.parameters).not.toHaveProperty("properties.node");
      return;
    }
    expect(nodeExec.description).toContain(
      "The sole connected node that can execute commands is selected automatically; select by name or id when several can.",
    );
    expect(nodeExec.parameters).toMatchObject({ properties: { node: { type: "string" } } });
    for (const field of ["host", "security", "ask"]) {
      expect(nodeExec.parameters).not.toHaveProperty(`properties.${field}`);
    }
    const nodeList = await call(createBridge(tools, { loading: "direct" }), "node_process", {
      action: "list",
    });
    expect(nodeList).toMatchObject({
      success: false,
      contentItems: [{ type: "inputText", text: "Unknown OpenClaw tool: node_process" }],
    });
  },
);

it("restores the policy-filtered OpenClaw shell when a finite allowlist disables native Code Mode", async () => {
  const execTool = createRuntimeDynamicTool("exec");
  mockTools([], [execTool, ...["process", "message"].map(createRuntimeDynamicTool)]);
  params.toolsAllow = ["exec", "process", "message"];
  const nativeToolSurfaceEnabled = await nativeSurface(params);

  const tools = await buildTools({ nativeToolSurfaceEnabled });

  expect(nativeToolSurfaceEnabled).toBe(false);
  expect(tools.map((tool) => tool.name)).toEqual(["exec", "process", "message", "node_exec"]);
  expect(
    tools
      .filter((tool) => ["exec", "process", "node_exec"].includes(tool.name))
      .map((tool) => tool.catalogMode),
  ).toEqual(["direct-only", "direct-only", "direct-only"]);

  const bridge = createBridge(tools, { loading: "direct" });
  expect(bridge.specs).toContainEqual(
    namespaceSpec(
      CODEX_OPENCLAW_DIRECT_DYNAMIC_TOOL_NAMESPACE,
      expect.arrayContaining(
        ["exec", "process", "node_exec"].map((name) => expect.objectContaining({ name })),
      ),
    ),
  );
  await call(bridge, "exec", { command: "echo restored" }, "restricted-exec");
  expect(execTool.execute).toHaveBeenCalledWith(
    "restricted-exec",
    { command: "echo restored" },
    expect.any(AbortSignal),
    undefined,
  );

  const excludedTools = await buildTools({
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
  { allow: ["web_*"], expected: ["web_search", "web_fetch"] },
])("honors runtime selectors: $allow", async ({ allow, expected }) => {
  mockTools(["automations", "read", "web_search", "web_fetch"]);
  params.execOverrides = { host: "gateway" };
  params.toolsAllow = allow;

  const tools = await buildTools({ nativeToolSurfaceEnabled: false });

  expect(tools.map((tool) => tool.name)).toEqual(expected);
});

it.each([false, true])(
  "forwards memory/auth context: separate store=%s",
  async (separateToolStore) => {
    const oauthProfile = {
      provider: "openai",
      type: "oauth",
      access: "transport-token",
      refresh: "transport-refresh",
      expires: 4_000_000_000_000,
    } as const;
    params.authProfileStore = {
      version: 1,
      profiles: separateToolStore
        ? { "openai:work": oauthProfile }
        : {
            "openai:api-key-backup": {
              provider: "openai",
              type: "api_key",
              key: "not-a-real-key",
            },
          },
    };
    params.toolAuthProfileStore = separateToolStore ? { ...params.authProfileStore } : undefined;
    params.messageActionTurnCapability = "turn-capability-1";
    params.senderIsOwner = true;
    params.memoryAudience = Object.freeze({
      kind: "conversation",
      agentId: "main",
      sessionKey: expectDefined(params.sessionKey, "memory audience session key"),
      sessionId: params.sessionId,
    });
    const factory = mockTools();

    await buildTools({ sandbox: null });

    expect(factory).toHaveBeenCalledOnce();
    expect(factory.mock.calls[0]?.[0]?.memoryAudience).toBe(params.memoryAudience);
    expect(factory.mock.calls[0]?.[0]?.authProfileStore).toBe(
      params.toolAuthProfileStore ?? params.authProfileStore,
    );
    expect(factory.mock.calls[0]?.[0]?.messageActionTurnCapability).toBe("turn-capability-1");
  },
);

it("quarantines exposed Codex memory writes and edits after a network tool", async () => {
  vi.stubEnv("OPENCLAW_BUILD_PRIVATE_QA", "1");
  vi.stubEnv("OPENCLAW_QA_FORCE_RUNTIME", "codex");
  await fs.mkdir(path.join(workspaceDir, "memory"), { recursive: true });
  let turnTainted = false;
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

  const tools = await buildTools({ sandbox: null as never });
  const tool = (name: string) => toolNamed(tools, name);
  const write = (surface: AnyAgentTool[], name: string, content: string) =>
    toolNamed(surface, "write").execute(`codex-${name}-write`, {
      path: `memory/${name}.md`,
      content,
    });
  await write(tools, "trusted", "owner note\n");
  await tool("web_fetch").execute("codex-network-call", {});
  expect(params.onToolOutcome).toHaveBeenCalledWith(
    expect.objectContaining({ toolName: "web_fetch", resultContentSource: "network" }),
  );
  expect(params.isTurnTainted()).toBe(true);

  await write(tools, "network", "network note\n");
  await tool("edit").execute("codex-network-edit", {
    path: "memory/trusted.md",
    edits: [{ oldText: "owner note", newText: "network edit" }],
  });

  const fresh = createParams(path.join(tempDir, "fresh-session.jsonl"), workspaceDir, {
    config: params.config,
    provider: "openai",
    model: createCodexTestModel("openai"),
    runId: "codex-fresh-run",
    senderIsOwner: true,
    sessionId: "codex-fresh-session",
    sessionKey: "agent:main:codex-fresh-session",
    isTurnTainted: () => false,
  });
  const freshTools = await buildDynamicToolsForTest(fresh, workspaceDir, { sandbox: null });
  await write(freshTools, "fresh", "fresh owner note\n");

  const origin = async (relativePath: string) =>
    (await readMemoryArtifactProvenance({ workspaceDir, relativePath }))?.originClass;
  const origins = await Promise.all(
    ["memory/trusted.md", "memory/network.md", "memory/fresh.md"].map(origin),
  );
  expect(origins).toEqual(["untrusted", "untrusted", "agent"]);
  await expect(fs.readFile(path.join(workspaceDir, "memory/trusted.md"), "utf8")).resolves.toBe(
    "network edit\n",
  );
  await expect(fs.readFile(path.join(workspaceDir, "memory/network.md"), "utf8")).resolves.toBe(
    "network note\n",
  );
});

it("builds the durable registered-tool superset without loading a provider runtime", async () => {
  const runtimePlan = createCodexRuntimePlanFixture();
  const planNormalize = vi.fn((tools: AnyAgentTool[]) =>
    tools.map((tool) => ({ ...tool, description: `turn:${tool.description}` })),
  );
  runtimePlan.tools.normalize = planNormalize as typeof runtimePlan.tools.normalize;
  params.runtimePlan = runtimePlan;
  params.disableMessageTool = true;
  const statusTool = createRuntimeDynamicTool("session_status");
  const messageTool = createRuntimeDynamicTool("message");
  const invalidTool = {
    ...createRuntimeDynamicTool("invalid_registered_tool"),
    parameters: { type: "array", items: { type: "string" } },
  };
  setCodexTestToolFactory(params, (options) => [
    statusTool,
    ...(options?.disableMessageTool === true ? [] : [messageTool, invalidTool]),
  ]);

  const turnTools = await buildTools({ sandbox: null as never });
  const registeredTools = await buildTools({
    ignoreDisableMessageTool: true,
    ignoreRuntimePlan: true,
    sandbox: null as never,
  });

  expect(planNormalize).toHaveBeenCalledOnce();
  expect(hoisted.normalizeAgentRuntimeTools.mock.calls).toMatchObject([
    [{ runtimePlan }],
    [{ allowProviderRuntimePluginLoad: false, runtimePlan: undefined }],
  ]);
  expect(hoisted.normalizeAgentRuntimeTools.mock.calls[1]?.[0]).not.toHaveProperty("runtimeHandle");
  expect(turnTools).toMatchObject([
    { name: "session_status", description: `turn:${statusTool.description}` },
  ]);
  expect(registeredTools).toMatchObject([
    { name: "session_status", description: statusTool.description },
    { name: "message", description: messageTool.description },
  ]);
});

it("enables gateway subagent binding for forced private QA Codex runs", async () => {
  vi.stubEnv("OPENCLAW_BUILD_PRIVATE_QA", "1");
  vi.stubEnv("OPENCLAW_QA_FORCE_RUNTIME", "codex");
  const factory = mockTools(["sessions_spawn"]);

  const tools = await buildTools({ sandbox: null as never });

  expect(factory).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ allowGatewaySubagentBinding: true }),
  );
  expect(tools.map((tool) => tool.name)).toEqual(["sessions_spawn"]);
});

it.each([
  { label: "unresolved", sandbox: undefined, expectedExecHost: "sandbox" },
  { label: "resolved absent", sandbox: null, expectedExecHost: "gateway" },
])("honors prepared policy with $label sandbox", async ({ sandbox, expectedExecHost }) => {
  params.config = { agents: { defaults: { sandbox: { mode: "all" } } } };
  setRuntimeConfigSnapshot(params.config);
  const prepared = await prepareTestNativeExecutionPolicy(params, { sandbox });
  expect(prepared.policy.effectiveExecHost).toBe(expectedExecHost);
  const nodePolicy = await prepareTestNativeExecutionPolicy(
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
});

const fullNodeExec = { host: "node", node: "mac-mini", security: "full", ask: "off" } as const;
const globalNodeConfig = { tools: { exec: { host: "node" as const } } };
it.each([
  policyCase("disabled tools", { disableTools: true }),
  policyCase("session", { execOverrides: fullNodeExec }),
  policyCase("session wildcard", { execOverrides: fullNodeExec, toolsAllow: ["*"] }),
  policyCase("global", { config: globalNodeConfig }),
  policyCase("auto override", { config: globalNodeConfig, execOverrides: { host: "auto" } }, false),
  policyCase("agent", { config: { agents: { entries: { main: globalNodeConfig } } } }),
  policyCase("runtime owner", {
    sandboxSessionKey: "agent:policy:session-1",
    config: retainedOwnerConfig,
  }),
])("gates native tools by $source exec policy", async ({ source, denied, ...overrides }) => {
  Object.assign(params, overrides);
  expect(
    await nativeSurface(params, undefined, source === "agent" ? { agentId: "main" } : {}),
  ).toBe(!denied);
});

it.each(["text", "initial audio", "accepted audio steering"])(
  "applies inbound TTS to a final dynamic message for %s",
  async (input) => {
    vi.stubEnv("OPENCLAW_STATE_DIR", path.join(tempDir, "state"));
    const synthesize = vi.fn(async (_request: { text: string }) => ({
      audioBuffer: Buffer.from("synthetic speech"),
      fileExtension: ".ogg",
      outputFormat: "ogg",
      voiceCompatible: true,
    }));
    const receipt = { channel: "whatsapp", messageId: "synthetic-reply" };
    const sendMedia = vi.fn(async (_context: { mediaUrl?: string }) => receipt);
    const sendText = vi.fn(async () => receipt);
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
    setActivePluginRegistry(registry);
    try {
      params.config = {
        tts: { auto: "inbound", provider: "test-speech" },
        channels: { whatsapp: { allowFrom: ["*"] } },
      };
      params.messageChannel = "whatsapp";
      params.currentInboundAudio = input === "initial audio";
      await withAdmittedSessionTurnForTest(
        { sessionId: params.sessionId, sessionKey: params.sessionKey! },
        async (replyOperation) => {
          params.sourceReplyDeliveryMode = "message_tool_only";
          realTools("message");
          const tools = await buildTools({ sandbox: null as never });
          // Accepted steering must reach tools that were already constructed.
          if (input === "accepted audio steering") {
            replyOperation.markSteeredInputAccepted({ inboundAudio: true });
          }
          const bridge = createBridge(tools);

          const result = await call(
            bridge,
            "message",
            {
              action: "send",
              channel: "whatsapp",
              target: "+12025550123",
              message: "Here is the requested spoken reply.",
              final: true,
            },
            "voice-final",
          );

          const expectsVoice = input !== "text";
          expect(result.success, JSON.stringify(result.contentItems)).toBe(true);
          expect(synthesize).toHaveBeenCalledTimes(expectsVoice ? 1 : 0);
          expect(sendMedia).toHaveBeenCalledTimes(expectsVoice ? 1 : 0);
          if (expectsVoice) {
            expect(sendMedia).toHaveBeenCalledWith(expect.objectContaining({ audioAsVoice: true }));
          } else {
            expect(sendText).toHaveBeenCalledOnce();
          }
        },
      );
    } finally {
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
  "publishes explicit-target policy: $sessionKey / $required",
  async ({ sessionKey, required, expected }) => {
    params.sessionKey = sessionKey;
    params.requireExplicitMessageTarget = required;
    const factory = mockTools();
    const onMessageToolTargetResolved = vi.fn();
    await buildTools({ onMessageToolTargetResolved });
    expect(factory.mock.calls[0]?.[0]?.requireExplicitMessageTarget).toBe(expected);
    expect(onMessageToolTargetResolved).toHaveBeenCalledExactlyOnceWith(expected);
  },
);
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
