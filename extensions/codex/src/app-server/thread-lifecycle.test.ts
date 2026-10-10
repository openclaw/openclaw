// Codex tests cover thread lifecycle plugin behavior.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { EmbeddedRunAttemptParamsV2 as EmbeddedRunAttemptParams } from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  GPT5_BEHAVIOR_CONTRACT as CODEX_GPT5_BEHAVIOR_CONTRACT,
  type ModelCompatConfig,
} from "openclaw/plugin-sdk/provider-model-shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { codexCatalogHomeId } from "../session-catalog-home-id.js";
import { CODEX_APP_SERVER_UNSUBSCRIBE_TIMEOUT_MS } from "./attempt-client-cleanup.js";
import { resolveCodexAppServerHomeDir } from "./auth-start-options.js";
import { CodexAppServerRpcError } from "./client.js";
import { threadStartResult as nativeThreadStartResult } from "./codex-app-server.test-fixtures.js";
import { shouldEnableCodexAppServerNativeToolSurface } from "./dynamic-tool-build.js";
import { createCodexTestHostCapabilities } from "./host-capability.test-support.js";
import { createCodexManagedThreadStore } from "./managed-thread-store.js";
import { buildCodexAppServerConnectionFingerprint } from "./plugin-app-cache-key.js";
import type { CodexPluginThreadConfig } from "./plugin-thread-config.js";
import { buildCodexProjectDocThreadConfig } from "./project-doc-thread-config.js";
import {
  CODEX_OPENCLAW_DIRECT_DYNAMIC_TOOL_NAMESPACE,
  type CodexDynamicToolFunctionSpec,
} from "./protocol.js";
import { resolveCodexAppServerReasoningEffort } from "./reasoning-effort.js";
import {
  createCodexAppServerBindingStore,
  sessionBindingIdentity,
  type CodexAppServerBindingStore,
  type CodexAppServerPendingSupervisionBranch,
} from "./session-binding.js";
import {
  createCodexTestBindingStateStore,
  resetCodexTestBindingStore,
  testCodexAppServerBindingStore,
} from "./session-binding.test-helpers.js";
import {
  createClientHarness,
  createCodexTestModel,
  withLeasedCodexTestClient,
} from "./test-support.js";
import {
  areCodexDynamicToolFingerprintsCompatible,
  codexDynamicToolsFingerprint,
  codexLegacyDynamicToolsFingerprint,
} from "./thread-fingerprints.js";
import {
  createLeasedCodexLifecycleHarness,
  createThreadRequestAppServerOptions as createAppServerOptions,
  createThreadRequestAttemptParams as createAttemptParams,
  disabledMcpServerStatus,
  startOrResumeThreadWithEmptySkillCatalog as startOrResumeThreadImpl,
  writeNativeCatalogFixture,
} from "./thread-lifecycle.test-fixtures.js";
import { buildDeveloperInstructions } from "./thread-prompt.js";
import {
  attestCodexRestrictedToolSurfaceMcpServersDisabled,
  buildThreadResumeParams,
  buildThreadStartParams,
} from "./thread-requests.js";
import { buildTurnStartParams } from "./turn-params.js";

it("uses direct OpenClaw functions and hosted web search for subscription sharing", () => {
  const params = createAttemptParams({ provider: "openai", authProfileId: "openai:sharing" });
  const profile = params.authProfileStore!.profiles["openai:sharing"]!;
  params.authProfileStore!.profiles["openai:sharing"] = {
    ...profile,
    authFlow: "chatgpt-token-sharing",
  } as typeof profile;
  params.runtimePlan = {
    ...params.runtimePlan,
    auth: {
      providerForAuth: "openai",
      authProfileProviderForAuth: "openai",
      selectedAuthMode: "oauth",
      selectedAuthFlow: "chatgpt-token-sharing",
    },
  } as NonNullable<EmbeddedRunAttemptParams["runtimePlan"]>;
  const nativeCodeModeEnabled = shouldEnableCodexAppServerNativeToolSurface(params);
  expect(nativeCodeModeEnabled).toBe(false);
  const start = buildThreadStartParams(params, {
    appServer: createAppServerOptions() as never,
    cwd: "/repo",
    dynamicTools: [],
    nativeCodeModeEnabled,
    nativeProviderWebSearchSupport: "supported",
    webSearchAllowed: true,
  });
  expect(start.environments).toEqual([]);
  expect(start.modelProvider).toBe("openclaw_token_sharing");
  expect(
    buildThreadResumeParams(params, {
      appServer: createAppServerOptions() as never,
      threadId: "thread-1",
    }).modelProvider,
  ).toBe("openclaw_token_sharing");
  expect(start.config).toMatchObject({
    "features.code_mode": false,
    "features.apps": false,
    "features.multi_agent": false,
    "features.multi_agent_v2": false,
    "features.plugins": false,
    "orchestrator.skills.enabled": false,
    "skills.bundled.enabled": false,
    web_search: "cached",
    "features.standalone_web_search": false,
  });
  expect(start.developerInstructions).not.toContain("tool_search");
  expect(start.developerInstructions).not.toContain("spawn_agent");
  params.pluginHarnessToolPolicyRestricted = true;
  params.scheduledRuntimeAuthority = {} as NonNullable<
    EmbeddedRunAttemptParams["scheduledRuntimeAuthority"]
  >;
  const restricted = buildThreadStartParams(params, {
    appServer: createAppServerOptions() as never,
    cwd: "/repo",
    dynamicTools: [],
    nativeCodeModeEnabled,
  });
  expect(restricted.config?.["features.apps"]).toBe(false);
  expect(restricted.config?.["orchestrator.mcp.enabled"]).toBe(false);
});

type CodexThreadLifecycleTimingLogger = NonNullable<
  NonNullable<Parameters<typeof startOrResumeThreadImpl>[0]["timing"]>["log"]
>;

describe("Codex context window config", () => {
  it("forwards only a prepared cap on thread start and resume (#124702)", () => {
    const appServer = createAppServerOptions() as never;
    const capped = createAttemptParams({ provider: "openai" });
    capped.authoredContextTokenCap = 32_000;
    const uncapped = createAttemptParams({ provider: "openai" });
    const build = (params: EmbeddedRunAttemptParams) => [
      buildThreadStartParams(params, {
        appServer,
        cwd: "/repo",
        dynamicTools: [],
      }),
      buildThreadResumeParams(params, {
        appServer,
        threadId: "thread-1",
      }),
    ];

    for (const request of build(capped)) {
      expect(request.config?.model_context_window).toBe(32_000);
    }
    for (const request of build(uncapped)) {
      expect(request.config).not.toHaveProperty("model_context_window");
    }
  });
});

describe("Codex ring-zero thread config", () => {
  it.each([
    {
      name: "a missing admitted app",
      active: ["codex_apps"],
      rows: [],
      failure: "is missing admitted server codex_apps",
    },
    {
      name: "an admitted app with no tools",
      active: ["codex_apps"],
      rows: [{ name: "codex_apps", serverInfo: { name: "codex_apps" }, tools: {} }],
      failure: "found inactive admitted server codex_apps",
    },
    {
      name: "a disabled admitted app",
      disabled: ["codex_apps"],
      active: ["codex_apps"],
      rows: [],
      failure: "MCP server codex_apps has conflicting policy",
      beforeRequest: true,
    },
    {
      name: "a server without explicit inactive status",
      disabled: ["inherited"],
      rows: [{ name: "inherited", tools: {} }],
      failure: "returned malformed server inherited",
    },
    {
      name: "tools from a disabled server",
      disabled: ["inherited"],
      rows: [{ name: "inherited", serverInfo: null, tools: { lookup: {} } }],
      failure: "found tools for server inherited",
    },
    {
      name: "a missing disabled server",
      disabled: ["inherited", "request"],
      rows: [disabledMcpServerStatus("inherited")],
      failure: "is missing server request",
    },
    {
      name: "a duplicate server",
      disabled: ["inherited", "request"],
      rows: [disabledMcpServerStatus("inherited"), disabledMcpServerStatus("inherited")],
      failure: "returned duplicate server inherited",
    },
  ])("attests $name", async ({ disabled, active, rows, failure, beforeRequest }) => {
    const request = vi.fn(async () => ({ data: rows, nextCursor: null }));
    const result = attestCodexRestrictedToolSurfaceMcpServersDisabled(
      { request } as never,
      "thread-restricted",
      disabled
        ? { mcp_servers: Object.fromEntries(disabled.map((name) => [name, { enabled: false }])) }
        : {},
      undefined,
      active,
    );
    await expect(result).rejects.toThrow(failure);
    if (beforeRequest) {
      expect(request).not.toHaveBeenCalled();
    }
  });

  it("preserves project documents for ordinary policy-restricted turns", () => {
    const params = createAttemptParams({ provider: "openai" });
    params.pluginHarnessToolPolicyRestricted = true;
    const appServer = createAppServerOptions() as never;
    const start = buildThreadStartParams(params, {
      appServer,
      cwd: "/repo",
      dynamicTools: [],
      hostSystemAgentActive: false,
      nativeCodeModeEnabled: false,
    });
    const resume = buildThreadResumeParams(params, {
      appServer,
      dynamicTools: [],
      hostSystemAgentActive: false,
      nativeCodeModeEnabled: false,
      threadId: "thread-1",
      config: authoredProjectDocConfig(200_000),
    });

    expect(start.config?.project_doc_max_bytes).toBe(131_072);
    expect(resume.config?.project_doc_max_bytes).toBe(200_000);
    for (const threadConfig of [start.config, resume.config]) {
      expect(threadConfig?.["features.multi_agent"]).toBe(false);
      expect(threadConfig?.["orchestrator.mcp.enabled"]).toBe(false);
    }

    const toolsDisabled = createAttemptParams({ provider: "openai" });
    toolsDisabled.disableTools = true;
    toolsDisabled.pluginHarnessToolPolicyRestricted = true;
    const disabled = buildThreadStartParams(toolsDisabled, {
      appServer,
      cwd: "/repo",
      dynamicTools: [],
      hostSystemAgentActive: false,
      nativeCodeModeEnabled: false,
      config: authoredProjectDocConfig(200_000),
    });
    expect(disabled.config?.project_doc_max_bytes).toBe(0);
  });
});

function createLifecycleRequest(
  respond: (method: string, requestParams?: unknown) => Promise<unknown>,
) {
  return vi.fn((method: string, requestParams?: unknown) => {
    if (method === "config/read") {
      return Promise.resolve({ config: {}, origins: {}, layers: [] });
    }
    if (method === "configRequirements/read") {
      return Promise.resolve({ requirements: null });
    }
    return respond(method, requestParams);
  });
}

function authoredProjectDocConfig(projectDocMaxBytes: number) {
  return buildCodexProjectDocThreadConfig(undefined, {
    config: { project_doc_max_bytes: projectDocMaxBytes },
    origins: {
      project_doc_max_bytes: {
        name: { type: "user", file: "/codex/config.toml", profile: null },
        version: "sha256:authored-budget",
      },
    },
    layers: [],
  });
}

function startOrResumeThread(
  params: Omit<Parameters<typeof startOrResumeThreadImpl>[0], "bindingStore">,
) {
  return startOrResumeThreadImpl({ ...params, bindingStore: testCodexAppServerBindingStore });
}

let tempDir: string;
let workspaceDir: string;
const sourceThreadId = "thread-source";
const probeThreadId = "thread-probe";
const finalThreadId = "thread-final";

function installLifecycleHooks() {
  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-lifecycle-"));
    workspaceDir = path.join(tempDir, "workspace");
    resetCodexTestBindingStore();
  });
  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });
}

function lifecycleOptions(params: EmbeddedRunAttemptParams) {
  return {
    params,
    cwd: params.workspaceDir!,
    dynamicTools: [],
    appServer: createThreadLifecycleAppServerOptions(),
  };
}

function createNetworkProxyAppServerOptions() {
  const configPatch = {
    "features.network_proxy.enabled": true,
    default_permissions: "mock-proxy",
    permissions: {
      "mock-proxy": {
        filesystem: {
          ":minimal": "read",
          ":project_roots": {
            ".": "write",
          },
        },
        network: {
          enabled: true,
          domains: {
            "api.openai.com": "allow",
          },
          allow_upstream_proxy: true,
          proxy_url: "http://127.0.0.1:3128",
        },
      },
    },
  } as const;
  return {
    ...createAppServerOptions(),
    networkProxy: {
      profileName: "mock-proxy",
      configFingerprint: "test-network-proxy",
      configPatch,
    },
  } as const;
}

function createThreadLifecycleParams(
  sessionFile = path.join(tempDir, "session.jsonl"),
  attemptWorkspace = workspaceDir,
): EmbeddedRunAttemptParams {
  return {
    hostCapabilities: createCodexTestHostCapabilities(),
    prompt: "hello",
    sessionId: "session-1",
    sessionKey: "agent:main:session-1",
    sessionFile,
    workspaceDir: attemptWorkspace,
    runId: "run-1",
    provider: "codex",
    modelId: "gpt-5.4-codex",
    model: createCodexTestModel("codex"),
    thinkLevel: "medium",
    disableTools: true,
    timeoutMs: 5_000,
    authStorage: {} as never,
    authProfileStore: { version: 1, profiles: {} },
    modelRegistry: {} as never,
  } as EmbeddedRunAttemptParams;
}

function createThreadLifecycleAppServerOptions(): Parameters<
  typeof startOrResumeThread
>[0]["appServer"] {
  return {
    start: {
      transport: "stdio",
      command: "codex",
      args: ["app-server"],
      headers: {},
    },
    codeModeOnly: false,
    loopDetectionPreToolUseRelay: true,
    requestTimeoutMs: 60_000,
    approvalPolicy: "never",
    approvalsReviewer: "user",
    sandbox: "workspace-write",
    connectionClass: "local-loopback",
  };
}

function createProvisionalPluginThreadConfigProvider(appId: string) {
  const config: CodexPluginThreadConfig = {
    enabled: true,
    configPatch: {
      apps: {
        _default: {
          enabled: false,
          destructive_enabled: false,
          open_world_enabled: false,
        },
        [appId]: {
          enabled: true,
          destructive_enabled: false,
          open_world_enabled: true,
          default_tools_approval_mode: "auto",
        },
      },
    },
    provisionalAppIds: [appId],
    fingerprint: `plugin-config-${appId}`,
    inputFingerprint: `plugin-input-${appId}`,
    policyContext: {
      fingerprint: `plugin-policy-${appId}`,
      apps: {
        [appId]: {
          configKey: "linear",
          marketplaceName: "openai-curated",
          pluginName: "linear",
          allowDestructiveActions: false,
          destructiveApprovalMode: "deny",
          mcpServerNames: [],
        },
      },
      pluginAppIds: { linear: [appId] },
    },
    diagnostics: [],
  };
  return {
    enabled: true,
    inputFingerprint: config.inputFingerprint,
    enabledPluginConfigKeys: ["linear"],
    recoverablePluginConfigKeys: ["linear"],
    build: vi.fn(async () => config),
  };
}

async function seedPendingSupervisionBinding(
  attempt: EmbeddedRunAttemptParams,
  overrides: CodexAppServerPendingSupervisionBranch = { sourceThreadId },
) {
  const pending = {
    connectionFingerprint: buildCodexAppServerConnectionFingerprint(
      createThreadLifecycleAppServerOptions(),
      attempt.agentDir,
    ),
    ...overrides,
  };
  const identity = sessionBindingIdentity(attempt);
  const written = await testCodexAppServerBindingStore.mutate(identity, {
    kind: "set",
    if: { kind: "absent" },
    binding: {
      threadId: pending.sourceThreadId,
      cwd: attempt.workspaceDir,
      connectionScope: "supervision",
      supervisionSourceThreadId: pending.sourceThreadId,
      preserveNativeModel: true,
      pendingSupervisionBranch: pending,
      conversationSourceTransferComplete: true,
      historyCoveredThrough: new Date(0).toISOString(),
    },
  });
  if (!written) {
    throw new Error("failed to seed pending Codex supervision binding");
  }
  return identity;
}

function threadStartResult(threadId = "thread-1") {
  const result = nativeThreadStartResult(threadId, tempDir);
  return { ...result, thread: { ...result.thread, cliVersion: "0.149.0" } };
}

function nativeThreadResult(threadId: string, model: string, modelProvider: string) {
  const response = threadStartResult(threadId);
  return {
    ...response,
    model,
    modelProvider,
    thread: { ...response.thread, modelProvider },
  };
}

function createSupervisedCommitRequest() {
  return vi.fn(async (method: string, _requestParams?: unknown) => {
    if (method === "config/read") {
      return { config: {}, origins: {}, layers: [] };
    }
    if (method === "configRequirements/read") {
      return { requirements: null };
    }
    if (method === "thread/read") {
      return { thread: sourceThread({ threadId: sourceThreadId }) };
    }
    if (method === "thread/fork") {
      return nativeThreadResult(probeThreadId, "native-effective", "native-provider");
    }
    if (method === "thread/start") {
      return nativeThreadResult(finalThreadId, "native-effective", "native-provider");
    }
    if (method === "thread/archive" || method === "thread/unsubscribe") {
      return {};
    }
    throw new Error(`unexpected method: ${method}`);
  });
}

function sourceThread(params: {
  threadId: string;
  status?: "idle" | "active" | "notLoaded";
  turns?: Array<Record<string, unknown>>;
}) {
  return {
    ...threadStartResult(params.threadId).thread,
    status: { type: params.status ?? "idle" },
    turns: params.turns ?? [],
  };
}

function createTimingLogger(traceEnabled: boolean): CodexThreadLifecycleTimingLogger {
  return {
    isEnabled: vi.fn((level: "trace") => level === "trace" && traceEnabled),
    trace: vi.fn(),
    warn: vi.fn(),
  };
}

function expectSingleLogMessage(
  log: CodexThreadLifecycleTimingLogger,
  level: "trace" | "warn",
): string {
  const mock = log[level] as ReturnType<typeof vi.fn>;
  expect(mock).toHaveBeenCalledTimes(1);
  const message = mock.mock.calls[0]?.[0];
  expect(typeof message).toBe("string");
  return message as string;
}

describe("Codex app-server native code mode config", () => {
  it("never advertises unavailable delegation or session tools", () => {
    const restrictedParams = [
      Object.assign(createAttemptParams({ provider: "openai" }), {
        delegationCapability: "report_only" as const,
      }),
      Object.assign(createAttemptParams({ provider: "openai" }), { toolsAllow: ["openclaw"] }),
      Object.assign(createAttemptParams({ provider: "openai" }), { modelId: "gpt-5.4-nano" }),
      Object.assign(createAttemptParams({ provider: "openai" }), { disableTools: true }),
    ];

    for (const params of restrictedParams) {
      const instructions = buildDeveloperInstructions(params);
      expect(instructions).not.toContain("`spawn_agent`");
      expect(instructions).not.toContain("`sessions_spawn`");
      expect(instructions).not.toContain("`wait_agent`");
    }

    const instructions = buildDeveloperInstructions(createAttemptParams({ provider: "openai" }), {
      dynamicTools: [],
    });
    expect(instructions).toContain("`spawn_agent`");
    expect(instructions).not.toContain("`sessions_spawn`");
  });

  it("materializes the openclaw_direct prompt inventory once with matching guidance", () => {
    const params = createAttemptParams({ provider: "openai" });
    params.sourceReplyDeliveryMode = "message_tool_only";
    let namespaceReads = 0;
    const yieldTool: CodexDynamicToolFunctionSpec = {
      type: "function",
      name: "sessions_yield",
      description: "End the current turn",
      inputSchema: { type: "object" },
    };
    const tools = [
      yieldTool,
      ...["zeta_tool", "message", "skill_workshop", "alpha_tool", "sessions_spawn"].map(
        (name): CodexDynamicToolFunctionSpec => ({
          type: "function",
          name,
          description: name,
          inputSchema: { type: "object" },
          deferLoading: ["zeta_tool", "skill_workshop", "alpha_tool"].includes(name),
        }),
      ),
    ];
    const instructions = buildDeveloperInstructions(params, {
      dynamicTools: [
        yieldTool,
        {
          type: "namespace",
          name: "openclaw_direct",
          description: "",
          get tools() {
            namespaceReads += 1;
            return tools;
          },
        },
      ],
    });
    expect(namespaceReads).toBe(1);
    expect(instructions.includes("`openclaw_direct.sessions_yield`")).toBe(true);
    expect(instructions.includes("native `wait_agent`")).toBe(true);
    expect(instructions).toContain(
      "Deferred searchable OpenClaw dynamic tools available: alpha_tool, skill_workshop, zeta_tool.",
    );
    expect(instructions).toContain("## Skill Workshop");
    expect(instructions).toContain("Use Codex native `spawn_agent` for Codex subagents");
    expect(instructions).toContain("Use `tool_search` to find a tool that is not listed");
    expect(instructions).toContain(
      "Never use `exec` to look up a tool that is already listed, and do not re-run a completed call to get a result you already have.",
    );
    expect(instructions).not.toContain("On code-mode-only models");
    expect(instructions).toContain(
      "Use OpenClaw `sessions_spawn` only for OpenClaw or ACP delegation, never as a substitute for `spawn_agent` on internal legwork.",
    );
  });

  it("keeps hashed dynamic tool fingerprints compatible with legacy JSON bindings", () => {
    const tools = [
      {
        type: "function" as const,
        name: "message",
        description: "Send a visible message",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: {
            text: { type: "string" },
          },
          required: ["text"],
        },
      },
    ];
    const hashed = codexDynamicToolsFingerprint(tools);
    const legacy = codexLegacyDynamicToolsFingerprint(tools);

    expect(hashed).toMatch(/^sha256:/);
    expect(legacy).toContain('"name":"message"');
    expect(
      areCodexDynamicToolFingerprintsCompatible({
        previous: legacy,
        next: hashed,
        nextLegacy: legacy,
      }),
    ).toBe(true);
  });

  it("honors an explicit top-level reviewer on thread start and resume", () => {
    const appServer = {
      ...createAppServerOptions(),
      approvalsReviewer: "auto_review" as const,
    };
    const config = { approvals_reviewer: "user" };

    const started = buildThreadStartParams(createAttemptParams({ provider: "openai" }), {
      cwd: "/repo",
      dynamicTools: [],
      appServer: appServer as never,
      developerInstructions: "test instructions",
      config,
    });
    const resumed = buildThreadResumeParams(createAttemptParams({ provider: "openai" }), {
      threadId: "thread-1",
      appServer: appServer as never,
      developerInstructions: "test instructions",
      config,
    });

    expect(started.approvalsReviewer).toBe("user");
    expect(resumed.approvalsReviewer).toBe("user");
  });

  it("preserves omitted native tiers until a previously owned sticky tier must be cleared", () => {
    const options = {
      threadId: "thread-1",
      cwd: "/repo",
      appServer: createAppServerOptions() as never,
    };
    const inherited = buildTurnStartParams(createAttemptParams({ provider: "openai" }), options);
    const cleared = buildTurnStartParams(createAttemptParams({ provider: "openai" }), {
      ...options,
      clearInheritedServiceTier: true,
    });

    expect(inherited).not.toHaveProperty("serviceTier");
    expect(cleared.serviceTier).toBeNull();
  });

  it.each([
    { nativeCodeModeOnlyEnabled: false, configured: false },
    { nativeCodeModeOnlyEnabled: true, configured: true },
  ])(
    "keeps direct-only dynamic namespaces model-visible when code-mode-only=$nativeCodeModeOnlyEnabled, configured=$configured",
    ({ nativeCodeModeOnlyEnabled, configured }) => {
      const dynamicTools = [
        {
          type: "namespace" as const,
          name: CODEX_OPENCLAW_DIRECT_DYNAMIC_TOOL_NAMESPACE,
          description: "",
          tools: [],
        },
      ];
      const config = configured
        ? {
            "features.code_mode": {
              enabled: true,
              default_exec_yield_time_ms: 10000,
              excluded_tool_namespaces: ["vendor_excluded"],
              direct_only_tool_namespaces: ["vendor_direct"],
            },
          }
        : undefined;
      const startRequest = buildThreadStartParams(createAttemptParams({ provider: "openai" }), {
        cwd: "/repo",
        dynamicTools,
        appServer: createAppServerOptions() as never,
        nativeCodeModeOnlyEnabled,
        config,
      });
      const resumeRequest = buildThreadResumeParams(createAttemptParams({ provider: "openai" }), {
        threadId: "thread-1",
        dynamicTools,
        appServer: createAppServerOptions() as never,
        nativeCodeModeOnlyEnabled,
        config,
      });

      for (const request of [startRequest, resumeRequest]) {
        expect(request.config?.["features.code_mode"]).toEqual({
          enabled: true,
          ...(configured
            ? {
                default_exec_yield_time_ms: 10000,
                excluded_tool_namespaces: ["vendor_excluded"],
              }
            : {}),
          direct_only_tool_namespaces: [
            ...(configured ? ["vendor_direct"] : []),
            CODEX_OPENCLAW_DIRECT_DYNAMIC_TOOL_NAMESPACE,
          ],
        });
        expect(request.config?.["code_mode.direct_only_tool_namespaces"]).toBeUndefined();
        expect(request.config?.["features.code_mode_only"]).toBe(nativeCodeModeOnlyEnabled);
        expect(request.developerInstructions?.includes("On code-mode-only models")).toBe(
          nativeCodeModeOnlyEnabled,
        );
      }
    },
  );

  it.each([false, true])(
    "configures native tools and project documents for lightweight=%s",
    (lightweight) => {
      const request = buildThreadStartParams(
        createAttemptParams({
          provider: "openai",
          ...(lightweight
            ? ({ bootstrapContextMode: "lightweight", bootstrapContextRunKind: "cron" } as const)
            : { modelId: "gpt-5.4-nano" }),
        }),
        {
          cwd: "/repo",
          dynamicTools: [],
          appServer: createAppServerOptions() as never,
          developerInstructions: "test instructions",
          ...(lightweight
            ? { config: { ...authoredProjectDocConfig(200_000), "features.hooks": true } }
            : {}),
        },
      );
      expect(request.config).toEqual({
        project_doc_max_bytes: lightweight ? 0 : 131_072,
        ...(lightweight ? { "features.hooks": true } : { "features.multi_agent": false }),
        "features.code_mode": true,
        "features.code_mode_only": false,
        "features.goals": false,
        "tools.update_plan.enabled": false,
        "features.shell_tool": true,
        "features.apply_patch_streaming_events": true,
        suppress_unstable_features_warning: true,
        "features.standalone_web_search": false,
        web_search: "cached",
      });
    },
  );

  it("rejects authored negative project-document budgets before applying request overrides", () => {
    const effectiveNativeConfig = {
      config: { project_doc_max_bytes: -1 },
      origins: {
        project_doc_max_bytes: {
          name: { type: "user" as const, file: "/codex/config.toml", profile: null },
          version: "sha256:authored-budget",
        },
      },
      layers: [],
    };
    expect(() => buildCodexProjectDocThreadConfig(undefined, effectiveNativeConfig)).toThrow(
      "Codex config/read returned an invalid project_doc_max_bytes value",
    );
  });
});

describe("Codex app-server turn input image sanitizing", () => {
  const excludedTmpStart = {
    args: [
      "-csandbox_workspace_write.exclude_tmpdir_env_var=true",
      "-csandbox_workspace_write.exclude_slash_tmp=true",
      "app-server",
    ],
  };

  it.each([
    {
      name: "commented true across separate and attached forms",
      args: [
        "-c",
        "sandbox_workspace_write.exclude_tmpdir_env_var = false # earlier",
        "--config=sandbox_workspace_write.exclude_tmpdir_env_var = true # exclusion retained",
        "--config",
        "sandbox_workspace_write.exclude_slash_tmp = false # earlier",
        "-c=sandbox_workspace_write.exclude_slash_tmp = true # exclusion retained",
      ],
      excluded: true,
    },
    {
      name: "quoted booleans remain strings",
      args: [
        '-csandbox_workspace_write.exclude_tmpdir_env_var="true" # not a boolean',
        "--config=sandbox_workspace_write.exclude_slash_tmp='true' # not a boolean",
      ],
      excluded: false,
    },
    {
      name: "option value and terminator",
      args: [
        "--ws-issuer",
        "-csandbox_workspace_write.exclude_tmpdir_env_var=true",
        "--",
        "--config=sandbox_workspace_write.exclude_slash_tmp=true",
      ],
      excluded: false,
    },
  ])(
    "carries native workspace temporary-root overrides into turn policy: $name",
    ({ args, excluded }) => {
      const request = buildTurnStartParams(createAttemptParams({ provider: "openai" }), {
        threadId: "thread-1",
        cwd: "/tmp/qa/workspace",
        appServer: {
          ...createAppServerOptions(),
          start: { args: ["app-server", ...args] },
        } as never,
      });
      expect(request.sandboxPolicy).toEqual({
        type: "workspaceWrite",
        writableRoots: ["/tmp/qa/workspace"],
        networkAccess: false,
        excludeTmpdirEnvVar: excluded,
        excludeSlashTmp: excluded,
      });
    },
  );

  it("uses the explicit undefined sandbox override ahead of network-proxy permissions", () => {
    const request = buildTurnStartParams(createAttemptParams({ provider: "openai" }), {
      threadId: "thread-1",
      cwd: "/repo",
      appServer: { ...createNetworkProxyAppServerOptions(), start: excludedTmpStart } as never,
      sandboxPolicy: undefined,
    });
    expect(request).not.toHaveProperty("permissions");
    expect(request).not.toHaveProperty("sandboxPolicy");
  });

  it("replaces malformed inline images before turn/start", () => {
    const request = buildTurnStartParams(
      createAttemptParams({
        provider: "openai",
        images: [{ type: "image", mimeType: "image/jpeg", data: "not base64!" }] as never,
      }),
      {
        threadId: "thread-1",
        cwd: "/repo",
        appServer: createAppServerOptions() as never,
      },
    );

    expect(request.input).toEqual([
      { type: "text", text: "test prompt", text_elements: [] },
      {
        type: "text",
        text: "[codex user input] omitted image payload: invalid inline image data",
        text_elements: [],
      },
    ]);
  });
});

describe("Codex app-server turn params", () => {
  it.each(["user", "cron"] as const)(
    "builds resume and %s turn params from the selected OpenClaw model",
    (trigger) => {
      const params = createAttemptParams({ provider: "codex" });
      params.modelId = "gpt-5.4-codex";
      params.thinkLevel = "medium";
      params.trigger = trigger;
      const appServer = {
        start: {
          transport: "stdio" as const,
          command: "codex",
          args: ["app-server", "--listen", "stdio://"],
          headers: {},
        },
        codeModeOnly: false,
        loopDetectionPreToolUseRelay: true,
        requestTimeoutMs: 60_000,
        approvalPolicy: "on-request" as const,
        approvalsReviewer: "guardian_subagent" as const,
        sandbox: "danger-full-access" as const,
        connectionClass: "local-loopback" as const,
        serviceTier: "flex" as const,
      };

      const resumeParams = buildThreadResumeParams(params, { threadId: "thread-1", appServer });
      expect(resumeParams).toEqual({
        threadId: "thread-1",
        excludeTurns: true,
        initialTurnsPage: {
          limit: 1,
          sortDirection: "desc",
          itemsView: "notLoaded",
        },
        model: "gpt-5.4-codex",
        approvalPolicy: "on-request",
        approvalsReviewer: "guardian_subagent",
        config: {
          project_doc_max_bytes: 131_072,
          "features.code_mode": true,
          "features.code_mode_only": false,
          "features.goals": false,
          "tools.update_plan.enabled": false,
          "features.shell_tool": true,
          "features.apply_patch_streaming_events": true,
          suppress_unstable_features_warning: true,
          "features.standalone_web_search": false,
          web_search: "cached",
        },
        sandbox: "danger-full-access",
        serviceTier: "flex",
        personality: "none",
        developerInstructions: resumeParams.developerInstructions,
      });
      expect(resumeParams.developerInstructions).not.toContain(CODEX_GPT5_BEHAVIOR_CONTRACT);
      const turnParams = buildTurnStartParams(params, {
        threadId: "thread-1",
        cwd: "/tmp/workspace",
        appServer,
      });
      expect(turnParams.turnTrigger).toBe(trigger);
      expect(turnParams.threadId).toBe("thread-1");
      expect(turnParams.cwd).toBe("/tmp/workspace");
      expect(turnParams.model).toBe("gpt-5.4-codex");
      expect(turnParams.approvalPolicy).toBe("on-request");
      expect(turnParams.approvalsReviewer).toBe("guardian_subagent");
      expect(turnParams.sandboxPolicy).toEqual({ type: "dangerFullAccess" });
      expect(turnParams.serviceTier).toBe("flex");
      const collaboration = turnParams.collaborationMode;
      if (trigger === "user") {
        expect(collaboration).toEqual({
          mode: "default",
          settings: {
            model: "gpt-5.4-codex",
            reasoning_effort: "medium",
            developer_instructions: null,
          },
        });
      } else {
        expect(collaboration?.mode).toBe("default");
        expect(collaboration?.settings.model).toBe("gpt-5.4-codex");
        expect(collaboration?.settings.reasoning_effort).toBe("medium");
        for (const instruction of [
          "This is an OpenClaw cron automation turn",
          "If it asks you to run an exact command, run that command before doing any investigation",
          "Use context already provided by the runtime",
        ]) {
          expect(collaboration?.settings.developer_instructions).toContain(instruction);
        }
      }
    },
  );
});

describe("Codex app-server model provider selection", () => {
  it.each([
    {
      name: "bound native profile",
      attempt: {
        provider: "openai",
        authProfileProviders: { bound: "openai" },
        runtimeExternalProfileIds: ["bound"],
      },
      boundProfile: "bound",
      expected: undefined,
    },
    {
      name: "API-key profile with native-looking prefix",
      attempt: {
        provider: "openai",
        authProfileId: "openai:work",
        authProfileType: "api_key" as const,
        authProfileProvider: "openai",
      },
      expected: "openai",
    },
  ])("selects the model provider from $name", ({ attempt, boundProfile, expected }) => {
    const params = createAttemptParams(attempt);
    const options = {
      appServer: createAppServerOptions() as never,
      developerInstructions: "test instructions",
    };
    const request = boundProfile
      ? buildThreadResumeParams(params, {
          ...options,
          threadId: "thread-1",
          authProfileId: boundProfile,
        })
      : buildThreadStartParams(params, { ...options, cwd: "/repo", dynamicTools: [] });
    if (expected) {
      expect(request.modelProvider).toBe(expected);
    } else {
      expect(request).not.toHaveProperty("modelProvider");
    }
  });
});

describe("Codex plugin binding recovery", () => {
  installLifecycleHooks();

  it("keys remote ownership to the selected catalog home for a local-looking remote path", async () => {
    const rolloutPath = path.join(
      tempDir,
      "poison",
      "sessions",
      "2026",
      "08",
      "thread-managed-remote.jsonl",
    );
    const params = createThreadLifecycleParams(
      path.join(tempDir, "session-managed-remote.jsonl"),
      path.join(tempDir, "workspace-managed-remote"),
    );
    params.agentDir = path.join(tempDir, "agent");
    const mark = vi.fn(async () => undefined);
    const bindingStore = Object.assign(
      createCodexAppServerBindingStore(createCodexTestBindingStateStore()),
      {
        managedThreads: {
          has: vi.fn(async () => false),
          mark,
          snapshot: vi.fn(async () => new Map()),
        },
      },
    );
    const request = createLifecycleRequest(async (method: string) => {
      if (method === "thread/start") {
        const result = threadStartResult("thread-managed-remote");
        return { ...result, thread: { ...result.thread, path: rolloutPath } };
      }
      throw new Error(`unexpected method: ${method}`);
    });
    const appServer = createThreadLifecycleAppServerOptions();
    appServer.start = {
      ...appServer.start,
      transport: "websocket",
      url: "wss://codex.example.test/app-server",
    };
    appServer.connectionClass = "remote";

    await startOrResumeThreadImpl({
      client: {
        request,
        getRuntimeIdentity: () => ({ codexHome: "/remote/codex" }),
      } as never,
      params,
      cwd: params.workspaceDir!,
      dynamicTools: [],
      appServer,
      bindingStore,
    });

    expect(mark).toHaveBeenCalledWith({
      sourceHomeId: codexCatalogHomeId(resolveCodexAppServerHomeDir(params.agentDir)),
      threadId: "thread-managed-remote",
      rolloutPath,
    });
  });

  it("starts a durable thread when catalog ownership bookkeeping fails", async () => {
    const params = createThreadLifecycleParams(
      path.join(tempDir, "session-managed-failure.jsonl"),
      path.join(tempDir, "workspace-managed-failure"),
    );
    const stateStore = createCodexTestBindingStateStore();
    const registerIfAbsent = vi.fn().mockRejectedValue(new Error("managed ownership unavailable"));
    const bindingStore = Object.assign(createCodexAppServerBindingStore(stateStore), {
      managedThreads: createCodexManagedThreadStore({
        entries: async () => [],
        registerIfAbsent,
      }),
    });
    const request = createLifecycleRequest(async (method: string) => {
      if (method === "thread/start") {
        return threadStartResult("thread-managed-without-index");
      }
      throw new Error(`unexpected method: ${method}`);
    });

    await expect(
      startOrResumeThreadImpl({
        client: {
          request,
          getRuntimeIdentity: () => ({ codexHome: path.join(tempDir, "codex-home") }),
        } as never,
        params,
        cwd: params.workspaceDir!,
        dynamicTools: [],
        appServer: createThreadLifecycleAppServerOptions(),
        bindingStore,
      }),
    ).resolves.toMatchObject({ threadId: "thread-managed-without-index" });
    expect(registerIfAbsent).toHaveBeenCalledOnce();
  });

  it("applies a settled plugin denial before resume without replacing the native binding", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const params = createThreadLifecycleParams(sessionFile, workspaceDir);
    const respond = createLifecycleRequest(async (method: string) => {
      if (method === "thread/start" || method === "thread/resume") {
        return threadStartResult("thread-settled-transition");
      }
      throw new Error(`unexpected method: ${method}`);
    });
    const build = vi
      .fn()
      .mockResolvedValueOnce({
        enabled: true,
        configPatch: { apps: { calendar: { enabled: true } } },
        fingerprint: "plugin-config-active",
        inputFingerprint: "plugin-input-settled",
        policyContext: {
          fingerprint: "plugin-policy-active",
          apps: {
            calendar: {
              configKey: "calendar",
              marketplaceName: "openai-curated" as const,
              pluginName: "calendar",
              allowDestructiveActions: false,
              mcpServerNames: [],
            },
          },
          pluginAppIds: { calendar: ["calendar"] },
        },
        diagnostics: [],
      })
      .mockResolvedValue({
        enabled: true,
        configPatch: { apps: { _default: { enabled: false }, calendar: { enabled: false } } },
        fingerprint: "plugin-config-settled",
        inputFingerprint: "plugin-input-settled",
        policyContext: { fingerprint: "plugin-policy-settled", apps: {}, pluginAppIds: {} },
        diagnostics: [],
      });
    const fixture = await createLeasedCodexLifecycleHarness({
      agentDir: path.join(tempDir, "agent"),
      respond,
    });
    const { client, request } = fixture;
    const common = {
      client,
      signal: new AbortController().signal,
      ...lifecycleOptions(params),
    };

    await startOrResumeThread({
      ...common,
      pluginThreadConfig: {
        enabled: true,
        inputFingerprint: "plugin-input-settled",
        enabledPluginConfigKeys: ["calendar"],
        recoverablePluginConfigKeys: ["calendar"],
        build,
      },
    });
    await fixture.endTurn("thread-settled-transition");
    const settledProvider = {
      enabled: true,
      inputFingerprint: "plugin-input-settled",
      enabledPluginConfigKeys: ["calendar"],
      recoverablePluginConfigKeys: [],
      build,
    };
    await startOrResumeThread({ ...common, pluginThreadConfig: settledProvider });
    await fixture.endTurn("thread-settled-transition");
    await startOrResumeThread({ ...common, pluginThreadConfig: settledProvider });

    for (const [, resumeParams] of request.mock.calls.filter(
      ([method]) => method === "thread/resume",
    )) {
      expect(resumeParams).toMatchObject({
        threadId: "thread-settled-transition",
        config: { apps: { calendar: { enabled: false } } },
      });
    }
    expect(request.mock.calls.map(([method]) => method)).toEqual([
      "config/read",
      "configRequirements/read",
      "thread/start",
      "thread/unsubscribe",
      "config/read",
      "configRequirements/read",
      "thread/read",
      "thread/resume",
      "thread/inject_items",
      "thread/unsubscribe",
      "config/read",
      "configRequirements/read",
      "thread/read",
      "thread/resume",
      "thread/inject_items",
    ]);
  });

  it("rotates warm bindings across scheduled authority changes and resumes after store restart", async () => {
    const sessionFile = path.join(tempDir, "session-authority.jsonl");
    const authorityWorkspace = path.join(tempDir, "workspace-authority");
    const params = createThreadLifecycleParams(sessionFile, authorityWorkspace);
    const stateStore = createCodexTestBindingStateStore();
    let bindingStore = createCodexAppServerBindingStore(stateStore);
    let threadSequence = 0;
    const threadStarts: Array<Record<string, unknown>> = [];
    const respond = createLifecycleRequest(async (method: string, requestParams?: unknown) => {
      if (method === "thread/start") {
        threadSequence += 1;
        threadStarts.push(requestParams as Record<string, unknown>);
        return threadStartResult(`thread-authority-${threadSequence}`);
      }
      if (method === "thread/resume") {
        const threadId = (requestParams as { threadId?: string })?.threadId;
        return threadStartResult(threadId ?? "thread-resumed");
      }
      if (method === "app/installed") {
        return {
          apps: [{ id: "calendar", runtimeName: "Calendar", enabled: true, callable: true }],
        };
      }
      throw new Error(`unexpected method: ${method}`);
    });
    const provider = (inputFingerprint: string, destructive: boolean) => {
      const base = createProvisionalPluginThreadConfigProvider("calendar");
      return {
        ...base,
        requiresCurrentPolicyCheck: true,
        inputFingerprint,
        build: vi.fn(async () => {
          const config = await base.build();
          const apps = config.configPatch?.apps as Record<string, Record<string, unknown>>;
          return {
            ...config,
            inputFingerprint,
            fingerprint: `${inputFingerprint}:${destructive}`,
            configPatch: {
              ...config.configPatch,
              apps: {
                ...apps,
                calendar: {
                  ...apps.calendar,
                  destructive_enabled: destructive,
                  tools: {
                    edit: { approval_mode: destructive ? "approve" : "prompt" },
                  },
                },
              },
            },
          };
        }),
      };
    };
    const fixture = await createLeasedCodexLifecycleHarness({
      agentDir: path.join(tempDir, "agent"),
      respond,
    });
    const { client, request } = fixture;
    const common = {
      client,
      signal: new AbortController().signal,
      ...lifecycleOptions(params),
    };

    await startOrResumeThreadImpl({
      ...common,
      bindingStore,
      pluginThreadConfig: provider("unrestricted", true),
    });
    await fixture.endTurn("thread-authority-1");
    const revokedProvider = provider("unrestricted", true);
    revokedProvider.build.mockRejectedValueOnce(new Error("calendar revoked by current policy"));
    await expect(
      startOrResumeThreadImpl({
        ...common,
        bindingStore,
        pluginThreadConfig: revokedProvider,
      }),
    ).rejects.toThrow("calendar revoked by current policy");
    await startOrResumeThreadImpl({
      ...common,
      bindingStore,
      pluginThreadConfig: provider("scheduled-cap-1", false),
    });
    await fixture.endTurn("thread-authority-2");
    await startOrResumeThreadImpl({
      ...common,
      bindingStore,
      pluginThreadConfig: provider("unrestricted", true),
    });
    await fixture.endTurn("thread-authority-3");
    bindingStore = createCodexAppServerBindingStore(stateStore);
    await startOrResumeThreadImpl({
      ...common,
      bindingStore,
      pluginThreadConfig: provider("unrestricted", true),
    });

    expect(request.mock.calls.map(([method]) => method)).toEqual([
      "config/read",
      "configRequirements/read",
      "thread/start",
      "app/installed",
      "thread/unsubscribe",
      "config/read",
      "configRequirements/read",
      "thread/read",
      "config/read",
      "configRequirements/read",
      "thread/start",
      "app/installed",
      "thread/unsubscribe",
      "config/read",
      "configRequirements/read",
      "thread/start",
      "app/installed",
      "thread/unsubscribe",
      "config/read",
      "configRequirements/read",
      "thread/read",
      "thread/resume",
      "app/installed",
      "thread/inject_items",
    ]);
    expect(threadStarts).toHaveLength(3);
    expect(threadStarts[1]?.config).toMatchObject({
      apps: { calendar: { destructive_enabled: false } },
    });
    expect(threadStarts[2]?.config).toMatchObject({
      apps: { calendar: { destructive_enabled: true } },
    });
    const resumeCall = request.mock.calls.find(([method]) => method === "thread/resume");
    expect((resumeCall?.[1] as { config?: unknown })?.config).toMatchObject({
      apps: {
        calendar: {
          destructive_enabled: true,
          tools: { edit: { approval_mode: "approve" } },
        },
      },
    });
  });
});

describe("Codex thread-effective app attestation", () => {
  installLifecycleHooks();

  it("keeps the heartbeat binding when its optional app is not-callable", async () => {
    const params = createThreadLifecycleParams();
    params.sessionKey = "agent:main:main";
    const provider = createProvisionalPluginThreadConfigProvider("linear-app");
    const expectedConfig = (await provider.build()).configPatch;
    const fixture = await createLeasedCodexLifecycleHarness({
      agentDir: path.join(tempDir, "agent"),
      respond: (method, requestParams) => {
        if (method === "config/read") {
          return { config: {}, origins: {}, layers: [] };
        }
        if (method === "configRequirements/read") {
          return { requirements: null };
        }
        if (method === "thread/start") {
          expect(requestParams).toMatchObject({ config: expectedConfig });
          return threadStartResult("thread-app-unavailable");
        }
        if (method === "app/installed") {
          return {
            apps: [
              {
                id: "linear-app",
                runtimeName: "Linear",
                enabled: true,
                callable: false,
              },
            ],
          };
        }
        throw new Error(`unexpected method: ${method}`);
      },
    });
    const abandonClient = vi.fn(async () => {});
    const result = await startOrResumeThread({
      client: fixture.client,
      abandonClient,
      ...lifecycleOptions(params),
      pluginThreadConfig: provider,
      signal: new AbortController().signal,
    });
    expect(result.threadId).toBe("thread-app-unavailable");
    expect(
      testCodexAppServerBindingStore.read(
        sessionBindingIdentity({
          sessionId: params.sessionId,
          sessionKey: params.sessionKey,
          agentId: params.agentId,
          config: params.config,
        }),
      ),
    ).toMatchObject({ threadId: result.threadId });
    expect(
      fixture.request.mock.calls.some(
        ([method]) => method === "thread/delete" || method === "thread/unsubscribe",
      ),
    ).toBe(false);
    expect(abandonClient).not.toHaveBeenCalled();
  });
  it("retires the client when failed ephemeral app admission cannot unsubscribe", async () => {
    const params = createThreadLifecycleParams();
    params.sessionKey = "agent:main:internal-session-effects:incognito-plugin-attestation";
    const abandonClient = vi.fn(async () => undefined);
    const request = createLifecycleRequest(async (method: string, requestParams?: unknown) => {
      if (method === "thread/start") {
        expect(requestParams).toMatchObject({ ephemeral: true });
        return threadStartResult("thread-linear");
      }
      if (method === "app/installed") {
        throw new Error("app inventory offline");
      }
      if (method === "thread/unsubscribe") {
        throw new Error("unsubscribe unavailable");
      }
      throw new Error(`unexpected method: ${method}`);
    });
    await expect(
      startOrResumeThread({
        ...lifecycleOptions(params),
        client: { request } as never,
        abandonClient,
        pluginThreadConfig: createProvisionalPluginThreadConfigProvider("linear-app"),
      }),
    ).rejects.toMatchObject({
      name: "CodexAppServerUnsafeSubscriptionError",
      message: "Codex uncommitted thread cleanup failed",
    });
    expect(request.mock.calls.map(([method]) => method)).toEqual([
      "config/read",
      "configRequirements/read",
      "thread/start",
      "app/installed",
      "thread/unsubscribe",
    ]);
    expect(abandonClient).toHaveBeenCalledTimes(1);
  });
});

describe("Codex app-server supervised branch lifecycle", () => {
  installLifecycleHooks();

  it.each([
    "unsubscribe timeout",
    "abort after fork",
    "abort during unsubscribe",
    "fork response lost",
    "malformed probe response",
  ])("continues without archiving the model probe after %s", async (fault) => {
    const attempt = createThreadLifecycleParams();
    const identity = await seedPendingSupervisionBinding(attempt);
    const source = sourceThread({ threadId: sourceThreadId });
    const before = structuredClone(source);
    const harness = createClientHarness();
    const controller = new AbortController();
    const abandonClient = vi.fn(async () => {
      harness.client.close();
    });
    const initial = testCodexAppServerBindingStore.read(identity);
    const write = harness.process.stdin.write.bind(harness.process.stdin);
    vi.spyOn(harness.process.stdin, "write").mockImplementation((...args) => {
      const written = write(...args);
      const request = JSON.parse(String(args[0]));
      let result: unknown;
      if (request.method === "config/read") {
        result = { config: {}, origins: {}, layers: [] };
      } else if (request.method === "configRequirements/read") {
        result = { requirements: null };
      } else if (request.method === "thread/read") {
        result = { thread: source };
      } else if (request.method === "thread/fork" || request.method === "thread/start") {
        const threadId = request.method === "thread/fork" ? probeThreadId : finalThreadId;
        result =
          request.method === "thread/fork" && fault === "malformed probe response"
            ? { thread: { id: probeThreadId }, model: 42 }
            : nativeThreadResult(threadId, "gpt-5.6-luna", "openai");
        if (request.method === "thread/fork" && fault === "fork response lost") {
          queueMicrotask(() => controller.abort(new Error(fault)));
          return written;
        }
      } else if (request.method === "thread/unsubscribe") {
        if (fault === "unsubscribe timeout") {
          return written;
        }
        result = { status: "unsubscribed" };
      } else if (request.method === "thread/archive") {
        // A native catalog scan can outlive the cleanup deadline. Leave this
        // request unanswered so the real client owns cancellation/uncertainty.
        return written;
      } else {
        throw new Error(`unexpected method: ${request.method}`);
      }
      queueMicrotask(() => {
        harness.send({ id: request.id, result });
        if (
          (request.method === "thread/fork" && fault === "abort after fork") ||
          (request.method === "thread/unsubscribe" && fault === "abort during unsubscribe")
        ) {
          controller.abort(new Error(fault));
        }
      });
      return written;
    });
    try {
      if (fault === "unsubscribe timeout") {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      }
      const outcome = startOrResumeThread({
        client: harness.client,
        abandonClient,
        signal: controller.signal,
        ...lifecycleOptions(attempt),
      }).then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      if (fault === "unsubscribe timeout") {
        expect(JSON.parse(await harness.waitForWrite(4))).toMatchObject({
          method: "thread/unsubscribe",
          params: { threadId: probeThreadId },
        });
        await vi.advanceTimersByTimeAsync(CODEX_APP_SERVER_UNSUBSCRIBE_TIMEOUT_MS);
      }
      const settled = await outcome;
      const requests = harness.writes.map((line) => JSON.parse(line));
      expect(source).toEqual(before);
      const unsafe = fault === "unsubscribe timeout" || fault === "fork response lost";
      expect(settled).toMatchObject({
        error: { name: unsafe ? "CodexAppServerUnsafeSubscriptionError" : "Error" },
      });
      expect(abandonClient).toHaveBeenCalledTimes(unsafe ? 1 : 0);
      expect(requests.map((request) => request.method)).toEqual(
        fault === "fork response lost"
          ? ["config/read", "configRequirements/read", "thread/read", "thread/fork"]
          : [
              "config/read",
              "configRequirements/read",
              "thread/read",
              "thread/fork",
              "thread/unsubscribe",
            ],
      );
      if (fault === "unsubscribe timeout") {
        expect(settled).toMatchObject({
          error: {
            cause: {
              code: "CODEX_APP_SERVER_LOCAL_REQUEST_CANCELLED",
              reason: "timed out",
              mayHaveWritten: true,
            },
          },
        });
      }
      expect(testCodexAppServerBindingStore.read(identity)).toEqual(initial);
    } finally {
      try {
        harness.client.close();
      } finally {
        if (fault === "unsubscribe timeout") {
          vi.useRealTimers();
        }
      }
    }
  });

  it("materializes a model-locked canonical branch with frozen agent instructions", async () => {
    const lastTurnId = "turn-terminal";
    const agentWorkspaceDeveloperInstructions = "Follow the frozen supervised AGENTS guidance.";
    const attempt = createThreadLifecycleParams();
    attempt.agentDir = path.join(tempDir, "agent");
    const rolloutPath = path.join(
      resolveCodexAppServerHomeDir(attempt.agentDir),
      "sessions",
      `rollout-${finalThreadId}.jsonl`,
    );
    attempt.modelId = "outer-global-default";
    attempt.expectedSessionRuntimeOwnership = { model: "native", auth: "native" };
    const identity = await seedPendingSupervisionBinding(attempt, { sourceThreadId, lastTurnId });
    const terminalSource = sourceThread({
      threadId: sourceThreadId,
      turns: [
        {
          id: lastTurnId,
          status: "completed",
          items: [
            {
              id: "user-1",
              type: "userMessage",
              content: [{ type: "text", text: "Visible question" }],
            },
            { id: "reasoning-1", type: "reasoning", text: "Private reasoning" },
            {
              id: "assistant-1",
              type: "agentMessage",
              text: "Visible answer",
              phase: "final_answer",
            },
            { id: "tool-1", type: "commandExecution", command: "secret-tool" },
          ],
        },
      ],
    });
    const request = vi.fn(async (method: string, requestParams: unknown) => {
      if (method === "config/read") {
        return { config: {}, origins: {}, layers: [] };
      }
      if (method === "configRequirements/read") {
        return { requirements: null };
      }
      if (method === "thread/read") {
        const threadId = (requestParams as { threadId?: string }).threadId;
        return {
          thread:
            threadId === sourceThreadId
              ? terminalSource
              : {
                  ...sourceThread({ threadId: finalThreadId, status: "notLoaded" }),
                  path: rolloutPath,
                },
        };
      }
      if (method === "thread/fork") {
        return nativeThreadResult(probeThreadId, "native-effective", "native-provider");
      }
      if (method === "thread/start" || method === "thread/resume") {
        return nativeThreadResult(finalThreadId, "native-effective", "native-provider");
      }
      if (method === "thread/inject_items" || method === "thread/unsubscribe") {
        return {};
      }
      throw new Error(`unexpected method: ${method}`);
    });
    const dynamicTools = [
      {
        type: "function" as const,
        name: "message",
        description: "Send a message",
        inputSchema: { type: "object", properties: {} },
      },
    ];
    const commonParams = {
      client: { request } as never,
      params: attempt,
      cwd: workspaceDir,
      dynamicTools,
      developerInstructions: agentWorkspaceDeveloperInstructions,
      agentWorkspaceDeveloperInstructions,
      environmentSelection: [{ environmentId: "local", cwd: workspaceDir }],
      shellEnvironment: { GH_TOKEN: "", GITHUB_TOKEN: "" },
      disableLoginShell: true,
      appServer: createThreadLifecycleAppServerOptions(),
      appServerRuntimeFingerprint: "codex-runtime-v1",
    };

    const materialized = await startOrResumeThread(commonParams);

    expect(request.mock.calls.map(([method]) => method)).toEqual([
      "config/read",
      "configRequirements/read",
      "thread/read",
      "thread/fork",
      "thread/unsubscribe",
      "thread/start",
      "thread/inject_items",
    ]);
    expect(request.mock.calls[2]?.[1]).toEqual({
      threadId: sourceThreadId,
      includeTurns: true,
    });
    const forkParams = request.mock.calls[3]?.[1] as Record<string, unknown>;
    expect(forkParams).toMatchObject({
      threadId: sourceThreadId,
      lastTurnId,
      excludeTurns: true,
      developerInstructions: agentWorkspaceDeveloperInstructions,
      config: {
        project_doc_max_bytes: 131_072,
        allow_login_shell: false,
        shell_environment_policy: {
          experimental_use_profile: false,
          set: { GH_TOKEN: "", GITHUB_TOKEN: "" },
        },
      },
    });
    expect(forkParams).not.toHaveProperty("model");
    expect(forkParams).not.toHaveProperty("modelProvider");
    expect(forkParams).not.toHaveProperty("dynamicTools");
    expect(forkParams).not.toHaveProperty("environments");
    const startParams = request.mock.calls.find(
      ([method]) => method === "thread/start",
    )?.[1] as Record<string, unknown>;
    expect(startParams).toMatchObject({
      model: "native-effective",
      modelProvider: "native-provider",
      developerInstructions: agentWorkspaceDeveloperInstructions,
      dynamicTools,
      environments: [{ environmentId: "local", cwd: workspaceDir }],
      config: {
        project_doc_max_bytes: 131_072,
        allow_login_shell: false,
        shell_environment_policy: {
          experimental_use_profile: false,
          set: { GH_TOKEN: "", GITHUB_TOKEN: "" },
        },
      },
    });
    expect(startParams.model).not.toBe(attempt.modelId);
    expect(request.mock.calls.find(([method]) => method === "thread/inject_items")?.[1]).toEqual({
      threadId: finalThreadId,
      items: [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Visible question" }],
        },
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "Visible answer" }],
          phase: "final_answer",
        },
      ],
    });
    expect(
      JSON.stringify(request.mock.calls.find(([method]) => method === "thread/inject_items")?.[1]),
    ).not.toContain("Private reasoning");
    expect(
      JSON.stringify(request.mock.calls.find(([method]) => method === "thread/inject_items")?.[1]),
    ).not.toContain("secret-tool");
    expect(request.mock.calls[4]?.[1]).toEqual({ threadId: probeThreadId });
    expect(materialized).toMatchObject({
      threadId: finalThreadId,
      model: "native-effective",
      modelProvider: "native-provider",
      preserveNativeModel: true,
      agentWorkspaceDeveloperInstructions,
      conversationSourceTransferComplete: true,
      lifecycle: { action: "forked" },
    });
    expect(materialized.pendingSupervisionBranch).toBeUndefined();
    expect(materialized.historyCoveredThrough).not.toBe(new Date(0).toISOString());
    expect(testCodexAppServerBindingStore.read(identity)).toMatchObject({
      threadId: finalThreadId,
      model: "native-effective",
      modelProvider: "native-provider",
      preserveNativeModel: true,
      agentWorkspaceDeveloperInstructions,
      conversationSourceTransferComplete: true,
      appServerRuntimeFingerprint: buildCodexAppServerConnectionFingerprint(
        commonParams.appServer,
        attempt.agentDir,
      ),
    });

    await writeNativeCatalogFixture(rolloutPath, finalThreadId, startParams.dynamicTools);
    request.mockClear();
    const resumed = await withLeasedCodexTestClient({
      agentDir: path.join(tempDir, "agent"),
      request,
      run: (client) =>
        startOrResumeThread({
          ...commonParams,
          client,
          signal: AbortSignal.timeout(10_000),
          appServerRuntimeFingerprint: "codex-runtime-v2",
        }),
    });

    expect(request.mock.calls.map(([method]) => method)).toEqual([
      "thread/read",
      "config/read",
      "configRequirements/read",
      "thread/read",
      "thread/resume",
      "thread/inject_items",
    ]);
    expect(request.mock.calls[0]?.[1]).toEqual({ threadId: finalThreadId, includeTurns: false });
    expect(request.mock.calls[4]?.[1]).not.toHaveProperty("model");
    expect(request.mock.calls[4]?.[1]).not.toHaveProperty("modelProvider");
    expect(request.mock.calls[4]?.[1]).toMatchObject({
      developerInstructions: agentWorkspaceDeveloperInstructions,
    });
    expect(resumed).toMatchObject({
      threadId: finalThreadId,
      preserveNativeModel: true,
      conversationSourceTransferComplete: true,
      lifecycle: { action: "resumed" },
    });
    expect(testCodexAppServerBindingStore.read(identity)).toMatchObject({
      appServerRuntimeFingerprint: buildCodexAppServerConnectionFingerprint(
        commonParams.appServer,
        attempt.agentDir,
      ),
    });
  });

  it("isolates both supervised threads and restores native MCP config on the next unrestricted turn", async () => {
    const attempt = createThreadLifecycleParams();
    attempt.agentDir = path.join(tempDir, "agent");
    const rolloutPath = path.join(
      resolveCodexAppServerHomeDir(attempt.agentDir),
      "sessions",
      `rollout-${finalThreadId}.jsonl`,
    );
    attempt.pluginHarnessToolPolicyRestricted = true;
    attempt.toolsAllow = ["openclaw"];
    const identity = await seedPendingSupervisionBinding(attempt);
    const request = vi.fn(async (method: string, requestParams?: unknown) => {
      if (method === "config/read") {
        return {
          config: { mcp_servers: { inherited: { command: "inherited-mcp" } } },
          layers: [{ name: { type: "user" } }],
        };
      }
      if (method === "configRequirements/read") {
        return { requirements: null };
      }
      if (method === "thread/read") {
        const threadId = (requestParams as { threadId?: string }).threadId;
        return {
          thread:
            threadId === sourceThreadId
              ? sourceThread({ threadId: sourceThreadId })
              : {
                  ...sourceThread({ threadId: finalThreadId, status: "notLoaded" }),
                  path: rolloutPath,
                },
        };
      }
      if (method === "thread/fork") {
        return nativeThreadResult(probeThreadId, "native-effective", "native-provider");
      }
      if (method === "thread/start" || method === "thread/resume") {
        return nativeThreadResult(finalThreadId, "native-effective", "native-provider");
      }
      if (method === "mcpServerStatus/list") {
        return {
          data: [disabledMcpServerStatus("inherited"), disabledMcpServerStatus("request-only")],
          nextCursor: null,
        };
      }
      if (
        method === "thread/archive" ||
        method === "thread/unsubscribe" ||
        method === "thread/inject_items"
      ) {
        return {};
      }
      throw new Error(`unexpected method: ${method}`);
    });
    const common = {
      client: { request } as never,
      params: attempt,
      cwd: workspaceDir,
      dynamicTools: [],
      config: { mcp_servers: { "request-only": { command: "request-mcp" } } },
      appServer: createThreadLifecycleAppServerOptions(),
      nativeCodeModeEnabled: false,
      userMcpServersEnabled: false,
      hostSystemAgentActive: true,
    };

    await expect(startOrResumeThread(common)).resolves.toMatchObject({
      threadId: finalThreadId,
      lifecycle: { action: "forked" },
    });

    expect(request.mock.calls.map(([method]) => method)).toEqual([
      "config/read",
      "configRequirements/read",
      "thread/read",
      "thread/fork",
      "mcpServerStatus/list",
      "thread/unsubscribe",
      "thread/start",
      "mcpServerStatus/list",
    ]);
    for (const method of ["thread/fork", "thread/start"]) {
      const threadRequest = request.mock.calls.find(([candidate]) => candidate === method)?.[1] as
        | { config?: Record<string, unknown> }
        | undefined;
      expect(threadRequest?.config).toMatchObject({
        project_doc_max_bytes: 0,
        mcp_servers: {
          inherited: { enabled: false },
          "request-only": { command: "request-mcp", enabled: false },
        },
      });
    }
    expect(request.mock.calls.find(([method]) => method === "thread/start")?.[1]).toMatchObject({
      baseInstructions: "",
    });
    expect(
      request.mock.calls
        .filter(([method]) => method === "mcpServerStatus/list")
        .map(([, requestParams]) => requestParams),
    ).toEqual([
      { threadId: probeThreadId, detail: "toolsAndAuthOnly" },
      { threadId: finalThreadId, detail: "toolsAndAuthOnly" },
    ]);

    attempt.pluginHarnessToolPolicyRestricted = false;
    attempt.toolsAllow = undefined;
    await writeNativeCatalogFixture(rolloutPath, finalThreadId, common.dynamicTools);
    request.mockClear();
    await expect(
      withLeasedCodexTestClient({
        agentDir: path.join(tempDir, "agent"),
        request,
        run: (client) =>
          startOrResumeThread({
            ...common,
            client,
            signal: AbortSignal.timeout(10_000),
            hostSystemAgentActive: false,
            nativeCodeModeEnabled: true,
          }),
      }),
    ).resolves.toMatchObject({
      threadId: finalThreadId,
      lifecycle: { action: "resumed" },
    });

    expect(request.mock.calls.map(([method]) => method)).toEqual([
      "thread/read",
      "config/read",
      "configRequirements/read",
      "thread/read",
      "thread/resume",
      "thread/inject_items",
    ]);
    const resumeParams = request.mock.calls[4]?.[1] as { config?: Record<string, unknown> };
    expect(resumeParams.config).toMatchObject({
      mcp_servers: { "request-only": { command: "request-mcp" } },
    });
    expect(resumeParams.config).not.toHaveProperty("mcp_servers.inherited");
    const restoredBinding = testCodexAppServerBindingStore.read(identity);
    expect(restoredBinding?.pendingSupervisionBranch).toBeUndefined();
    expect(restoredBinding).not.toHaveProperty("restrictedToolSurface");
  });

  it("cleans tracked threads and preserves the pending binding when the final MCP attestation fails", async () => {
    const attempt = createThreadLifecycleParams();
    attempt.pluginHarnessToolPolicyRestricted = true;
    const identity = await seedPendingSupervisionBinding(attempt);
    let attestationCount = 0;
    const request = vi.fn(async (method: string, _requestParams?: unknown) => {
      if (method === "config/read") {
        return {
          config: { mcp_servers: { inherited: { command: "inherited-mcp" } } },
          layers: [{ name: { type: "user" } }],
        };
      }
      if (method === "configRequirements/read") {
        return { requirements: null };
      }
      if (method === "thread/read") {
        return { thread: sourceThread({ threadId: sourceThreadId }) };
      }
      if (method === "thread/fork") {
        return nativeThreadResult(probeThreadId, "native-effective", "native-provider");
      }
      if (method === "thread/start") {
        return nativeThreadResult(finalThreadId, "native-effective", "native-provider");
      }
      if (method === "mcpServerStatus/list") {
        attestationCount += 1;
        const shouldFail = attestationCount === 2;
        return {
          data: shouldFail
            ? [{ name: "unexpected", serverInfo: null, tools: {} }]
            : [disabledMcpServerStatus("inherited")],
          nextCursor: null,
        };
      }
      if (method === "thread/archive" || method === "thread/unsubscribe") {
        return {};
      }
      throw new Error(`unexpected method: ${method}`);
    });
    const abandonClient = vi.fn(async () => undefined);

    await expect(
      startOrResumeThread({
        client: { request } as never,
        abandonClient,
        ...lifecycleOptions(attempt),
        nativeCodeModeEnabled: false,
        userMcpServersEnabled: false,
      }),
    ).rejects.toThrow("found unexpected server unexpected");

    const methods = request.mock.calls.map(([method]) => method);
    expect(methods).not.toContain("thread/inject_items");
    expect(methods.filter((method) => method === "thread/start")).toHaveLength(1);
    expect(
      request.mock.calls
        .filter(([method]) => method === "thread/archive")
        .map(([, requestParams]) => requestParams),
    ).toEqual([{ threadId: finalThreadId }]);
    expect(abandonClient).not.toHaveBeenCalled();
    expect(testCodexAppServerBindingStore.read(identity)).toMatchObject({
      threadId: sourceThreadId,
      pendingSupervisionBranch: { sourceThreadId },
    });
  });

  it("keeps the supervised branch when a configured plugin app is missing from the effective thread", async () => {
    const attempt = createThreadLifecycleParams();
    const identity = await seedPendingSupervisionBinding(attempt);
    const abandonClient = vi.fn(async () => undefined);
    const request = createLifecycleRequest(async (method: string, requestParams?: unknown) => {
      if (method === "thread/read") {
        return { thread: sourceThread({ threadId: sourceThreadId }) };
      }
      if (method === "thread/fork") {
        return nativeThreadResult(probeThreadId, "native-effective", "native-provider");
      }
      if (method === "thread/start") {
        return nativeThreadResult(finalThreadId, "native-effective", "native-provider");
      }
      if (method === "app/installed") {
        expect(requestParams).toEqual({ threadId: finalThreadId, forceRefresh: false });
        return { apps: [] };
      }
      if (method === "thread/delete" || method === "thread/unsubscribe") {
        return {};
      }
      throw new Error(`unexpected method: ${method}`);
    });

    await expect(
      startOrResumeThread({
        client: { request } as never,
        abandonClient,
        ...lifecycleOptions(attempt),
        pluginThreadConfig: createProvisionalPluginThreadConfigProvider("linear-app"),
      }),
    ).resolves.toMatchObject({ threadId: finalThreadId, lifecycle: { action: "forked" } });

    expect(request.mock.calls.map(([method]) => method)).toEqual([
      "config/read",
      "configRequirements/read",
      "thread/read",
      "thread/fork",
      "thread/unsubscribe",
      "thread/start",
      "app/installed",
    ]);
    expect(request.mock.calls[4]?.[1]).toEqual({ threadId: probeThreadId });
    expect(abandonClient).not.toHaveBeenCalled();
    expect(testCodexAppServerBindingStore.read(identity)).toMatchObject({
      threadId: finalThreadId,
    });
    expect(testCodexAppServerBindingStore.read(identity)?.pendingSupervisionBranch).toBeUndefined();
  });

  it("retires a supervised client when its unattested canonical branch cannot be deleted", async () => {
    const attempt = createThreadLifecycleParams();
    const identity = await seedPendingSupervisionBinding(attempt);
    const abandonClient = vi.fn(async () => undefined);
    const request = createLifecycleRequest(async (method: string) => {
      if (method === "thread/read") {
        return { thread: sourceThread({ threadId: sourceThreadId }) };
      }
      if (method === "thread/fork") {
        return nativeThreadResult(probeThreadId, "native-effective", "native-provider");
      }
      if (method === "thread/start") {
        return nativeThreadResult(finalThreadId, "native-effective", "native-provider");
      }
      if (method === "app/installed") {
        throw new Error("app inventory offline");
      }
      if (method === "thread/delete") {
        throw new Error("delete unavailable");
      }
      if (method === "thread/unsubscribe") {
        return {};
      }
      throw new Error(`unexpected method: ${method}`);
    });

    await expect(
      startOrResumeThread({
        client: { request } as never,
        abandonClient,
        ...lifecycleOptions(attempt),
        pluginThreadConfig: createProvisionalPluginThreadConfigProvider("linear-app"),
      }),
    ).rejects.toThrow("Codex supervised plugin app attestation cleanup failed");

    expect(request.mock.calls.map(([method]) => method)).toEqual([
      "config/read",
      "configRequirements/read",
      "thread/read",
      "thread/fork",
      "thread/unsubscribe",
      "thread/start",
      "app/installed",
      "thread/delete",
      "thread/unsubscribe",
    ]);
    expect(abandonClient).toHaveBeenCalledOnce();
    expect(testCodexAppServerBindingStore.read(identity)).toMatchObject({
      pendingSupervisionBranch: {
        sourceThreadId,
        cleanupThreadIds: [finalThreadId],
      },
    });
  });

  it.each(["recovered", "archive failed", "CAS rejected"] as const)(
    "settles persisted orphan cleanup before branch work: %s",
    async (outcome) => {
      const orphanProbeThreadId = "thread-orphan-probe";
      const orphanFinalThreadId = "thread-orphan-final";
      const cleanupThreadIds = [orphanProbeThreadId, orphanFinalThreadId];
      const lastTurnId = outcome === "recovered" ? "turn-terminal" : undefined;
      const attempt = createThreadLifecycleParams();
      const identity = await seedPendingSupervisionBinding(attempt, {
        sourceThreadId,
        ...(lastTurnId ? { lastTurnId } : {}),
        cleanupThreadIds,
      });
      const connectionFingerprint = buildCodexAppServerConnectionFingerprint(
        createThreadLifecycleAppServerOptions(),
      );
      const mutations: Parameters<CodexAppServerBindingStore["mutate"]>[1][] = [];
      const bindingStore: CodexAppServerBindingStore = {
        ...testCodexAppServerBindingStore,
        mutate: async (storeIdentity, mutation) => {
          mutations.push(mutation);
          if (
            outcome === "CAS rejected" &&
            mutation.kind === "patch-pending-supervision-branch" &&
            mutation.expected.cleanupThreadIds?.length === 2 &&
            !mutation.pending.cleanupThreadIds
          ) {
            return false;
          }
          return await testCodexAppServerBindingStore.mutate(storeIdentity, mutation);
        },
      };
      const request = createLifecycleRequest(async (method: string, requestParams?: unknown) => {
        const threadId = (requestParams as { threadId?: string } | undefined)?.threadId;
        if (method === "thread/archive") {
          if (outcome === "archive failed" && threadId === orphanFinalThreadId) {
            throw new CodexAppServerRpcError(
              { code: -32_000, message: "temporary archive failure" },
              method,
            );
          }
          if (outcome !== "archive failed" || threadId === orphanProbeThreadId) {
            return {};
          }
        }
        if (outcome !== "CAS rejected" && method === "thread/unsubscribe") {
          return {};
        }
        if (outcome === "recovered") {
          if (method === "thread/read") {
            return {
              thread: sourceThread({
                threadId: sourceThreadId,
                turns: [{ id: lastTurnId, status: "completed", items: [] }],
              }),
            };
          }
          if (method === "thread/fork" || method === "thread/start") {
            return nativeThreadResult(
              method === "thread/fork" ? probeThreadId : finalThreadId,
              "native-effective",
              "native-provider",
            );
          }
        }
        throw new Error(`unexpected method: ${method}`);
      });
      const result = startOrResumeThreadImpl({
        client: { request } as never,
        bindingStore,
        ...lifecycleOptions(attempt),
      });
      if (outcome === "recovered") {
        await expect(result).resolves.toMatchObject({
          threadId: finalThreadId,
          lifecycle: { action: "forked" },
        });
      } else {
        await expect(result).rejects.toThrow(
          outcome === "archive failed"
            ? `cleanup must finish before retry: ${orphanFinalThreadId}`
            : "recovering a supervised Codex branch",
        );
        expect(request.mock.calls.some(([method]) => method === "thread/fork")).toBe(false);
        expect(request.mock.calls.some(([method]) => method === "thread/start")).toBe(false);
      }
      expect(request.mock.calls.map(([method]) => method)).toEqual([
        "config/read",
        "configRequirements/read",
        "thread/archive",
        "thread/archive",
        ...(outcome === "recovered"
          ? ["thread/read", "thread/fork", "thread/unsubscribe", "thread/start"]
          : outcome === "archive failed"
            ? ["thread/unsubscribe"]
            : []),
      ]);
      const persisted = testCodexAppServerBindingStore.read(identity);
      if (outcome === "recovered") {
        expect(request.mock.calls.map(([, requestParams]) => requestParams)).toEqual([
          { cwd: path.resolve(workspaceDir), includeLayers: true },
          undefined,
          { threadId: orphanProbeThreadId },
          { threadId: orphanFinalThreadId },
          { threadId: sourceThreadId, includeTurns: true },
          expect.any(Object),
          { threadId: probeThreadId },
          expect.any(Object),
        ]);
        expect(mutations[0]).toEqual({
          kind: "patch-pending-supervision-branch",
          expected: { sourceThreadId, connectionFingerprint, lastTurnId, cleanupThreadIds },
          pending: { sourceThreadId, connectionFingerprint, lastTurnId },
        });
        expect(persisted).toMatchObject({ threadId: finalThreadId });
        expect(persisted?.pendingSupervisionBranch).toBeUndefined();
      } else {
        expect(persisted).toMatchObject({
          threadId: sourceThreadId,
          pendingSupervisionBranch: {
            sourceThreadId,
            cleanupThreadIds:
              outcome === "archive failed" ? [orphanFinalThreadId] : cleanupThreadIds,
          },
        });
      }
    },
  );

  it.each([
    {
      name: "connection",
      command: "different-codex",
      failure: "source connection changed before branch materialization",
    },
    {
      name: "active source",
      thread: sourceThread({ threadId: sourceThreadId, status: "active" }),
      failure: "source changed after Continue",
    },
    {
      name: "source with uncaptured turns",
      thread: sourceThread({
        threadId: sourceThreadId,
        turns: [{ id: "turn-late", status: "completed", items: [] }],
      }),
      failure: "source changed after Continue",
    },
  ])("fails closed when the supervised $name changed", async ({ command, thread, failure }) => {
    const attempt = createThreadLifecycleParams();
    await seedPendingSupervisionBinding(attempt);
    const request = createLifecycleRequest(async (method: string) => {
      if (method === "thread/read" && thread) {
        return { thread };
      }
      throw new Error(`unexpected method: ${method}`);
    });
    const appServer = createThreadLifecycleAppServerOptions();
    if (command) {
      appServer.start.command = command;
    }
    await expect(
      startOrResumeThread({
        ...lifecycleOptions(attempt),
        client: { request } as never,
        appServer,
      }),
    ).rejects.toThrow(failure);
    expect(request.mock.calls.map(([method]) => method)).toEqual([
      "config/read",
      "configRequirements/read",
      ...(command ? [] : ["thread/read"]),
    ]);
  });

  it("keeps a structured fork rejection retryable without touching the source", async () => {
    const attempt = createThreadLifecycleParams();
    const identity = await seedPendingSupervisionBinding(attempt);
    let forkAttempts = 0;
    const request = createLifecycleRequest(async (method: string) => {
      if (method === "thread/read") {
        return { thread: sourceThread({ threadId: sourceThreadId }) };
      }
      if (method === "thread/fork") {
        forkAttempts += 1;
        if (forkAttempts === 1) {
          throw new CodexAppServerRpcError(
            { code: -32_000, message: "temporary fork rejected" },
            method,
          );
        }
        return nativeThreadResult("thread-probe", "native-effective", "native-provider");
      }
      if (method === "thread/start") {
        return nativeThreadResult("thread-final", "native-effective", "native-provider");
      }
      if (method === "thread/archive" || method === "thread/unsubscribe") {
        return {};
      }
      throw new Error(`unexpected method: ${method}`);
    });
    const commonParams = {
      client: { request } as never,
      ...lifecycleOptions(attempt),
    };

    await expect(startOrResumeThread(commonParams)).rejects.toThrow("temporary fork rejected");
    expect(request.mock.calls.map(([method]) => method)).toEqual([
      "config/read",
      "configRequirements/read",
      "thread/read",
      "thread/fork",
    ]);
    expect(testCodexAppServerBindingStore.read(identity)).toMatchObject({
      threadId: sourceThreadId,
      pendingSupervisionBranch: { sourceThreadId },
    });

    request.mockClear();
    await expect(startOrResumeThread(commonParams)).resolves.toMatchObject({
      threadId: "thread-final",
      lifecycle: { action: "forked" },
    });
    expect(request.mock.calls.map(([method]) => method)).toEqual([
      "config/read",
      "configRequirements/read",
      "thread/read",
      "thread/fork",
      "thread/unsubscribe",
      "thread/start",
    ]);
  });

  it.each(["abort", "tracking CAS"] as const)(
    "archives the canonical thread after %s failure",
    async (failure) => {
      const lastTurnId = failure === "abort" ? "turn-terminal" : undefined;
      const attempt = createThreadLifecycleParams();
      const identity = await seedPendingSupervisionBinding(attempt, {
        sourceThreadId,
        ...(lastTurnId ? { lastTurnId } : {}),
      });
      const abortController = new AbortController();
      const request = createLifecycleRequest(async (method: string) => {
        if (method === "thread/read") {
          return {
            thread: sourceThread({
              threadId: sourceThreadId,
              ...(lastTurnId
                ? { turns: [{ id: lastTurnId, status: "completed", items: [] }] }
                : {}),
            }),
          };
        }
        if (method === "thread/fork") {
          return nativeThreadResult(probeThreadId, "native-effective", "native-provider");
        }
        if (method === "thread/start") {
          if (failure === "abort") {
            abortController.abort("cancelled after canonical start");
          }
          return nativeThreadResult(finalThreadId, "native-effective", "native-provider");
        }
        if (method === "thread/archive" || method === "thread/unsubscribe") {
          return {};
        }
        throw new Error(`unexpected method: ${method}`);
      });
      const bindingStore: CodexAppServerBindingStore = {
        ...testCodexAppServerBindingStore,
        mutate: async (storeIdentity, mutation) => {
          if (
            failure === "tracking CAS" &&
            mutation.kind === "patch-pending-supervision-branch" &&
            mutation.pending.cleanupThreadIds?.join(",") === finalThreadId
          ) {
            return false;
          }
          return await testCodexAppServerBindingStore.mutate(storeIdentity, mutation);
        },
      };
      const abandonClient = vi.fn(async () => undefined);
      await expect(
        startOrResumeThreadImpl({
          client: { request } as never,
          abandonClient,
          bindingStore,
          ...lifecycleOptions(attempt),
          ...(failure === "abort" ? { signal: abortController.signal } : {}),
        }),
      ).rejects.toThrow(
        failure === "abort"
          ? "cancelled after canonical start"
          : "tracking supervised Codex branch cleanup",
      );
      const archivedThreadIds = request.mock.calls
        .filter(([method]) => method === "thread/archive")
        .map(([, requestParams]) => (requestParams as { threadId: string }).threadId);
      expect(archivedThreadIds).toEqual([finalThreadId]);
      if (failure === "abort") {
        expect(request.mock.calls.map(([method]) => method)).toEqual([
          "config/read",
          "configRequirements/read",
          "thread/read",
          "thread/fork",
          "thread/unsubscribe",
          "thread/start",
          "thread/archive",
        ]);
        expect(request.mock.calls[4]?.[1]).toEqual({ threadId: probeThreadId });
        expect(request.mock.calls[6]?.[1]).toEqual({ threadId: finalThreadId });
      } else {
        expect(abandonClient).not.toHaveBeenCalled();
      }
      const persisted = testCodexAppServerBindingStore.read(identity);
      expect(persisted).toMatchObject({
        threadId: sourceThreadId,
        pendingSupervisionBranch: { sourceThreadId, ...(lastTurnId ? { lastTurnId } : {}) },
      });
      if (failure === "abort") {
        expect(persisted?.pendingSupervisionBranch?.cleanupThreadIds).toBeUndefined();
      }
    },
  );

  it.each([
    { failure: "before write", archive: "confirmed" },
    { failure: "after write", archive: "rejected" },
  ])(
    "cleans canonical tracking failure $failure (archive: $archive) before retry",
    async ({ failure, archive }) => {
      const archiveFails = archive !== "confirmed";
      const attempt = createThreadLifecycleParams();
      const identity = await seedPendingSupervisionBinding(attempt);
      const initial = testCodexAppServerBindingStore.read(identity);
      const storageError = new Error("tracking storage failure");
      let failed = false;
      let retry = false;
      const unarchivedId = finalThreadId;
      const nativeThreads = new Set([sourceThreadId]);
      const request = createLifecycleRequest(async (method: string, requestParams?: unknown) => {
        if (method === "thread/read") {
          return { thread: sourceThread({ threadId: sourceThreadId }) };
        }
        if (method === "thread/fork" || method === "thread/start") {
          const threadId = `${method === "thread/fork" ? probeThreadId : finalThreadId}${retry ? "-retry" : ""}`;
          nativeThreads.add(threadId);
          return nativeThreadResult(threadId, "native-effective", "native-provider");
        }
        if (method === "thread/archive") {
          const threadId = (requestParams as { threadId: string }).threadId;
          if (!retry && threadId === unarchivedId && archive === "rejected") {
            throw new Error("archive rejected");
          }
          nativeThreads.delete(threadId);
          return {};
        }
        if (method === "thread/unsubscribe") {
          const threadId = (requestParams as { threadId: string }).threadId;
          if (threadId === `${probeThreadId}${retry ? "-retry" : ""}`) {
            nativeThreads.delete(threadId);
          }
          return {};
        }
        throw new Error(`unexpected method: ${method}`);
      });
      const targetIds = [finalThreadId];
      const bindingStore: CodexAppServerBindingStore = {
        ...testCodexAppServerBindingStore,
        mutate: async (storeIdentity, mutation) => {
          if (
            !failed &&
            mutation.kind === "patch-pending-supervision-branch" &&
            mutation.pending.cleanupThreadIds?.join(",") === targetIds.join(",")
          ) {
            failed = true;
            if (failure === "after write") {
              await testCodexAppServerBindingStore.mutate(storeIdentity, mutation);
            }
            throw storageError;
          }
          return await testCodexAppServerBindingStore.mutate(storeIdentity, mutation);
        },
      };
      const abandonClient = vi.fn(async () => undefined);
      const common = {
        client: { request } as never,
        abandonClient,
        bindingStore,
        ...lifecycleOptions(attempt),
      };
      const error = await startOrResumeThreadImpl(common).catch(
        (caughtError: unknown) => caughtError,
      );
      expect(failed).toBe(true);
      expect(
        request.mock.calls
          .filter(([method]) => method === "thread/archive")
          .map(([, params]) => params),
      ).toEqual(
        [finalThreadId].map((threadId) => ({
          threadId,
        })),
      );
      if (archiveFails) {
        expect(error).toMatchObject({
          name: "CodexAppServerUnsafeSubscriptionError",
          cause: storageError,
        });
        expect(abandonClient).toHaveBeenCalledOnce();
      } else {
        expect(error).toBe(storageError);
        expect(abandonClient).not.toHaveBeenCalled();
      }
      expect([...nativeThreads]).toEqual(
        archive === "rejected" ? [sourceThreadId, unarchivedId] : [sourceThreadId],
      );
      expect(testCodexAppServerBindingStore.read(identity)).toEqual({
        ...initial,
        pendingSupervisionBranch: {
          ...initial!.pendingSupervisionBranch,
          ...(archiveFails ? { cleanupThreadIds: [unarchivedId] } : {}),
        },
      });

      retry = true;
      request.mockClear();
      await expect(startOrResumeThreadImpl(common)).resolves.toMatchObject({
        threadId: `${finalThreadId}-retry`,
        lifecycle: { action: "forked" },
      });
      expect([...nativeThreads]).toEqual([sourceThreadId, `${finalThreadId}-retry`]);
      const persisted = testCodexAppServerBindingStore.read(identity);
      expect(persisted?.threadId).toBe(`${finalThreadId}-retry`);
      expect(persisted?.pendingSupervisionBranch).toBeUndefined();
      if (archiveFails) {
        expect(request.mock.calls.find(([method]) => method === "thread/archive")).toEqual([
          "thread/archive",
          { threadId: unarchivedId },
          expect.any(Object),
        ]);
      }
    },
  );

  it.each(["unreadable", "pending successor", "materialized successor", "other generation"])(
    "abandons the exact client when failed tracking finds an %s binding",
    async (owner) => {
      const attempt = createThreadLifecycleParams();
      const identity = await seedPendingSupervisionBinding(attempt);
      const storageError = new Error("tracking storage failure");
      const readError = new Error("tracking verification unavailable");
      let failed = false;
      let preserved: Awaited<ReturnType<CodexAppServerBindingStore["read"]>>;
      const request = createLifecycleRequest(async (method: string) => {
        if (method === "thread/read") {
          return { thread: sourceThread({ threadId: sourceThreadId }) };
        }
        if (method === "thread/fork" || method === "thread/start") {
          return nativeThreadResult(
            method === "thread/fork" ? probeThreadId : finalThreadId,
            "native-effective",
            "native-provider",
          );
        }
        if (method === "thread/unsubscribe") {
          return {};
        }
        throw new Error(`unexpected method: ${method}`);
      });
      const bindingStore: CodexAppServerBindingStore = {
        ...testCodexAppServerBindingStore,
        read: (storeIdentity) => {
          if (failed && owner === "unreadable") {
            throw readError;
          }
          return testCodexAppServerBindingStore.read(storeIdentity);
        },
        mutate: async (storeIdentity, mutation) => {
          if (
            !failed &&
            mutation.kind === "patch-pending-supervision-branch" &&
            mutation.pending.cleanupThreadIds?.includes(finalThreadId)
          ) {
            failed = true;
            if (owner === "pending successor") {
              await testCodexAppServerBindingStore.mutate(storeIdentity, {
                ...mutation,
                pending: { ...mutation.expected, lastTurnId: "turn-successor" },
              });
            } else if (owner === "materialized successor") {
              await testCodexAppServerBindingStore.mutate(storeIdentity, {
                kind: "commit-pending-supervision-branch",
                expected: mutation.expected,
                threadId: finalThreadId,
                patch: { model: "native-effective", modelProvider: "native-provider" },
              });
            } else if (owner === "other generation") {
              await testCodexAppServerBindingStore.adoptSessionGeneration(
                { ...identity, sessionId: "successor" },
                identity.sessionId,
              );
            }
            preserved = testCodexAppServerBindingStore.read(
              owner === "other generation" ? { ...identity, sessionId: "successor" } : identity,
            );
            throw storageError;
          }
          return await testCodexAppServerBindingStore.mutate(storeIdentity, mutation);
        },
      };
      const abandonClient = vi.fn(async () => undefined);
      const error = await startOrResumeThreadImpl({
        client: { request } as never,
        abandonClient,
        bindingStore,
        ...lifecycleOptions(attempt),
      }).catch((caughtError: unknown) => caughtError);
      expect(error).toMatchObject({
        name: "CodexAppServerUnsafeSubscriptionError",
        cause: { cause: storageError, errors: expect.arrayContaining([storageError]) },
      });
      expect(abandonClient).toHaveBeenCalledOnce();
      expect(request.mock.calls.map(([method]) => method)).toEqual([
        "config/read",
        "configRequirements/read",
        "thread/read",
        "thread/fork",
        "thread/unsubscribe",
        "thread/start",
      ]);
      expect(
        testCodexAppServerBindingStore.read(
          owner === "other generation" ? { ...identity, sessionId: "successor" } : identity,
        ),
      ).toEqual(preserved);
    },
  );

  it("does not clean the committed canonical thread when post-commit diagnostics fail", async () => {
    const attempt = createThreadLifecycleParams();
    const identity = await seedPendingSupervisionBinding(attempt);
    const request = createSupervisedCommitRequest();
    const abandonClient = vi.fn(async () => undefined);

    await expect(
      startOrResumeThread({
        client: { request } as never,
        abandonClient,
        ...lifecycleOptions(attempt),
        timing: {
          enabled: true,
          now: () => 0,
          log: {
            isEnabled: () => true,
            trace: () => {
              throw new Error("timing log failed");
            },
            warn: vi.fn(),
          },
        },
      }),
    ).rejects.toThrow("timing log failed");
    expect(
      request.mock.calls
        .filter(([method]) => method === "thread/unsubscribe" || method === "thread/archive")
        .map(([, requestParams]) => requestParams),
    ).toEqual([{ threadId: probeThreadId }]);
    expect(abandonClient).not.toHaveBeenCalled();
    const committedBinding = testCodexAppServerBindingStore.read(identity);
    expect(committedBinding).toMatchObject({ threadId: finalThreadId });
    expect(committedBinding).not.toHaveProperty("pendingSupervisionBranch");
  });

  it.each([
    { applied: true, verification: "same", error: undefined },
    { applied: true, verification: "changed", error: "binding changed while commit was uncertain" },
    { applied: false, verification: "unreadable", error: "binding could not be verified" },
  ])(
    "reconciles failed canonical commit (applied=$applied, verification=$verification)",
    async ({ applied, verification, error }) => {
      const attempt = createThreadLifecycleParams();
      const identity = await seedPendingSupervisionBinding(attempt);
      const request = createSupervisedCommitRequest();
      let commitFailed = false;
      const bindingStore: CodexAppServerBindingStore = {
        ...testCodexAppServerBindingStore,
        read: vi.fn((storeIdentity) => {
          const current = testCodexAppServerBindingStore.read(storeIdentity);
          if (!commitFailed) {
            return current;
          }
          if (verification === "unreadable") {
            throw new Error("binding verification read failed");
          }
          if (verification !== "changed" || !current) {
            return current;
          }
          return current.pendingSupervisionBranch
            ? {
                ...current,
                pendingSupervisionBranch: {
                  ...current.pendingSupervisionBranch,
                  connectionFingerprint: "changed-connection",
                },
              }
            : { ...current, appServerRuntimeFingerprint: "changed-connection" };
        }),
        mutate: vi.fn(async (storeIdentity, mutation) => {
          if (mutation.kind === "commit-pending-supervision-branch") {
            if (applied) {
              await testCodexAppServerBindingStore.mutate(storeIdentity, mutation);
            }
            commitFailed = true;
            throw new Error("binding commit failed");
          }
          return await testCodexAppServerBindingStore.mutate(storeIdentity, mutation);
        }),
      };
      const abandonClient = vi.fn(async () => undefined);
      const outcome = startOrResumeThreadImpl({
        ...lifecycleOptions(attempt),
        client: { request } as never,
        abandonClient,
        bindingStore,
      });
      if (error) {
        await expect(outcome).rejects.toThrow(`${error}: ${finalThreadId}`);
      } else {
        await expect(outcome).resolves.toMatchObject({
          threadId: finalThreadId,
          lifecycle: { action: "forked" },
        });
      }
      expect(
        request.mock.calls
          .filter(([method]) => method === "thread/unsubscribe" || method === "thread/archive")
          .map(([, requestParams]) => requestParams),
      ).toEqual([{ threadId: probeThreadId }]);
      expect(abandonClient).toHaveBeenCalledTimes(error ? 1 : 0);
      const persisted = testCodexAppServerBindingStore.read(identity);
      if (applied) {
        expect(persisted).toMatchObject({ threadId: finalThreadId });
        expect(persisted).not.toHaveProperty("pendingSupervisionBranch");
      } else {
        expect(persisted).toMatchObject({
          threadId: sourceThreadId,
          pendingSupervisionBranch: { sourceThreadId, cleanupThreadIds: [finalThreadId] },
        });
      }
    },
  );

  it.each(["", probeThreadId])(
    "abandons an unsafe canonical branch id %s without touching the source",
    async (returnedId) => {
      const attempt = createThreadLifecycleParams();
      const identity = await seedPendingSupervisionBinding(attempt);
      const request = createLifecycleRequest(async (method: string) => {
        if (method === "thread/read") {
          return { thread: sourceThread({ threadId: sourceThreadId }) };
        }
        if (method === "thread/fork") {
          return nativeThreadResult(probeThreadId, "native-effective", "native-provider");
        }
        if (method === "thread/start") {
          return { thread: { id: returnedId } };
        }
        if (method === "thread/archive" || method === "thread/unsubscribe") {
          return {};
        }
        throw new Error(`unexpected method: ${method}`);
      });
      const abandonClient = vi.fn(async () => undefined);
      await expect(
        startOrResumeThread({
          client: { request } as never,
          abandonClient,
          ...lifecycleOptions(attempt),
        }),
      ).rejects.toThrow(
        returnedId
          ? "canonical branch reused an existing thread"
          : "canonical branch may have materialized without a safe thread id",
      );
      expect(request.mock.calls.map(([method]) => method)).toEqual([
        "config/read",
        "configRequirements/read",
        "thread/read",
        "thread/fork",
        "thread/unsubscribe",
        "thread/start",
      ]);
      expect(abandonClient).toHaveBeenCalledOnce();
      expect(request.mock.calls[4]?.[1]).toEqual({ threadId: probeThreadId });
      expect(request.mock.invocationCallOrder[4]).toBeLessThan(
        abandonClient.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
      );
      const persisted = testCodexAppServerBindingStore.read(identity);
      expect(persisted).toMatchObject({
        threadId: sourceThreadId,
        pendingSupervisionBranch: { sourceThreadId },
      });
      expect(persisted?.pendingSupervisionBranch?.cleanupThreadIds).toBeUndefined();
    },
  );
});

describe("Codex app-server thread lifecycle timing", () => {
  installLifecycleHooks();

  it.each([
    { action: "resumed", duration: 9, trace: true },
    { action: "started", duration: 10_000, trace: false },
  ])("reports a $action request with trace=$trace", async ({ action, duration, trace }) => {
    let nowMs = 0;
    const log = createTimingLogger(trace);
    const threadId = trace ? "thread-existing" : "thread-slow";
    const respond = createLifecycleRequest(async (method: string) => {
      if (method === "thread/start" || (trace && method === "thread/resume")) {
        if (method === (trace ? "thread/resume" : "thread/start")) {
          nowMs += duration;
        }
        return threadStartResult(threadId);
      }
      throw new Error(`unexpected method: ${method}`);
    });
    const fixture = trace
      ? await createLeasedCodexLifecycleHarness({
          agentDir: path.join(tempDir, "agent"),
          respond,
        })
      : undefined;
    const common = {
      client: fixture?.client ?? ({ request: respond } as never),
      ...lifecycleOptions(createThreadLifecycleParams()),
      ...(trace ? { signal: new AbortController().signal } : {}),
    };
    if (fixture) {
      await startOrResumeThread({
        ...common,
        timing: { enabled: true, now: () => nowMs, log: createTimingLogger(false) },
      });
      await fixture.endTurn(threadId);
    }
    await startOrResumeThread({
      ...common,
      timing: {
        enabled: trace,
        now: () => nowMs,
        log,
      },
    });
    const message = expectSingleLogMessage(log, trace ? "trace" : "warn");
    if (!trace) {
      expect(log.trace).not.toHaveBeenCalled();
    }
    expect(message).toContain(`action=${action}`);
    expect(message).toContain(
      `thread-${trace ? "resume" : "start"}-request:${duration}ms@${duration}ms`,
    );
  });
});

describe("resolveCodexAppServerReasoningEffort (#71946)", () => {
  it.each([
    {
      thinkLevel: "high",
      modelId: "catalog-model",
      supportedReasoningEfforts: ["none"],
      expected: null,
    },
    { thinkLevel: "minimal", modelId: "gpt-5.5", expected: "low" },
    { thinkLevel: "low", modelId: "gpt-5.5-pro", expected: "medium" },
    { thinkLevel: "max", modelId: "gpt-5.6-sol", expected: null },
    ...(["off", "adaptive"] as const).map((thinkLevel) => ({
      thinkLevel,
      modelId: "catalog-model",
      supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
      expected: null,
    })),
  ] as const)("maps $thinkLevel for $modelId with efforts $supportedReasoningEfforts", (params) => {
    expect(resolveCodexAppServerReasoningEffort(params)).toBe(params.expected);
  });
});

describe("native Codex Ultra turn mapping", () => {
  it("preserves resolved ultra for gpt-5.6-sol with direct OpenAI API metadata", () => {
    const modelId = "gpt-5.6-sol";
    const params = createAttemptParams({
      provider: "openai",
      modelId,
      authProfileId: "openai:api-key",
      authProfileType: "api_key",
    });
    params.thinkLevel = "ultra";
    const compat: ModelCompatConfig = {
      supportedReasoningEfforts: ["none", "low", "medium", "high", "xhigh", "max"],
    };
    params.model = {
      ...createCodexTestModel("openai"),
      id: modelId,
      compat,
    };

    const request = buildTurnStartParams(params, {
      threadId: "thread-ultra",
      cwd: "/repo",
      appServer: createAppServerOptions() as never,
    });

    expect(request.effort).toBe("ultra");
    expect(request.collaborationMode?.settings.reasoning_effort).toBe("ultra");
    expect(request).not.toHaveProperty("multiAgentMode");
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
