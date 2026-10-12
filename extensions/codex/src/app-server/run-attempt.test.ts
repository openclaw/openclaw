import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createOpenClawCodingTools } from "openclaw/plugin-sdk/agent-harness";
import {
  embeddedAgentLog,
  invokeNativeHookRelay,
  nativeHookRelayTesting,
  resolveActiveEmbeddedRunSessionId,
  type EmbeddedRunAttemptParamsV2 as EmbeddedRunAttemptParams,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  replaceRuntimeAuthProfileStoreSnapshots,
  saveAuthProfileStore,
} from "openclaw/plugin-sdk/agent-runtime";
import { openFileBackedSessionManagerForTest } from "openclaw/plugin-sdk/agent-runtime-test-contracts";
import { SessionManager } from "openclaw/plugin-sdk/agent-sessions";
import {
  onInternalDiagnosticEvent,
  waitForDiagnosticEventsDrained,
  type DiagnosticEventPayload,
} from "openclaw/plugin-sdk/diagnostic-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { initializeGlobalHookRunner, registerInternalHook } from "openclaw/plugin-sdk/hook-runtime";
import type { AssistantMessage } from "openclaw/plugin-sdk/llm";
import { registerMemoryCapability } from "openclaw/plugin-sdk/memory-core-host-runtime-core";
import { MESSAGE_TOOL_DELIVERY_HINTS } from "openclaw/plugin-sdk/message-tool-delivery-hints";
import { createMockPluginRegistry } from "openclaw/plugin-sdk/plugin-test-runtime";
import { upsertSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { awaitGateBeforeSettlement } from "openclaw/plugin-sdk/test-fixtures";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { defaultCodexAppInventoryCache } from "./app-inventory-cache.js";
import { codexAppInventoryResponse } from "./app-inventory.test-helpers.js";
import {
  buildCodexOpenClawPromptContext,
  buildCodexSystemPromptReport,
  prependCodexOpenClawPromptContext,
} from "./attempt-context.js";
import * as attemptStartup from "./attempt-startup.js";
import { readAttemptTerminal } from "./attempt-terminal.test-helper.js";
import { TURN_FINALIZE_DRAIN_ABORT_GRACE_MS } from "./attempt-timeouts.js";
import { buildCodexWorkspaceBootstrapContext } from "./attempt-workspace-context.js";
import { prepareCodexAppServerAuthBinding } from "./auth-binding.js";
import { resolveCodexAppServerFallbackApiKeyCacheKey } from "./auth-cache-key.js";
import { releaseCodexAppServerLiveThread } from "./client-runtime.js";
import { CodexAppServerRpcError, CodexAppServerClient } from "./client.js";
import {
  readCodexPluginConfig,
  resolveCodexAppServerRuntimeOptions,
  resolveCodexSupervisionAppServerRuntimeOptions,
} from "./config.js";
import { joinPresentSections } from "./developer-instruction-sections.js";
import {
  buildDynamicTools,
  shouldEnableCodexAppServerNativeToolSurface,
} from "./dynamic-tool-build.js";
import { createCodexDynamicToolBridge } from "./dynamic-tools.js";
import * as elicitationBridge from "./elicitation-bridge.js";
import { CodexAppServerEventProjector } from "./event-projector.js";
import { setCodexTestToolFactory } from "./host-capability.test-support.js";
import { buildCodexRuntimeModelParams } from "./model-runtime.js";
import { nativeHookRelayUnregisterQueue } from "./native-hook-relay-state.js";
import {
  buildCodexAppServerConnectionFingerprint,
  buildCodexPluginAppCacheKey,
} from "./plugin-app-cache-key.js";
import { codexApprovalTimeoutText } from "./plugin-approval-roundtrip.js";
import { buildCodexPluginThreadConfig } from "./plugin-thread-config.js";
import {
  flattenCodexDynamicToolFunctions,
  isJsonObject,
  type CodexDynamicToolFunctionSpec,
  type CodexDynamicToolSpec,
  type JsonObject,
  type v2,
} from "./protocol.js";
import { itemNotification, rawItemCompleted, turnCompleted } from "./protocol.test-helpers.js";
import { readCodexRateLimitsRevision, rememberCodexRateLimitsRead } from "./rate-limit-cache.js";
import { registerCodexFastModeTests } from "./run-attempt-fast-mode.test-support.js";
import {
  expectRetainedSuccessfulThread,
  observeAttemptProjectionReady,
  startClockControlledAttempt,
} from "./run-attempt-lifecycle.test-support.js";
import { registerCodexMemoryInstructionTests } from "./run-attempt-memory.test-support.js";
import * as runAttemptResources from "./run-attempt-resources.js";
import {
  assistantMessage,
  createAppServerHarness,
  createCodexRuntimePlanFixture,
  createParams,
  createResumeHarness,
  createRuntimeDynamicTool,
  createStartedThreadHarness,
  createTestParams,
  extractRelayIdFromThreadRequest,
  fastWait,
  getMockRuntimeIdentity,
  mockCall,
  mockClientRuntimeMethods,
  queueActiveRunMessageForTest,
  rateLimitsUpdated,
  runCodexAppServerAttempt,
  setCodexTestModelSupportsTools,
  setCodexAppServerClientFactoryForTest,
  setupRunAttemptTestHooks,
  tempDir,
  threadStartResult,
  turnStartResult,
  userMessage,
} from "./run-attempt-test-harness.js";
import { resolveCodexDynamicToolDirectNames } from "./run-attempt-tools.js";
import * as attemptTurnState from "./run-attempt-turn-state.js";
import { setAgentWorkspaceForTest } from "./run-attempt-workspace.test-support.js";
import { registerSettledFinalizationTests } from "./run-attempt.settled-finalization.test-support.js";
import {
  ensureCodexSandboxExecServerEnvironment,
  releaseCodexSandboxExecServerEnvironment,
} from "./sandbox-exec-server.js";
import { createSandboxContext } from "./sandbox-exec-server.test-helpers.js";
import {
  createCodexTestBindingStore,
  resetCodexTestBindingStore,
  type CodexAppServerBindingIdentity,
  readCodexAppServerBinding,
  writeCodexAppServerBinding,
} from "./session-binding.test-helpers.js";
import * as sharedClientModule from "./shared-client.js";
import type { CodexAppServerClientOptions } from "./shared-client.js";
import {
  appendSqliteHistoryMessage,
  attachSqliteSessionTarget,
  readTranscriptMessagesByIdentity,
} from "./sqlite-session.test-helpers.js";
import {
  createCodexTestModel,
  createCodexTestOAuthProfile,
  withoutCodexSkillDiscovery,
} from "./test-support.js";
import { codexDynamicToolsFingerprint } from "./thread-fingerprints.js";
import {
  startOrResumeAttemptThreadWithoutSkills as startOrResumeThread,
  createAppServerOptions as createBaseAppServerOptions,
  createCodexLifecycleHarness,
  createLeasedCodexLifecycleHarness,
} from "./thread-lifecycle.test-fixtures.js";
import { buildDeveloperInstructions } from "./thread-prompt.js";
import { buildThreadStartParams } from "./thread-requests.js";
import { buildTurnStartParams } from "./turn-params.js";
import { readMirrorIdentity } from "./upstream-prompt-provenance.js";
import * as userInputBridge from "./user-input-bridge.js";

function expectResumeRequest(
  requests: Array<{ method: string; params: unknown }>,
  params: Record<string, unknown>,
) {
  const request = requests.find((entry) => entry.method === "thread/resume");
  if (!request) {
    throw new Error("Expected thread/resume request");
  }
  const requestParams = request.params as Record<string, unknown> | undefined;
  for (const [key, value] of Object.entries(params)) {
    expect(requestParams?.[key]).toEqual(value);
  }
}

const DISABLED_CODEX_WEB_SEARCH_THREAD_CONFIG_FINGERPRINT = JSON.stringify({
  "features.standalone_web_search": false,
  web_search: "disabled",
});

async function writeExistingBinding(
  sessionFile: string,
  workspaceDir: string,
  overrides: Partial<Parameters<typeof writeCodexAppServerBinding>[1]> = {},
) {
  const supervisionFingerprint =
    overrides.connectionScope === "supervision" && !overrides.appServerRuntimeFingerprint
      ? buildCodexAppServerConnectionFingerprint(
          resolveCodexSupervisionAppServerRuntimeOptions({
            pluginConfig: { supervision: { enabled: true } },
          }),
        )
      : undefined;
  await writeCodexAppServerBinding(sessionFile, {
    threadId: "thread-existing",
    cwd: workspaceDir,
    model: "gpt-5.4-codex",
    modelProvider: "openai",
    historyCoveredThrough: new Date().toISOString(),
    webSearchThreadConfigFingerprint: DISABLED_CODEX_WEB_SEARCH_THREAD_CONFIG_FINGERPRINT,
    ...(supervisionFingerprint ? { appServerRuntimeFingerprint: supervisionFingerprint } : {}),
    ...overrides,
  });
}

function createThreadLifecycleAppServerOptions(): Parameters<
  typeof startOrResumeThread
>[0]["appServer"] {
  return {
    ...createBaseAppServerOptions(),
    connectionClass: "local-loopback",
  };
}

async function buildDynamicToolsForTest(
  params: EmbeddedRunAttemptParams,
  workspaceDir: string,
  options: Partial<
    Pick<
      Parameters<typeof buildDynamicTools>[0],
      "forceHeartbeatTool" | "ignoreDisableMessageTool" | "ignoreRuntimePlan"
    >
  > = {},
) {
  const sandboxSessionKey = params.sessionKey;
  if (!sandboxSessionKey) {
    throw new Error("createParams must provide a sessionKey for Codex dynamic tool tests.");
  }
  return buildDynamicTools({
    params,
    resolvedWorkspace: workspaceDir,
    effectiveWorkspace: workspaceDir,
    effectiveCwd: params.cwd ?? workspaceDir,
    sandboxSessionKey,
    sandbox: { enabled: false, backendId: "docker" } as never,
    nativeToolSurfaceEnabled: true,
    runAbortController: new AbortController(),
    sessionAgentId: "main",
    policyAgentId: params.sandboxAgentId ?? "main",
    pluginConfig: {},
    onYieldDetected: () => undefined,
    ...options,
  });
}

async function buildCodexTurnContextForTest(
  params: EmbeddedRunAttemptParams,
  workspaceDir: string,
) {
  const sessionAgentId = "main";
  const agentTools = await buildDynamicToolsForTest(params, workspaceDir);
  const toolBridge = createCodexDynamicToolBridge({
    tools: agentTools,
    signal: new AbortController().signal,
  });
  const dynamicTools = toolBridge.availableSpecs;
  const workspaceBootstrapContext = await buildCodexWorkspaceBootstrapContext({
    params,
    resolvedWorkspace: workspaceDir,
    effectiveWorkspace: workspaceDir,
    sessionKey: params.sessionKey ?? params.sessionId,
    sessionAgentId,
    tools: toolBridge.availableSpecs,
    ringZeroActive: false,
  });
  const threadDeveloperInstructions = (
    await buildThreadStartParams(params, {
      cwd: workspaceDir,
      dynamicTools,
      appServer: resolveCodexAppServerRuntimeOptions({}),
      developerInstructions: buildDeveloperInstructions(params, { dynamicTools }),
      refreshableInstructions: [
        workspaceBootstrapContext.personaInstructions,
        workspaceBootstrapContext.memoryInstructions,
      ]
        .filter(Boolean)
        .join("\n\n"),
    })
  ).developerInstructions;
  assert(typeof threadDeveloperInstructions === "string");
  const openClawPromptContext = buildCodexOpenClawPromptContext({
    params,
    workspacePromptContext: workspaceBootstrapContext.promptContext,
  });
  const codexTurnPromptText = prependCodexOpenClawPromptContext(
    params.prompt,
    openClawPromptContext,
  );
  const turnStartParams = await buildTurnStartParams(params, {
    threadId: "thread-1",
    cwd: workspaceDir,
    appServer: resolveCodexAppServerRuntimeOptions({}),
    promptText: codexTurnPromptText,
  });
  const collaborationInstructions =
    turnStartParams.collaborationMode?.settings?.developer_instructions ?? "";
  const inputText = turnStartParams.input?.find((item) => item.type === "text")?.text ?? "";
  const systemPromptReport = buildCodexSystemPromptReport({
    attempt: params,
    sessionKey: params.sessionKey ?? params.sessionId,
    workspaceDir,
    developerInstructions: joinPresentSections(
      threadDeveloperInstructions,
      collaborationInstructions,
    ),
    workspaceBootstrapContext,
    skillsPrompt: "",
    tools: dynamicTools,
  });
  return {
    collaborationInstructions,
    inputText,
    systemPromptReport,
    threadDeveloperInstructions,
  };
}

function createCodexToolBridgeForTest(
  params: EmbeddedRunAttemptParams,
  tools: RuntimeDynamicToolForTest[],
  registeredTools: RuntimeDynamicToolForTest[] = tools,
  hostSystemAgentActive = false,
) {
  const signal = new AbortController().signal;
  return createCodexDynamicToolBridge({
    tools,
    registeredTools,
    signal,
    directToolNames: resolveCodexDynamicToolDirectNames(
      params,
      registeredTools,
      hostSystemAgentActive,
    ),
  });
}

async function startThreadWithDisabledNativeSurfaceForTest(
  params: EmbeddedRunAttemptParams,
  options: {
    pluginConfig?: Record<string, unknown>;
    developerInstructions?: string;
  } = {},
) {
  const workspaceDir = params.workspaceDir;
  if (!workspaceDir) {
    throw new Error("createParams must provide a workspaceDir for Codex thread tests.");
  }
  const sandboxSessionKey = params.sessionKey;
  if (!sandboxSessionKey) {
    throw new Error("createParams must provide a sessionKey for Codex dynamic tool tests.");
  }
  const nativeToolSurfaceEnabled = shouldEnableCodexAppServerNativeToolSurface(params);
  const dynamicTools = await buildDynamicTools({
    params,
    resolvedWorkspace: workspaceDir,
    effectiveWorkspace: workspaceDir,
    sandboxSessionKey,
    sandbox: { enabled: false, backendId: "docker" } as never,
    nativeToolSurfaceEnabled,
    runAbortController: new AbortController(),
    sessionAgentId: "main",
    policyAgentId: params.sandboxAgentId ?? "main",
    pluginConfig: options.pluginConfig ?? {},
    onYieldDetected: () => undefined,
  });
  const request = vi.fn(async (method: string, _requestParams?: unknown) => {
    if (method === "config/read") {
      return { config: {}, layers: [] };
    }
    if (method === "thread/start") {
      return threadStartResult();
    }
    if (method === "app/installed" || method === "app/read") {
      throw new Error("App inventory should not run when runtime toolsAllow is empty.");
    }
    throw new Error(`unexpected method: ${method}`);
  });
  const pluginConfig = {
    ...options.pluginConfig,
    codexPlugins: {
      ...(options.pluginConfig?.codexPlugins as Record<string, unknown> | undefined),
      enabled: false,
    },
  };

  await startOrResumeThread({
    client: { request } as never,
    params,
    cwd: workspaceDir,
    dynamicTools: dynamicTools as never,
    appServer: createThreadLifecycleAppServerOptions(),
    developerInstructions: options.developerInstructions,
    nativeCodeModeEnabled: nativeToolSurfaceEnabled,
    nativeCodeModeOnlyEnabled: false,
    userMcpServersEnabled: false,
    environmentSelection: [],
    pluginThreadConfig: {
      enabled: true,
      build: () =>
        buildCodexPluginThreadConfig({
          pluginConfig,
          request: request as never,
          appCacheKey: "test-app-cache-key",
        }),
    },
  });

  return { request, nativeToolSurfaceEnabled };
}

type RuntimeDynamicToolForTest = Parameters<
  typeof createCodexDynamicToolBridge
>[0]["tools"][number];

function flattenSpecsWithNamespace(
  specs: readonly CodexDynamicToolSpec[],
): Array<CodexDynamicToolFunctionSpec & { namespace?: string }> {
  return specs.flatMap((spec) =>
    spec.type === "namespace"
      ? spec.tools.map((tool) => ({ ...tool, namespace: spec.name }))
      : [spec],
  );
}

function specNames(specs: readonly CodexDynamicToolSpec[]): string[] {
  return flattenCodexDynamicToolFunctions(specs).map((tool) => tool.name);
}

function registerMemoryPromptForTest() {
  registerMemoryCapability("memory-core", {
    promptBuilder({ availableTools }) {
      const hasMemorySearch = availableTools.has("memory_search");
      const hasMemoryGet = availableTools.has("memory_get");
      if (hasMemorySearch && hasMemoryGet) {
        return [
          "## Memory Recall",
          "Test recall: run memory_search on MEMORY.md + memory/*.md + indexed session transcripts; then use memory_get.",
          "",
        ];
      }
      if (hasMemorySearch) {
        return [
          "## Memory Recall",
          "Test recall: run memory_search on MEMORY.md + memory/*.md + indexed session transcripts.",
          "",
        ];
      }
      if (hasMemoryGet) {
        return [
          "## Memory Recall",
          "Test recall: run memory_get for a specific memory file or note.",
          "",
        ];
      }
      return [];
    },
  });
}

function createRunPaths() {
  return {
    sessionFile: path.join(tempDir, "session.jsonl"),
    workspaceDir: path.join(tempDir, "workspace"),
    agentDir: path.join(tempDir, "agent"),
  };
}

function openRunSession(sessionFile: string) {
  return openFileBackedSessionManagerForTest(sessionFile, { sessionId: "session-1" });
}

function createRunParams() {
  const { sessionFile, workspaceDir } = createRunPaths();
  return createParams(sessionFile, workspaceDir);
}

const GOOGLE_CALENDAR_PLUGIN_CONFIG = {
  codexPlugins: {
    enabled: true,
    plugins: {
      "google-calendar": {
        marketplaceName: "openai-curated",
        pluginName: "google-calendar",
      },
    },
  },
} as const;

type GoogleCalendarCacheKeyInput = {
  appServer: ReturnType<typeof resolveCodexAppServerRuntimeOptions>;
  agentDir: string;
};

function googleCalendarAppInfo(isEnabled: boolean): v2.AppInfo {
  return {
    id: "google-calendar-app",
    name: "Google Calendar",
    description: null,
    logoUrl: null,
    logoUrlDark: null,
    distributionChannel: null,
    branding: null,
    appMetadata: null,
    labels: null,
    installUrl: null,
    isAccessible: true,
    isEnabled,
    pluginDisplayNames: [],
  };
}

const GOOGLE_CALENDAR_PLUGIN_INSTALLED_RESULT = {
  marketplaces: [
    {
      name: "openai-curated",
      path: "/marketplaces/openai-curated",
      interface: null,
      plugins: [
        {
          id: "google-calendar",
          name: "google-calendar",
          source: { type: "remote" },
          installed: true,
          enabled: true,
          installPolicy: "AVAILABLE",
          authPolicy: "ON_USE",
          availability: "AVAILABLE",
          interface: null,
        },
      ],
    },
  ],
  marketplaceLoadErrors: [],
} satisfies v2.PluginInstalledResponse;

const GOOGLE_CALENDAR_PLUGIN_LIST_RESULT = {
  ...GOOGLE_CALENDAR_PLUGIN_INSTALLED_RESULT,
  featuredPluginIds: [],
} satisfies v2.PluginListResponse;

const GOOGLE_CALENDAR_PLUGIN_READ_RESULT = {
  plugin: {
    marketplaceName: "openai-curated",
    marketplacePath: "/marketplaces/openai-curated",
    summary: {
      id: "google-calendar",
      name: "google-calendar",
      source: { type: "remote" },
      installed: true,
      enabled: true,
      installPolicy: "AVAILABLE",
      authPolicy: "ON_USE",
      availability: "AVAILABLE",
      interface: null,
    },
    description: null,
    skills: [],
    apps: [
      {
        id: "google-calendar-app",
        name: "Google Calendar",
        description: null,
        installUrl: null,
        category: null,
      },
    ],
    mcpServers: ["google-calendar"],
  },
} as const;

function createGoogleCalendarRequest(
  appInventory?: (method: "app/installed" | "app/read") => unknown,
) {
  let threadAppEnabled = false;
  return vi.fn(async (method: string, params?: unknown) => {
    if (method === "configRequirements/read") {
      return { requirements: null };
    }
    if (method === "config/read") {
      expect((params as { includeLayers?: boolean } | undefined)?.includeLayers).toBe(true);
      return { config: {}, layers: [] };
    }
    if (
      method === "app/installed" &&
      typeof (params as { threadId?: unknown } | undefined)?.threadId === "string"
    ) {
      return codexAppInventoryResponse("app/installed", [googleCalendarAppInfo(threadAppEnabled)]);
    }
    if ((method === "app/installed" || method === "app/read") && appInventory) {
      return appInventory(method);
    }
    if (method === "plugin/installed") {
      return GOOGLE_CALENDAR_PLUGIN_INSTALLED_RESULT;
    }
    if (method === "plugin/list") {
      return GOOGLE_CALENDAR_PLUGIN_LIST_RESULT;
    }
    if (method === "plugin/read") {
      return GOOGLE_CALENDAR_PLUGIN_READ_RESULT;
    }
    if (method === "thread/start") {
      const config = (params as { config?: { apps?: Record<string, { enabled?: boolean }> } })
        ?.config;
      threadAppEnabled = config?.apps?.["google-calendar-app"]?.enabled === true;
      return threadStartResult("thread-1");
    }
    if (method === "turn/start") {
      return turnStartResult("turn-1", "inProgress");
    }
    return undefined;
  });
}

async function primeGoogleCalendarAppInventory(key: string, isEnabled: boolean): Promise<void> {
  defaultCodexAppInventoryCache.clear();
  await defaultCodexAppInventoryCache.refreshNow({
    key,
    request: async (method, params) =>
      codexAppInventoryResponse(method, [googleCalendarAppInfo(isEnabled)], params),
  });
}

async function writeTokenPressureState(
  sessionFile: string,
  agentDir: string,
  info: Record<string, unknown>,
): Promise<void> {
  await fs.writeFile(
    path.join(path.dirname(sessionFile), "sessions.json"),
    JSON.stringify({
      "agent:main:session-1": {
        sessionFile,
        totalTokens: 12_000,
      },
    }),
  );
  const rolloutDir = path.join(agentDir, "codex-home", "sessions");
  await fs.mkdir(rolloutDir, { recursive: true });
  await fs.writeFile(
    path.join(rolloutDir, "rollout-thread-existing.jsonl"),
    `${JSON.stringify({ payload: { type: "token_count", info } })}\n`,
  );
}

function installFailingThreadStartClient(onThreadStart: () => unknown) {
  const retireSpy = vi.spyOn(sharedClientModule, "retireSharedCodexAppServerClientIfCurrent");
  retireSpy.mockClear();
  const { client } = createStartedThreadHarness(async (method) => {
    if (method === "thread/start") {
      return await onThreadStart();
    }
    return undefined;
  });
  return { retireSpy, state: { failedClient: client } };
}

async function runSettledFailureClientReplacementTest(
  options: { denyReplacementShell?: boolean; requests?: string[][] } = {},
) {
  const { sessionFile, workspaceDir } = createRunPaths();
  await writeExistingBinding(sessionFile, workspaceDir, { dynamicToolsFingerprint: "[]" });
  const requests = options.requests ?? [];
  const clients: Array<ReturnType<typeof createCodexLifecycleHarness>> = [];
  const turnStarted = createDeferred<ReturnType<typeof createCodexLifecycleHarness>>();
  onTestFinished(async () => {
    await Promise.all(clients.map(({ client }) => client.closeAndWait()));
  });
  vi.spyOn(CodexAppServerClient, "start").mockImplementation(async () => {
    const startIndex = clients.length;
    const methods: string[] = [];
    requests.push(methods);
    const wire = createCodexLifecycleHarness({
      persistedThreads: ["thread-existing"],
      respond: async (method) => {
        if (method === "config/read") {
          return { config: {}, origins: {}, layers: [] };
        }
        if (method === "configRequirements/read") {
          return {
            requirements:
              options.denyReplacementShell && startIndex > 0
                ? { featureRequirements: { shell_tool: false } }
                : null,
          };
        }
        if (method === "thread/resume") {
          return threadStartResult("thread-existing");
        }
        if (method === "turn/start") {
          turnStarted.resolve(wire);
          return turnStartResult();
        }
        return {};
      },
    });
    if (startIndex === 0) {
      const failedThread = threadStartResult("thread-existing");
      wire.seed(
        { ...failedThread, thread: { ...failedThread.thread, status: { type: "systemError" } } },
        { loaded: true, subscribed: false },
      );
    }
    const nativeRequest = CodexAppServerClient.prototype.request.bind(wire.client);
    wire.request.mockImplementation((method, params, requestOptions) => {
      if (method !== "initialize") {
        methods.push(method);
      }
      return nativeRequest(method, params, requestOptions);
    });
    clients.push(wire);
    return wire.client;
  });
  setCodexAppServerClientFactoryForTest(
    async (_start, _auth, _agent, _config, clientOptions) =>
      await sharedClientModule.getLeasedSharedCodexAppServerClient({
        ...clientOptions,
        startOptions: {
          transport: "stdio",
          command: process.execPath,
          args: ["app-server"],
          headers: {},
        },
        agentDir: path.join(tempDir, "restart-agent"),
        authProfileId: null,
        preparedAuth: undefined,
        authRequirement: undefined,
        config: {},
      }),
  );
  const { run, started } = startClockControlledAttempt(createParams(sessionFile, workspaceDir));
  const [readyClient] = await Promise.all([turnStarted.promise, started]);
  readyClient.notify({
    method: "turn/completed",
    params: { threadId: "thread-existing", turn: { id: "turn-1", status: "completed", items: [] } },
  });
  const result = await run;
  return { result, requests, client: readyClient.client };
}

async function startFastAutoProgressTest(
  options: {
    fastModeAuto?: boolean;
    fastModeAutoProgressState?: EmbeddedRunAttemptParams["fastModeAutoProgressState"];
    reportAgentEvents?: boolean;
    verbose?: boolean;
  } = {},
) {
  const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
  const onToolResult = vi.fn();
  const onAgentEvent = vi.fn();
  const { sessionFile, workspaceDir } = createRunPaths();
  const harness = createStartedThreadHarness();
  const params = createParams(sessionFile, workspaceDir);
  if (options.verbose !== false) {
    params.verboseLevel = "full";
  }
  params.fastModeAuto = options.fastModeAuto ?? true;
  params.fastModeStartedAtMs = 1_000;
  params.fastModeAutoOnSeconds = 30;
  if (options.fastModeAutoProgressState) {
    params.fastModeAutoProgressState = options.fastModeAutoProgressState;
  }
  params.onToolResult = onToolResult;
  if (options.reportAgentEvents !== false) {
    params.onAgentEvent = onAgentEvent;
  }
  const run = runCodexAppServerAttempt(params);
  await harness.waitForMethod("turn/start");
  return { harness, now, onAgentEvent, onToolResult, params, run, workspaceDir };
}

function fastProgressEventSummaries(onAgentEvent: ReturnType<typeof vi.fn>) {
  return onAgentEvent.mock.calls
    .map(([event]) => event)
    .filter((event) => event.stream === "item" && event.data?.title === "Fast")
    .map((event) => event.data?.summary);
}

async function completeStartedRun(
  run: Promise<unknown>,
  waitForMethod: ReturnType<typeof createStartedThreadHarness>["waitForMethod"],
  completeTurn: ReturnType<typeof createStartedThreadHarness>["completeTurn"],
  threadId = "thread-1",
): Promise<void> {
  await waitForMethod("turn/start");
  await completeTurn({ threadId, turnId: "turn-1" });
  await run;
}

function installCleanupTrackingClient() {
  const retireSpy = vi.spyOn(
    sharedClientModule,
    "clearSharedCodexAppServerClientIfCurrentAndUnclaimed",
  );
  retireSpy.mockReturnValue({ found: true, activeLeases: 0, pendingAcquires: 0, closed: true });
  const events: string[] = [];
  const turnStarted = createDeferred<void>();
  const closeAndWait = vi.fn(async () => {
    events.push("closeAndWait");
    return { exited: true, cleanup: "closed" } as const;
  });
  const harness = createStartedThreadHarness(async (method) => {
    events.push(`request:${method}`);
    if (method === "turn/start") {
      turnStarted.resolve();
    }
    return undefined;
  });
  harness.client.closeAndWait = closeAndWait;
  return {
    closeAndWait,
    events,
    retireSpy,
    state: { client: harness.client, notify: harness.notify },
    waitForTurnStart: (run: Promise<unknown>) =>
      Promise.race([
        turnStarted.promise,
        run.then(() => {
          throw new Error("Codex attempt ended before turn/start");
        }),
      ]),
  };
}

setupRunAttemptTestHooks();

describe("runCodexAppServerAttempt", () => {
  it("drains executable tool cleanup once after completion", async () => {
    const cleanup = vi.fn(async (_reason: string) => undefined);
    const cleanupOwners: boolean[] = [];
    const { sessionFile, workspaceDir } = createRunPaths();
    const params = createParams(sessionFile, workspaceDir);
    setCodexTestToolFactory(params, (options) => {
      cleanupOwners.push(options?.registerRunCleanup !== undefined);
      options?.registerRunCleanup?.(cleanup);
      return [createRuntimeDynamicTool("message")];
    });
    params.disableTools = false;
    params.runtimePlan = createCodexRuntimePlanFixture();
    setCodexTestModelSupportsTools(params, true);
    const harness = createStartedThreadHarness();

    const run = runCodexAppServerAttempt(params);
    await harness.waitForMethod("turn/start");
    await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    await run;

    expect(cleanupOwners).toEqual([true, false]);
    expect(cleanup).toHaveBeenCalledOnce();
    expect(cleanup).toHaveBeenCalledWith("completion");
  });

  it("preserves preparation failure and records failed one-shot tool cleanup", async () => {
    const preparationError = new Error("tool preparation failed");
    const cleanupError = new Error("tool cleanup failed");
    const cleanup = vi.fn(async () => {
      throw cleanupError;
    });
    const { sessionFile, workspaceDir } = createRunPaths();
    const params = createParams(sessionFile, workspaceDir);
    setCodexTestToolFactory(params, (options) => {
      options?.registerRunCleanup?.(cleanup);
      throw preparationError;
    });
    const warning = vi.spyOn(embeddedAgentLog, "warn");
    params.oneShotCliRun = true;
    params.disableTools = false;
    params.runtimePlan = createCodexRuntimePlanFixture();
    setCodexTestModelSupportsTools(params, true);

    await expect(runCodexAppServerAttempt(params)).rejects.toBe(preparationError);
    expect(cleanup).toHaveBeenCalledOnce();
    expect(warning).toHaveBeenCalledWith(
      expect.stringContaining("step=codex-dynamic-tool-cleanup error=Codex tool cleanup failed"),
    );
  });

  it("executes and reports the same materialized SecretRef credential", async () => {
    const { sessionFile, workspaceDir, agentDir } = createRunPaths();
    const authProfileId = "openai:work";
    const authProfileStore: EmbeddedRunAttemptParams["authProfileStore"] = {
      version: 1,
      profiles: {
        [authProfileId]: {
          type: "api_key",
          provider: "openai",
          keyRef: { source: "env", provider: "default", id: "OPENAI_WORK_KEY" },
        },
      },
    };
    const config = {
      auth: { profiles: { [authProfileId]: { provider: "openai", mode: "api_key" as const } } },
    };
    replaceRuntimeAuthProfileStoreSnapshots([
      {
        agentDir,
        store: {
          version: 1,
          profiles: {
            [authProfileId]: {
              type: "api_key",
              provider: "openai",
              keyRef: { source: "env", provider: "default", id: "OPENAI_WORK_KEY" },
              key: "work-key",
            },
          },
        },
      },
    ]);
    let clientOptions: CodexAppServerClientOptions | undefined;
    const harness = createStartedThreadHarness(async () => undefined, {
      onStart: (_profileId, _agentDir, options) => {
        clientOptions = options;
      },
    });
    const params = createParams(sessionFile, workspaceDir);
    params.agentDir = agentDir;
    params.authProfileId = authProfileId;
    params.authProfileStore = authProfileStore;
    params.config = config;
    const expected = await prepareCodexAppServerAuthBinding({
      authProfileId,
      authProfileStore,
      agentDir,
      config,
    });
    const run = runCodexAppServerAttempt(params);
    await harness.waitForMethod("turn/start");
    await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    const result = await run;
    expect(result.authBindingFingerprint).toBe(expected?.fingerprint);
    expect(clientOptions?.authBindingFingerprint).toBe(expected?.fingerprint);
    expect(clientOptions?.authProfileStore?.profiles[authProfileId]).toEqual({
      type: "api_key",
      provider: "openai",
      key: "work-key",
    });
    expect(authProfileStore.profiles[authProfileId]).toHaveProperty("keyRef");
  });
  it("starts active OpenClaw sandbox threads with Codex native execution disabled", async () => {
    const { sessionFile, workspaceDir } = createRunPaths();
    const params = createParams(sessionFile, workspaceDir);
    setCodexTestToolFactory(params, () => [
      createRuntimeDynamicTool("exec"),
      createRuntimeDynamicTool("process"),
      createRuntimeDynamicTool("message"),
    ]);
    params.disableTools = false;
    setCodexTestModelSupportsTools(params, true);
    params.runtimePlan = createCodexRuntimePlanFixture();
    const sandbox = {
      enabled: true,
      backendId: "codex-test-sandbox",
      workspaceAccess: "rw",
    } as never;
    const nativeToolSurfaceEnabled = shouldEnableCodexAppServerNativeToolSurface(params, sandbox);
    const dynamicTools = await buildDynamicTools({
      params,
      resolvedWorkspace: workspaceDir,
      effectiveWorkspace: workspaceDir,
      sandboxSessionKey: params.sessionKey!,
      sandbox,
      nativeToolSurfaceEnabled,
      runAbortController: new AbortController(),
      sessionAgentId: "main",
      policyAgentId: params.sandboxAgentId ?? "main",
      pluginConfig: {},
      onYieldDetected: () => undefined,
    });
    const request = vi.fn(async (method: string, _requestParams?: unknown) => {
      if (method === "config/read") {
        return { config: {}, layers: [] };
      }
      if (method === "thread/start") {
        return threadStartResult();
      }
      throw new Error(`unexpected method: ${method}`);
    });
    await startOrResumeThread({
      client: { request } as never,
      params,
      cwd: workspaceDir,
      dynamicTools: dynamicTools as never,
      appServer: createThreadLifecycleAppServerOptions(),
      nativeCodeModeEnabled: nativeToolSurfaceEnabled,
      nativeCodeModeOnlyEnabled: false,
      userMcpServersEnabled: nativeToolSurfaceEnabled,
      environmentSelection: [],
    });
    const startRequest = request.mock.calls.find(([method]) => method === "thread/start");
    const startParams = startRequest?.[1] as Record<string, unknown> | undefined;
    const startConfig = startParams?.config as Record<string, unknown> | undefined;
    const startDynamicTools = startParams?.dynamicTools as CodexDynamicToolSpec[] | undefined;
    expect(startConfig?.["features.code_mode"]).toBe(false);
    expect(startConfig?.["features.code_mode_only"]).toBe(false);
    expect(startParams?.environments).toEqual([]);
    expect(specNames(startDynamicTools ?? [])).toEqual([
      "message",
      "sandbox_exec",
      "sandbox_process",
    ]);
  });

  it("routes native Codex execution through an OpenClaw sandbox exec-server when opted in", async () => {
    const appServer = {
      ...createThreadLifecycleAppServerOptions(),
      sandbox: "danger-full-access" as const,
    };
    const sandbox = {
      ...createSandboxContext({
        runShellCommand: async () => ({
          stdout: Buffer.alloc(0),
          stderr: Buffer.alloc(0),
          code: 0,
        }),
      }),
      backendId: "codex-test-sandbox",
      runtimeId: `codex-test-runtime-${path.basename(tempDir)}`,
      runtimeLabel: "Codex Test Sandbox",
    };
    const request = vi.fn(async (method: string, _requestParams?: unknown) => {
      if (method === "configRequirements/read") {
        return { requirements: null };
      }
      if (method === "config/read") {
        return { config: {}, origins: {}, layers: [] };
      }
      if (method === "environment/add") {
        return {};
      }
      if (method === "thread/start") {
        return threadStartResult();
      }
      throw new Error(`unexpected method: ${method}`);
    });
    const client = {
      ...mockClientRuntimeMethods(),
      request,
    };
    try {
      const sessionFile = path.join(tempDir, "session.jsonl");
      const workspaceDir = path.join(tempDir, "workspace");
      const params = createParams(sessionFile, workspaceDir);
      setCodexTestToolFactory(params, () => [
        createRuntimeDynamicTool("exec"),
        createRuntimeDynamicTool("process"),
        createRuntimeDynamicTool("message"),
      ]);
      params.disableTools = false;
      setCodexTestModelSupportsTools(params, true);
      params.runtimePlan = createCodexRuntimePlanFixture();
      params.config = {
        agents: {
          defaults: {
            sandbox: {
              mode: "all",
              backend: "codex-test-sandbox",
              scope: "session",
              workspaceAccess: "rw",
              prune: { idleHours: 0, maxAgeDays: 0 },
            },
          },
        },
      } as never;
      const nativeToolSurfaceEnabled = shouldEnableCodexAppServerNativeToolSurface(
        params,
        sandbox as never,
        { sandboxExecServerEnabled: true },
      );
      const dynamicTools = await buildDynamicTools({
        params,
        resolvedWorkspace: workspaceDir,
        effectiveWorkspace: "/workspace",
        sandboxSessionKey: params.sessionKey!,
        sandbox: sandbox as never,
        nativeToolSurfaceEnabled,
        runAbortController: new AbortController(),
        sessionAgentId: "main",
        policyAgentId: params.sandboxAgentId ?? "main",
        pluginConfig: {
          appServer: {
            mode: "yolo",
            experimental: { sandboxExecServer: true },
          },
        },
        onYieldDetected: () => undefined,
      });
      const environment = await ensureCodexSandboxExecServerEnvironment({
        client: client as never,
        sandbox: sandbox as never,
        appServerStartOptions: appServer.start,
      });
      if (!environment) {
        throw new Error("expected sandbox exec-server environment");
      }
      const environmentSelection = [environment];
      await startOrResumeThread({
        client: client as never,
        params,
        cwd: environment.cwd,
        dynamicTools: dynamicTools as never,
        appServer,
        nativeCodeModeEnabled: nativeToolSurfaceEnabled,
        nativeCodeModeOnlyEnabled: false,
        userMcpServersEnabled: nativeToolSurfaceEnabled,
        environmentSelection,
      });
      const turnParams = await buildTurnStartParams(params, {
        threadId: "thread-1",
        cwd: environment.cwd,
        appServer,
        sandboxPolicy: { type: "externalSandbox", networkAccess: "enabled" },
        environmentSelection,
      });
      const environmentAdd = request.mock.calls.find(([method]) => method === "environment/add");
      const environmentAddParams = environmentAdd?.[1] as
        | { environmentId?: string; execServerUrl?: string }
        | undefined;
      const startRequest = request.mock.calls.find(([method]) => method === "thread/start");
      const startParams = startRequest?.[1] as
        | {
            cwd?: string;
            dynamicTools?: CodexDynamicToolSpec[];
            environments?: Array<{ environmentId?: string; cwd?: string }>;
            sandbox?: string;
            config?: {
              "features.code_mode"?: boolean;
              "features.code_mode_only"?: boolean;
              "features.apply_patch_streaming_events"?: boolean;
            };
          }
        | undefined;
      expect(nativeToolSurfaceEnabled).toBe(true);
      expect(environmentAddParams?.environmentId).toMatch(/^openclaw-sandbox-/);
      expect(environmentAddParams?.execServerUrl).toMatch(/^ws:\/\/127\.0\.0\.1:/);
      expect(startParams?.cwd).toBe("/workspace");
      expect(startParams?.config?.["features.code_mode"]).toBe(true);
      expect(startParams?.config?.["features.code_mode_only"]).toBe(false);
      expect(startParams?.config?.["features.apply_patch_streaming_events"]).toBe(true);
      expect(specNames(startParams?.dynamicTools ?? [])).toEqual(["message"]);
      expect(startParams?.environments).toEqual([
        { environmentId: environmentAddParams?.environmentId, cwd: "/workspace" },
      ]);
      expect(startParams?.sandbox).toBe("danger-full-access");
      expect(turnParams.sandboxPolicy).toEqual({
        type: "externalSandbox",
        networkAccess: "enabled",
      });
      expect(turnParams.cwd).toBe("/workspace");
      expect(turnParams.environments).toEqual(startParams?.environments);
    } finally {
      await releaseCodexSandboxExecServerEnvironment(sandbox as never);
    }
  });

  it("emits TUI-compatible tool events for Codex dynamic tool calls", async () => {
    const sessionFile = path.join(tempDir, "session-tool-events.jsonl");
    const workspaceDir = path.join(tempDir, "workspace-tool-events");
    const harness = createStartedThreadHarness();
    const params = createParams(sessionFile, workspaceDir);
    await attachSqliteSessionTarget(
      params,
      path.join(tempDir, "tool-event-sessions.json"),
      "tool-event-session",
    );
    const onRunAgentEvent = vi.fn();
    params.timeoutMs = 60_000;
    params.onAgentEvent = onRunAgentEvent;
    const run = runCodexAppServerAttempt(params);
    await harness.waitForMethod("turn/start");
    const request = {
      id: "request-tool-1",
      method: "item/tool/call",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        callId: "call-1",
        namespace: null,
        tool: "python",
        arguments: { code: "print('hi')" },
      },
    };
    const [firstResponse, replayedResponse] = await Promise.all([
      harness.handleServerRequest(request),
      harness.handleServerRequest(request),
    ]);
    expect(firstResponse).toMatchObject({
      success: false,
      contentItems: [{ type: "inputText", text: "Unknown OpenClaw tool: python" }],
    });
    expect(replayedResponse).toEqual(firstResponse);
    expect((await readTranscriptMessagesByIdentity(params)).map((message) => message.role)).toEqual(
      ["user", "assistant", "toolResult"],
    );
    await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    await run;
    expect(onRunAgentEvent).toHaveBeenCalledWith({
      stream: "tool",
      data: {
        phase: "start",
        name: "python",
        itemId: "call-1",
        toolCallId: "call-1",
        args: { code: "print('hi')" },
      },
    });
    expect(onRunAgentEvent).toHaveBeenCalledWith({
      stream: "tool",
      data: {
        phase: "result",
        name: "python",
        itemId: "call-1",
        toolCallId: "call-1",
        isError: true,
        result: {
          content: [{ type: "text", text: "Unknown OpenClaw tool: python" }],
        },
      },
    });
    const resultEvent = onRunAgentEvent.mock.calls
      .map(([event]) => event)
      .find(
        (
          event,
        ): event is {
          data: {
            phase: "result";
            result: { content?: unknown; contentItems?: unknown; success?: unknown };
          };
          stream: "tool";
        } => event.stream === "tool" && event.data?.phase === "result",
      );
    expect(resultEvent?.data.result).not.toHaveProperty("success");
    expect(resultEvent?.data.result).not.toHaveProperty("contentItems");
    const toolPhases = onRunAgentEvent.mock.calls
      .map(([event]) => event)
      .filter((event) => event.stream === "tool")
      .map((event) => event.data?.phase);
    expect(toolPhases).toEqual(["start", "result"]);
  });
  it("keeps leading delivery hints out of the Codex current user request", async () => {
    for (const [index, deliveryHint] of MESSAGE_TOOL_DELIVERY_HINTS.entries()) {
      // Bindings are keyed by session identity, so the previous iteration's
      // thread would otherwise resume against a harness that cannot serve it.
      resetCodexTestBindingStore();
      const sessionFile = path.join(tempDir, `session-delivery-hint-${index}.jsonl`);
      const workspaceDir = path.join(tempDir, `workspace-delivery-hint-${index}`);
      const harness = createStartedThreadHarness();
      const params = createParams(sessionFile, workspaceDir);
      params.prompt = `${deliveryHint}\n\nhello`;
      params.skillsSnapshot = {
        prompt: "<available_skills><skill><name>demo</name></skill></available_skills>",
        skills: [],
      };
      const run = runCodexAppServerAttempt(params);
      await harness.waitForMethod("turn/start");
      await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
      await run;
      const turnStart = harness.requests.find((request) => request.method === "turn/start");
      const turnStartParams = turnStart?.params as {
        input?: Array<{ text?: string }>;
      };
      const inputText = turnStartParams.input?.[0]?.text ?? "";
      expect(inputText).toContain("OpenClaw delivery metadata:");
      expect(inputText).toContain(
        "This delivery metadata is runtime routing guidance, not the user's request.",
      );
      expect(inputText).toContain(deliveryHint);
      expect(inputText).toContain("Current user request:\nhello");
      expect(inputText).not.toContain("Current user request:\nDelivery:");
    }
  });

  it("persists completed Codex work before a disconnected turn ends", async () => {
    const sessionFile = path.join(tempDir, "session-early-prompt.jsonl");
    const storePath = path.join(tempDir, "sessions-early-prompt.json");
    const workspaceDir = path.join(tempDir, "workspace-early-prompt");
    const harness = createStartedThreadHarness();
    const params = createParams(sessionFile, workspaceDir);
    await attachSqliteSessionTarget(params, storePath, "session-early-prompt");
    params.prompt = "external channel prompt";
    const userMessagePersisted = createDeferred<void>();
    const onUserMessagePersisted = vi.fn(() => userMessagePersisted.resolve());
    params.onUserMessagePersisted = onUserMessagePersisted;
    const waitForProjectionReady = observeAttemptProjectionReady();
    const { run, started } = startClockControlledAttempt(params);
    await started;
    await awaitGateBeforeSettlement(
      userMessagePersisted.promise,
      run,
      "Codex attempt settled before persisting its user prompt",
    );
    await awaitGateBeforeSettlement(
      waitForProjectionReady(),
      run,
      "Codex attempt settled before its transcript projection was ready",
    );
    const messagesBeforeCompletion = await readTranscriptMessagesByIdentity(params);
    const expectedUserMessage = expect.objectContaining({
      role: "user",
      content: "external channel prompt",
      idempotencyKey: "codex-app-server:thread-1:turn-1:prompt",
    });
    expect(messagesBeforeCompletion).toContainEqual(expectedUserMessage);
    expect(onUserMessagePersisted).toHaveBeenCalledWith(expectedUserMessage);
    expect(messagesBeforeCompletion.some((message) => message.role === "assistant")).toBe(false);
    const commentary = {
      type: "agentMessage",
      id: "progress-1",
      phase: "commentary",
      text: "I found the owning lifecycle.",
    };
    await harness.notify(itemNotification("item/started", commentary));
    await harness.notify({
      method: "item/agentMessage/delta",
      params: { threadId: "thread-1", turnId: "turn-1", itemId: commentary.id, delta: "I found" },
    });
    const command = {
      type: "commandExecution",
      id: "command-1",
      command: "pwd",
      cwd: workspaceDir,
      status: "inProgress",
    };
    await harness.notify(itemNotification("item/started", command));
    expect(await readTranscriptMessagesByIdentity(params)).toEqual(messagesBeforeCompletion);
    await harness.notify(itemNotification("item/completed", commentary));
    await harness.notify(
      itemNotification("item/completed", {
        ...command,
        status: "completed",
        aggregatedOutput: workspaceDir,
        exitCode: 0,
      }),
    );
    const workBeforeCompletion = await readTranscriptMessagesByIdentity(params);
    expect(workBeforeCompletion.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "assistant",
      "toolResult",
    ]);
    expect(JSON.stringify(workBeforeCompletion)).toContain(commentary.text);
    expect(JSON.stringify(workBeforeCompletion)).toContain(workspaceDir);
    harness.close(new Error("test transport disconnected"));
    await run;
    const messagesAfterCompletion = await readTranscriptMessagesByIdentity(params);
    expect(messagesAfterCompletion.filter((message) => message.role === "user")).toHaveLength(1);
    for (const message of workBeforeCompletion) {
      expect(
        messagesAfterCompletion.filter(
          (candidate) => candidate.idempotencyKey === message.idempotencyKey,
        ),
      ).toEqual([message]);
    }
    expect(onUserMessagePersisted).toHaveBeenCalledTimes(1);
  });
  it("persists terminal failure when the execution device disconnects during finalization", async () => {
    const resourcesSpy = vi.spyOn(runAttemptResources, "prepareCodexAttemptResources");
    const startupSpy = vi.spyOn(attemptStartup, "startCodexAttemptThread");
    const harness = createStartedThreadHarness();
    const params = createParams(
      path.join(tempDir, "session-terminal-disconnect.jsonl"),
      path.join(tempDir, "workspace-terminal-disconnect"),
    );
    await attachSqliteSessionTarget(
      params,
      path.join(tempDir, "sessions-terminal-disconnect.json"),
      "session-terminal-disconnect",
    );
    const preparedMessages: AssistantMessage[] = [];
    params.prepareAssistantTranscriptMessage = (message) => {
      preparedMessages.push(structuredClone(message));
      return message;
    };
    const onAgentEvent = vi.fn();
    params.onAgentEvent = onAgentEvent;
    const run = runCodexAppServerAttempt(params);
    await harness.waitForMethod("turn/start");
    await vi.waitFor(() => {
      expect(resourcesSpy.mock.results[0]?.value.projectorRef.current).toBeDefined();
    });
    const projector = resourcesSpy.mock.results[0]?.value.projectorRef.current;
    const onExecutionDisconnect = startupSpy.mock.calls[0]?.[0].onExecutionDisconnect;
    if (!projector || !onExecutionDisconnect) {
      throw new Error("Expected the attempt's active projector and execution disconnect owner");
    }
    const disconnectError = new Error("Paired execution device disconnected during finalization.");
    const buildResult = projector.buildResult.bind(projector);
    vi.spyOn(projector, "buildResult").mockImplementationOnce((...args) => {
      const result = buildResult(...args);
      // Inject device loss at the real enrichment await, after the initial snapshot exists.
      queueMicrotask(() => onExecutionDisconnect(disconnectError));
      return result;
    });
    const text = "Answer text generated before the device was lost.";
    await harness.notify(
      itemNotification("item/completed", {
        type: "agentMessage",
        id: "terminal-answer",
        phase: "final_answer",
        text,
      }),
    );
    await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    await expect(run).rejects.toBe(disconnectError);
    expect(onAgentEvent).toHaveBeenCalledWith({
      stream: "lifecycle",
      data: expect.objectContaining({ phase: "error", error: disconnectError.message }),
    });
    const expectedAssistant = {
      role: "assistant",
      content: [{ type: "text", text }],
      stopReason: "error",
      errorMessage: disconnectError.message,
    };
    const persistedMessage = (await readTranscriptMessagesByIdentity(params)).find(
      (message) => message.idempotencyKey === "codex-app-server:thread-1:turn-1:assistant",
    );
    expect({ preparedMessages, persistedMessage }).toEqual({
      preparedMessages: [expect.objectContaining(expectedAssistant)],
      persistedMessage: expect.objectContaining(expectedAssistant),
    });
  });

  it("does not mirror the Codex prompt early when user message persistence is suppressed", async () => {
    const sessionFile = path.join(tempDir, "session-suppressed-early-prompt.jsonl");
    const storePath = path.join(tempDir, "sessions-suppressed-early-prompt.json");
    const workspaceDir = path.join(tempDir, "workspace-suppressed-early-prompt");
    const harness = createStartedThreadHarness();
    const params = createParams(sessionFile, workspaceDir);
    await attachSqliteSessionTarget(params, storePath, "session-suppressed-early-prompt");
    params.prompt = "already persisted prompt";
    params.suppressNextUserMessagePersistence = true;
    const run = runCodexAppServerAttempt(params);
    await harness.waitForMethod("turn/start");
    await expect(
      vi.waitFor(
        async () => {
          expect(await readTranscriptMessagesByIdentity(params)).toContainEqual(
            expect.objectContaining({
              content: "already persisted prompt",
            }),
          );
        },
        { interval: 1, timeout: 100 },
      ),
    ).rejects.toThrow();
    const messagesBeforeCompletion = await readTranscriptMessagesByIdentity(params);
    expect(messagesBeforeCompletion).not.toContainEqual(
      expect.objectContaining({
        content: "already persisted prompt",
      }),
    );
    expect(messagesBeforeCompletion).not.toContainEqual(
      expect.objectContaining({
        idempotencyKey: "codex-app-server:thread-1:turn-1:prompt",
      }),
    );
    await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    await run;
    const messagesAfterCompletion = await readTranscriptMessagesByIdentity(params);
    expect(messagesAfterCompletion).not.toContainEqual(
      expect.objectContaining({
        content: "already persisted prompt",
      }),
    );
    expect(messagesAfterCompletion).not.toContainEqual(
      expect.objectContaining({
        idempotencyKey: "codex-app-server:thread-1:turn-1:prompt",
      }),
    );
  });

  it("wires approval timeouts into native tool evidence without aborting the turn", async () => {
    const harness = createStartedThreadHarness();
    const params = createParams(
      path.join(tempDir, "session-approval-timeout.jsonl"),
      path.join(tempDir, "workspace-approval-timeout"),
    );
    params.hostCapabilities = Object.freeze({
      ...params.hostCapabilities,
      requestApproval: async () => ({ id: "plugin:approval-timeout" }),
      waitForApproval: async () => ({
        decision: "deny" as const,
        terminalReason: "timeout" as const,
      }),
    });
    const run = runCodexAppServerAttempt(params, {
      pluginConfig: { appServer: { mode: "guardian" } },
    });
    await harness.waitForMethod("turn/start");
    const item = {
      type: "fileChange" as const,
      id: "patch-approval-timeout",
      changes: [{ path: "src/example.ts", kind: { type: "add" as const } }],
    };
    await harness.notify(
      itemNotification("item/started", {
        ...item,
        status: "inProgress",
        durationMs: null,
      }),
    );

    await expect(
      harness.handleServerRequest({
        id: "request-approval-timeout",
        method: "item/fileChange/requestApproval",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          itemId: item.id,
          reason: "write src/example.ts",
        },
      }),
    ).resolves.toEqual({ decision: "decline" });
    await harness.notify(
      itemNotification("item/completed", { ...item, status: "declined", durationMs: 1 }),
    );
    await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });

    const result = await run;
    expect(result.lastToolError).toMatchObject({
      toolName: "apply_patch",
      error: codexApprovalTimeoutText("file-change"),
      errorCode: "approval_timeout",
      timedOut: true,
    });
    const toolResult = result.messagesSnapshot.find(
      (message) => message.role === "toolResult" && message.toolCallId === item.id,
    );
    expect(toolResult).toMatchObject({
      role: "toolResult",
      content: [expect.objectContaining({ text: result.lastToolError?.error })],
    });
    expect(readAttemptTerminal(result)).toMatchObject({ aborted: false, timedOut: false });
  });

  it("keeps the heartbeat schema deferred and stable across normal and heartbeat turns", async () => {
    const { sessionFile, workspaceDir } = createRunPaths();
    const createHeartbeatRunParams = (trigger?: EmbeddedRunAttemptParams["trigger"]) => {
      const params = createParams(sessionFile, workspaceDir);
      params.disableTools = false;
      params.runtimePlan = createCodexRuntimePlanFixture();
      params.sourceReplyDeliveryMode = "message_tool_only";
      if (trigger) {
        params.trigger = trigger;
      }
      return params;
    };
    const registeredTools = [
      createRuntimeDynamicTool("message"),
      createRuntimeDynamicTool("heartbeat_respond"),
    ];
    const normalBridge = createCodexToolBridgeForTest(
      createHeartbeatRunParams(),
      [createRuntimeDynamicTool("message")],
      registeredTools,
    );
    const normalInstructions = buildDeveloperInstructions(createHeartbeatRunParams(), {
      dynamicTools: normalBridge.availableSpecs,
    });
    const heartbeatParams = createHeartbeatRunParams("heartbeat");
    const heartbeatBridge = createCodexToolBridgeForTest(
      heartbeatParams,
      [createRuntimeDynamicTool("message"), createRuntimeDynamicTool("heartbeat_respond")],
      registeredTools,
    );
    const heartbeatInstructions = buildDeveloperInstructions(heartbeatParams, {
      dynamicTools: heartbeatBridge.availableSpecs,
    });
    const nextNormalParams = createHeartbeatRunParams();
    const nextNormalBridge = createCodexToolBridgeForTest(
      nextNormalParams,
      [createRuntimeDynamicTool("message")],
      registeredTools,
    );
    const registeredToolNames = specNames(normalBridge.specs);
    expect(registeredToolNames).toContain("message");
    expect(registeredToolNames).toContain("heartbeat_respond");
    expect(normalInstructions).not.toContain(
      "Deferred searchable OpenClaw dynamic tools available: heartbeat_respond",
    );
    expect(heartbeatInstructions).toContain(
      "Deferred searchable OpenClaw dynamic tools available: heartbeat_respond.",
    );
    for (const bridge of [normalBridge, heartbeatBridge, nextNormalBridge]) {
      const heartbeat = flattenSpecsWithNamespace(bridge.specs).find(
        (tool) => tool.name === "heartbeat_respond",
      );
      expect(heartbeat?.namespace).toBe("openclaw");
      expect(heartbeat?.deferLoading).toBe(true);
    }
    expect(codexDynamicToolsFingerprint(heartbeatBridge.specs)).toBe(
      codexDynamicToolsFingerprint(normalBridge.specs),
    );
    expect(codexDynamicToolsFingerprint(nextNormalBridge.specs)).toBe(
      codexDynamicToolsFingerprint(normalBridge.specs),
    );
    let startedThreadId: string | undefined;
    const respond = vi.fn(async (method: string) => {
      if (method === "configRequirements/read") {
        return { requirements: null };
      }
      if (method === "config/read") {
        return { config: {}, origins: {}, layers: [] };
      }
      if (method === "thread/start") {
        startedThreadId = "thread-stable-heartbeat";
        return threadStartResult(startedThreadId);
      }
      if (method === "thread/resume") {
        return threadStartResult(startedThreadId);
      }
      throw new Error(`unexpected method: ${method}`);
    });
    const fixture = await createLeasedCodexLifecycleHarness({
      agentDir: path.join(tempDir, "heartbeat-agent"),
      respond,
    });
    const { client, request } = fixture;
    const turns = [
      { params: createRunParams(), bridge: normalBridge },
      { params: heartbeatParams, bridge: heartbeatBridge },
      { params: nextNormalParams, bridge: nextNormalBridge },
    ];
    for (const turn of turns) {
      await startOrResumeThread({
        client,
        params: turn.params,
        cwd: workspaceDir,
        dynamicTools: turn.bridge.specs,
        appServer: createThreadLifecycleAppServerOptions(),
        signal: new AbortController().signal,
      });
      await fixture.endTurn("thread-stable-heartbeat");
    }
    expect(withoutCodexSkillDiscovery(request.mock.calls.map(([method]) => method))).toEqual([
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
      "thread/unsubscribe",
    ]);
  });
  it("disables Codex native tool surfaces when runtime toolsAllow is empty", async () => {
    const params = createRunParams();
    setCodexTestToolFactory(params, () => [
      createRuntimeDynamicTool("message"),
      createRuntimeDynamicTool("web_search"),
    ]);
    params.disableTools = false;
    setCodexTestModelSupportsTools(params, true);
    params.runtimePlan = createCodexRuntimePlanFixture();
    params.toolsAllow = [];
    params.extraSystemPrompt = "Tool and file actions are disabled for this sender by chat policy.";
    const { request, nativeToolSurfaceEnabled } = await startThreadWithDisabledNativeSurfaceForTest(
      params,
      {
        pluginConfig: {
          appServer: { mode: "yolo" },
          codexPlugins: {
            enabled: true,
            plugins: {
              "google-calendar": {
                marketplaceName: "openai-curated",
                pluginName: "google-calendar",
              },
            },
          },
        },
        developerInstructions: params.extraSystemPrompt,
      },
    );
    const startRequest = request.mock.calls.find(([method]) => method === "thread/start");
    const startParams = startRequest?.[1] as
      | {
          dynamicTools?: CodexDynamicToolSpec[];
          environments?: unknown[];
          developerInstructions?: string;
          config?: {
            "features.code_mode"?: boolean;
            "features.code_mode_only"?: boolean;
            apps?: Record<
              string,
              { enabled?: boolean; destructive_enabled?: boolean; open_world_enabled?: boolean }
            >;
          };
        }
      | undefined;
    expect(nativeToolSurfaceEnabled).toBe(false);
    expect(startParams?.dynamicTools).toEqual([]);
    expect(startParams?.environments).toEqual([]);
    expect(startParams?.developerInstructions).toContain(
      "Tool and file actions are disabled for this sender by chat policy.",
    );
    expect(startParams?.config?.["features.code_mode"]).toBe(false);
    expect(startParams?.config?.["features.code_mode_only"]).toBe(false);
    expect(startParams?.config?.apps?.["_default"]).toEqual({
      enabled: false,
      destructive_enabled: false,
      open_world_enabled: false,
    });
    expect(startParams?.config?.apps?.["google-calendar-app"]?.enabled).toBeUndefined();
    expect(request.mock.calls.map(([method]) => method)).not.toContain("app/installed");
    expect(request.mock.calls.map(([method]) => method)).not.toContain("app/read");
  });

  it.each([{ source: "legacy managed MDM", layer: { type: "legacyManagedConfigTomlFromMdm" } }])(
    "rejects a $source shell denial before a native creator can start",
    async ({ layer }) => {
      const params = createRunParams();
      params.disableTools = false;
      setCodexTestModelSupportsTools(params, true);
      params.runtimePlan = createCodexRuntimePlanFixture();
      const harness = createStartedThreadHarness(async (method) => {
        if (method === "configRequirements/read") {
          return { requirements: layer ? null : { featureRequirements: { shell_tool: false } } };
        }
        if (method === "config/read" && layer) {
          const metadata = { name: layer, version: "sha256:managed-shell-denied" };
          const config = { features: { shell_tool: false } };
          return {
            config,
            origins: { "features.shell_tool": metadata },
            layers: [{ ...metadata, config }],
          };
        }
        if (method === "thread/start") {
          throw new Error("unexpected native creator start");
        }
        return undefined;
      });

      await expect(runCodexAppServerAttempt(params)).rejects.toThrow(
        "Codex native code mode requires shell_tool",
      );
      expect(harness.requests.map((request) => request.method)).not.toContain("thread/start");
    },
  );

  it("overrides a user-level shell disable when native code mode is enabled", async () => {
    const params = createRunParams();
    params.disableTools = false;
    setCodexTestModelSupportsTools(params, true);
    params.runtimePlan = createCodexRuntimePlanFixture();
    const harness = createStartedThreadHarness(async (method) => {
      if (method !== "config/read") {
        return undefined;
      }
      const metadata = {
        name: { type: "user", file: "/fixture/codex/config.toml", profile: null },
        version: "sha256:user-shell-disabled",
      };
      const config = { features: { shell_tool: false } };
      return {
        config,
        origins: { "features.shell_tool": metadata },
        layers: [{ ...metadata, config }],
      };
    });

    const run = runCodexAppServerAttempt(params);
    await harness.waitForMethod("turn/start");
    await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    await expect(run).resolves.toBeDefined();
    expect(
      harness.requests.find((request) => request.method === "thread/start")?.params,
    ).toMatchObject({
      config: { "features.shell_tool": true },
    });
  });

  it("replaces the native surface with a filtered catalog and canonical plan persistence", async () => {
    const persistedProgressCardInputs: JsonObject[] = [];
    const executeProgressCard = vi.fn(async (_toolCallId: string, input: unknown) => {
      if (!isJsonObject(input)) {
        throw new Error("progress card input must be an object");
      }
      const { markdown, plan } = input;
      const planSteps = Array.isArray(plan) ? plan.filter(isJsonObject) : [];
      const activeSteps = planSteps.filter((entry) => entry.status === "in_progress");
      const hasOversizedStep = planSteps.some((entry) => {
        const { step } = entry;
        return typeof step === "string" && Buffer.byteLength(step, "utf8") > 512;
      });
      if (
        planSteps.length > 50 ||
        activeSteps.length > 1 ||
        hasOversizedStep ||
        (typeof markdown === "string" && Buffer.byteLength(markdown, "utf8") > 8 * 1024)
      ) {
        throw new Error("progress card input exceeded its persistence contract");
      }
      persistedProgressCardInputs.push(input);
      return {
        content: [{ type: "text" as const, text: "Progress card updated" }],
        details: {},
      };
    });

    const params = createRunParams();
    setCodexTestToolFactory(params, (options) => {
      const tools = createOpenClawCodingTools(options).filter((tool) =>
        ["read", "write", "edit", "apply_patch", "exec", "process", "progress_card"].includes(
          tool.name,
        ),
      );
      const progressCardTool = tools.find((tool) => tool.name === "progress_card");
      if (progressCardTool) {
        progressCardTool.execute = executeProgressCard;
      }
      return tools;
    });
    params.disableTools = false;
    setCodexTestModelSupportsTools(params, true);
    params.runtimePlan = createCodexRuntimePlanFixture();
    params.conversationToolPolicy = {
      deny: ["exec", "process", "write", "edit"],
    };
    params.pluginHarnessToolPolicyRestricted = true;
    const agentsGuidance = "Restricted turns keep workspace AGENTS guidance.";
    await fs.mkdir(params.workspaceDir, { recursive: true });
    await fs.writeFile(path.join(params.workspaceDir, "AGENTS.md"), agentsGuidance);
    setAgentWorkspaceForTest(params, params.workspaceDir);
    const onAgentEvent = vi.fn();
    params.onAgentEvent = onAgentEvent;
    const harness = createStartedThreadHarness(async (method) => {
      if (method === "config/read") {
        return { config: {}, layers: [] };
      }
      if (method === "configRequirements/read") {
        return { requirements: null };
      }
      if (method === "mcpServerStatus/list") {
        return { data: [], nextCursor: null };
      }
      return undefined;
    });

    const { run, started } = startClockControlledAttempt(params);
    await started;
    const startRequest = harness.requests.find((request) => request.method === "thread/start");
    const startParams = startRequest?.params as
      | {
          dynamicTools?: CodexDynamicToolSpec[];
          environments?: unknown[];
          developerInstructions?: string;
          config?: Record<string, unknown>;
        }
      | undefined;
    const dynamicToolNames = flattenSpecsWithNamespace(startParams?.dynamicTools ?? []).map(
      (tool) => tool.name,
    );

    expect(startParams?.environments).toEqual([]);
    expect(startParams?.config?.project_doc_max_bytes).toBe(131_072);
    expect(startParams?.developerInstructions?.split(agentsGuidance)).toHaveLength(2);
    expect(startParams?.config?.["tools.update_plan.enabled"]).toBe(false);
    expect(dynamicToolNames.toSorted()).toEqual(["apply_patch", "progress_card", "read"]);
    const progressCardSpec = flattenSpecsWithNamespace(startParams?.dynamicTools ?? []).find(
      (tool) => tool.name === "progress_card",
    );
    expect(progressCardSpec).not.toHaveProperty("namespace");
    expect(progressCardSpec).not.toHaveProperty("deferLoading");
    expect(startParams?.config).toMatchObject({
      "features.hooks": false,
      "hooks.PreToolUse": [],
      "hooks.PostToolUse": [],
      "hooks.PermissionRequest": [],
      "hooks.Stop": [],
    });
    expect(harness.requests.map((request) => request.method)).toContain("mcpServerStatus/list");

    const plan = [
      { step: "Inspect regression", status: "completed" },
      { step: "Restore progress", status: "in_progress" },
    ];
    const response = await harness.handleServerRequest({
      id: "request-plan-1",
      method: "item/tool/call",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        callId: "call-plan-1",
        namespace: null,
        tool: "progress_card",
        arguments: { markdown: "Plan restored", plan },
      },
    });
    expect(response).toMatchObject({ success: true });
    expect(onAgentEvent).toHaveBeenCalledWith({
      stream: "plan",
      data: {
        phase: "update",
        title: "Plan updated",
        source: "openclaw",
        explanation: "1/2 complete",
        steps: plan,
      },
    });
    expect(executeProgressCard).toHaveBeenCalledTimes(1);

    await harness.notify(
      itemNotification("item/started", { type: "contextCompaction", id: "compact-1" }),
    );
    await harness.notify(
      itemNotification("item/completed", { type: "contextCompaction", id: "compact-1" }),
    );
    let planRestoreRequests = harness.requests.filter(
      (request) => request.method === "thread/inject_items",
    );
    expect(planRestoreRequests[0]?.params).toMatchObject({
      threadId: "thread-1",
      items: [
        {
          type: "message",
          role: "user",
          content: [
            {
              type: "input_text",
              text: expect.stringContaining('"markdown":"Plan restored"'),
            },
          ],
        },
      ],
    });
    expect(JSON.stringify(planRestoreRequests[0]?.params)).toContain("progress_card");

    const nativePlan = Array.from({ length: 51 }, (_, index) => ({
      step: index === 0 ? `Ship ${"🚀".repeat(200)}` : `Native step ${index}`,
      status: index < 2 ? "inProgress" : "pending",
    }));
    await harness.notify({
      method: "turn/plan/updated",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        explanation: "m".repeat(9_000),
        plan: nativePlan,
      },
    });
    expect(executeProgressCard).toHaveBeenCalledTimes(2);
    const persistedNativeInput = persistedProgressCardInputs[1];
    expect(persistedNativeInput).toBeDefined();
    if (!persistedNativeInput) {
      throw new Error("native progress card input was not persisted");
    }
    const canonicalPlan = Array.isArray(persistedNativeInput.plan)
      ? persistedNativeInput.plan.filter(isJsonObject)
      : [];
    expect(canonicalPlan).toHaveLength(50);
    expect(canonicalPlan.at(-1)?.step).toBe("Native step 49");
    expect(canonicalPlan[0]?.status).toBe("in_progress");
    expect(canonicalPlan[1]?.status).toBe("pending");
    const firstStep = canonicalPlan[0]?.step;
    expect(
      Buffer.byteLength(typeof firstStep === "string" ? firstStep : "", "utf8"),
    ).toBeLessThanOrEqual(512);
    const canonicalMarkdown = persistedNativeInput.markdown;
    expect(
      Buffer.byteLength(typeof canonicalMarkdown === "string" ? canonicalMarkdown : "", "utf8"),
    ).toBeLessThanOrEqual(8 * 1024);
    await harness.notify(
      itemNotification("item/started", { type: "contextCompaction", id: "compact-2" }),
    );
    await harness.notify(
      itemNotification("item/completed", { type: "contextCompaction", id: "compact-2" }),
    );
    planRestoreRequests = harness.requests.filter(
      (request) => request.method === "thread/inject_items",
    );
    expect(planRestoreRequests).toHaveLength(2);
    expect(planRestoreRequests[1]?.params).toMatchObject({
      items: [
        {
          content: [
            {
              text: expect.stringContaining('"markdown":"mmm'),
            },
          ],
        },
      ],
    });

    const noteResponse = await harness.handleServerRequest({
      id: "request-plan-note",
      method: "item/tool/call",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        callId: "call-plan-note",
        namespace: null,
        tool: "progress_card",
        arguments: {
          markdown:
            '<progress aria-label="private" value="1" max="2"></progress>\n\n**Working** [results](https://example.com "<script>").',
        },
      },
    });
    expect(noteResponse).toMatchObject({ success: true });
    expect(onAgentEvent).toHaveBeenCalledWith({
      stream: "plan",
      data: {
        phase: "update",
        title: "Plan updated",
        source: "openclaw",
        explanation: "Working results.",
        explanationFormat: "plain",
        steps: [],
      },
    });

    const clearResponse = await harness.handleServerRequest({
      id: "request-plan-clear",
      method: "item/tool/call",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        callId: "call-plan-clear",
        namespace: null,
        tool: "progress_card",
        arguments: {},
      },
    });
    expect(clearResponse).toMatchObject({ success: true });
    expect(executeProgressCard).toHaveBeenCalledTimes(4);
    expect(onAgentEvent).toHaveBeenCalledWith({
      stream: "plan",
      data: {
        phase: "update",
        title: "Plan updated",
        source: "openclaw",
        steps: [],
      },
    });
    await harness.notify(
      itemNotification("item/started", { type: "contextCompaction", id: "compact-3" }),
    );
    await harness.notify(
      itemNotification("item/completed", { type: "contextCompaction", id: "compact-3" }),
    );
    expect(
      harness.requests.filter((request) => request.method === "thread/inject_items"),
    ).toHaveLength(2);

    await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    const result = await run;
    expect(result.terminal).toEqual({ kind: "ok" });
    expect(persistedProgressCardInputs[0]).toEqual({ markdown: "Plan restored", plan });
    expect(result.messagesSnapshot).toContainEqual(
      expect.objectContaining({
        role: "toolResult",
        toolName: "progress_card",
        isError: false,
      }),
    );
    expect(
      result.messagesSnapshot.some((message) => readMirrorIdentity(message) === "turn-1:plan"),
    ).toBe(false);
    expect(JSON.stringify(result.messagesSnapshot)).not.toContain("Codex plan:");
  });

  it.each(["authorized"])(
    "keeps private native history out of prompt acquisition and clones (%s)",
    async (kind) => {
      const marker = "synthetic-native-payload:";
      const privateText = marker + "x".repeat(1024 * 1024);
      const hook = vi.fn(() => ({ prependContext: "hook context" }));
      initializeGlobalHookRunner(
        createMockPluginRegistry(
          kind === "none"
            ? []
            : [
                {
                  hookName:
                    kind === "heartbeat" ? "heartbeat_prompt_contribution" : "before_prompt_build",
                  ...(kind === "authorized" ? { requiresToolAuthority: true as const } : {}),
                  handler: hook,
                },
              ],
        ),
      );
      const { sessionFile, workspaceDir } = createRunPaths();
      const params = createParams(sessionFile, workspaceDir);
      await attachSqliteSessionTarget(params, path.join(tempDir, "memory.sqlite"), "session-1");
      await appendSqliteHistoryMessage(params, {
        ...userMessage("previous visible request", 1),
        __openclaw: { upstreamUserText: privateText },
      } as ReturnType<typeof userMessage>);
      const originalParse = JSON.parse;
      let privateParseBytes = 0;
      const parseSpy = vi.spyOn(JSON, "parse").mockImplementation((text, reviver) => {
        if (typeof text === "string" && text.includes(marker)) {
          privateParseBytes += text.length;
        }
        return originalParse(text, reviver);
      });
      const originalClone = structuredClone;
      let historyClones = 0;
      let privateCloneBytes = 0;
      const cloneSpy = vi
        .spyOn(globalThis, "structuredClone")
        .mockImplementation((value, options) => {
          const seen = new WeakSet<object>();
          const visit = (node: unknown): void => {
            if (typeof node === "string" && node.startsWith(marker)) {
              privateCloneBytes += node.length;
            }
            if (!node || typeof node !== "object" || seen.has(node)) {
              return;
            }
            seen.add(node);
            if (
              "role" in node &&
              node.role === "user" &&
              "content" in node &&
              Array.isArray(node.content) &&
              node.content[0]?.text === "previous visible request"
            ) {
              historyClones += 1;
            }
            for (const child of Object.values(node)) {
              visit(child);
            }
          };
          visit(value);
          return originalClone(value, options);
        });
      try {
        const harness = createStartedThreadHarness();
        if (kind === "heartbeat") {
          params.trigger = "heartbeat";
        }
        if (kind === "authorized") {
          params.toolAuthorityFingerprint = "synthetic-authority";
        }
        const run = runCodexAppServerAttempt(params);
        await harness.waitForMethod("turn/start");
        await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
        await run;
        expect(privateParseBytes).toBe(0);
        expect(privateCloneBytes).toBe(0);
        if (kind === "none" || kind === "heartbeat") {
          expect(historyClones).toBe(0);
        } else {
          expect(historyClones).toBeGreaterThan(0);
        }
        if (kind !== "none") {
          expect(hook).toHaveBeenCalled();
        }
      } finally {
        parseSpy.mockRestore();
        cloneSpy.mockRestore();
      }
    },
  );

  it.each([
    {
      channel: "whatsapp",
      currentChannelId: "whatsapp:chat-wa",
      expectedChatId: "chat-wa",
    },
  ])(
    "provides authenticated $channel context to before_prompt_build",
    async ({ channel, currentChannelId, expectedChatId }) => {
      const beforePromptBuild = vi.fn(() => undefined);
      initializeGlobalHookRunner(
        createMockPluginRegistry([{ hookName: "before_prompt_build", handler: beforePromptBuild }]),
      );
      const { sessionFile, workspaceDir } = createRunPaths();
      const harness = createStartedThreadHarness();
      const params = createParams(sessionFile, workspaceDir);
      params.messageChannel = channel;
      params.messageProvider = channel;
      params.currentChannelId = currentChannelId;
      params.messageTo = currentChannelId;
      params.agentAccountId = "account-a";
      params.senderId = `sender-${channel}`;
      params.channelContext = {
        sender: { id: "stale-sender", profile: `${channel}-profile` },
        chat: { id: "stale-chat", thread: `${channel}-thread` },
      };

      const run = runCodexAppServerAttempt(params);
      await harness.waitForMethod("turn/start");
      await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
      await run;

      const [, hookContext] = mockCall(beforePromptBuild, "before_prompt_build") as [
        unknown,
        {
          accountId?: string;
          channel?: string;
          channelContext?: {
            chat?: { id?: string; thread?: string };
            sender?: { id?: string; profile?: string };
          };
          channelId?: string;
          chatId?: string;
          messageProvider?: string;
          senderId?: string;
        },
      ];
      expect(hookContext).toMatchObject({
        accountId: "account-a",
        channel,
        messageProvider: channel,
        channelId: expectedChatId,
        chatId: expectedChatId,
        senderId: `sender-${channel}`,
        channelContext: {
          sender: { id: `sender-${channel}`, profile: `${channel}-profile` },
          chat: { id: expectedChatId, thread: `${channel}-thread` },
        },
      });
    },
  );

  it("fails closed when before_prompt_build restricts Codex tools", async () => {
    const authorizedEnrichment = vi.fn(() => ({ prependContext: "private recalled context" }));
    initializeGlobalHookRunner(
      createMockPluginRegistry([
        {
          hookName: "before_prompt_build",
          handler: () => ({ toolsAllow: ["message"] }),
        },
        {
          hookName: "before_prompt_build",
          handler: authorizedEnrichment,
          requiresToolAuthority: true,
        },
      ]),
    );
    const { sessionFile, workspaceDir } = createRunPaths();
    const params = createParams(sessionFile, workspaceDir);
    params.toolAuthorityFingerprint = "restrictive-turn-authority";

    await expect(runCodexAppServerAttempt(params)).rejects.toThrow(
      "Codex app-server cannot enforce before_prompt_build toolsAllow",
    );
    expect(authorizedEnrichment).not.toHaveBeenCalled();
  });

  it("releases adopted startup resources when continuity prompt rebuilding fails", async () => {
    let promptBuildCount = 0;
    const beforePromptBuild = vi.fn(async () => {
      promptBuildCount += 1;
      return { toolsAllow: promptBuildCount === 1 ? ["*"] : ["message"] };
    });
    initializeGlobalHookRunner(
      createMockPluginRegistry([{ hookName: "before_prompt_build", handler: beforePromptBuild }]),
    );
    const { sessionFile, workspaceDir } = createRunPaths();
    openRunSession(sessionFile).appendMessage(userMessage("previous request", Date.now()));
    const { closeAndWait, events, retireSpy, state } = installCleanupTrackingClient();
    const abortController = new AbortController();
    const removeAbortListener = vi.spyOn(abortController.signal, "removeEventListener");
    const params = createParams(sessionFile, workspaceDir);
    params.abortSignal = abortController.signal;
    params.cleanupBundleMcpOnRunEnd = true;

    await expect(runCodexAppServerAttempt(params)).rejects.toThrow(
      "Codex app-server cannot enforce before_prompt_build toolsAllow",
    );

    expect(beforePromptBuild).toHaveBeenCalledTimes(2);
    expect(events).toContain("request:thread/start");
    expect(events).not.toContain("request:turn/start");
    expect(retireSpy).toHaveBeenCalledOnce();
    expect(retireSpy).toHaveBeenCalledWith(state.client);
    expect(closeAndWait).toHaveBeenCalledOnce();
    expect(removeAbortListener).toHaveBeenCalledWith("abort", expect.any(Function));
  });

  it("preserves binding retention errors while releasing fundamental resources", async () => {
    const bindingStore = createCodexTestBindingStore();
    const originalWithLease = bindingStore.withLease.bind(bindingStore);
    const { sessionFile, workspaceDir } = createRunPaths();
    const params = createParams(sessionFile, workspaceDir);
    let failBindingRetention = false;
    let bindingCleanupFailures = 0;
    const failingBindingStore: typeof bindingStore = {
      ...bindingStore,
      async withLease<T>(
        identity: CodexAppServerBindingIdentity,
        run: () => Promise<T>,
      ): Promise<T> {
        if (!failBindingRetention) {
          return await originalWithLease(identity, run);
        }
        bindingCleanupFailures += 1;
        params.cleanupBundleMcpOnRunEnd = true;
        throw new Error("binding retention cleanup failed");
      },
    };
    const { closeAndWait, events, retireSpy, state, waitForTurnStart } =
      installCleanupTrackingClient();
    const abortController = new AbortController();
    const removeAbortListener = vi.spyOn(abortController.signal, "removeEventListener");
    params.abortSignal = abortController.signal;
    const run = runCodexAppServerAttempt(params, { bindingStore: failingBindingStore });
    await waitForTurnStart(run);
    failBindingRetention = true;
    if (!state.notify) {
      throw new Error("expected turn notification handler");
    }
    await state.notify(turnCompleted({ id: "turn-1", status: "completed" }));

    await expect(run).rejects.toThrow("binding retention cleanup failed");

    expect(bindingCleanupFailures).toBe(1);
    expect(params.cleanupBundleMcpOnRunEnd).toBe(true);
    expect(events).toContain("request:turn/start");
    expect(events).toContain("closeAndWait");
    expect(retireSpy).toHaveBeenCalledOnce();
    expect(retireSpy).toHaveBeenCalledWith(state.client);
    expect(closeAndWait).toHaveBeenCalledOnce();
    expect(removeAbortListener).toHaveBeenCalledWith("abort", expect.any(Function));
    expect(queueActiveRunMessageForTest("session-1", "after cleanup")).toBe(false);
  });

  it.each([
    { kind: "hidden child", node: "subagent:fork-proof", via: "spawn", fork: true, preserve: true },

    {
      kind: "skipped fork",
      node: "subagent:fork-proof",
      via: "spawn",
      fork: false,
      preserve: false,
    },
    {
      kind: "unrelated parent",
      node: "subagent:fork-proof",
      via: "spawn",
      fork: true,
      preserve: false,
    },
    {
      kind: "operator fork",
      node: "dashboard:fork-proof",
      via: "operator",
      fork: true,
      preserve: false,
    },
  ] as const)(
    "scopes fresh-thread tool evidence to recorded spawn forks ($kind)",
    async ({ kind, node, via, fork, preserve }) => {
      const sessionKey = `agent:main:${node}`;
      const storePath = path.join(tempDir, "fork-proof.sqlite");
      const params = createParams(sessionKey, path.join(tempDir, "fork-proof-workspace"));
      params.sessionId = node;
      params.sessionKey = sessionKey;
      params.sessionTarget = { agentId: "main", sessionKey, sessionId: node, storePath };
      const parentSessionKey = "agent:main:parent-proof";
      await upsertSessionEntry({
        agentId: "main",
        sessionKey,
        storePath,
        entry: {
          sessionId: node,
          sessionFile: sessionKey,
          createdVia: via,
          parentSessionKey,
          forkedFromParent: true,
          ...(fork
            ? {
                forkSource: {
                  sessionKey:
                    kind === "unrelated parent" ? "agent:main:other-parent" : parentSessionKey,
                  sessionId: "parent-proof",
                },
              }
            : {}),
          updatedAt: Date.now(),
        },
      });
      SessionManager.open({
        agentId: "main",
        sessionKey,
        sessionId: node,
        storePath,
      }).appendMessage(
        userMessage("Inspect the completed tool evidence, then delegate analysis.", 1),
      );
      const prior = new CodexAppServerEventProjector(params, "parent-thread", "parent-turn");
      prior.recordDynamicToolCall({
        callId: "fork-proof-tool",
        tool: "read",
        arguments: { path: "private-input-fixture.txt" },
      });
      prior.recordDynamicToolResult({
        callId: "fork-proof-tool",
        tool: "read",
        success: true,
        terminalType: "completed",
        contentItems: [
          {
            type: "inputText",
            text: "The synthetic result code is COBALT-ORCHID-7429.\nOPENAI_API_KEY=sk-1234567890abcdef",
          },
        ],
      });
      await prior.transcriptCheckpoint.flush(true);
      params.prompt =
        "[Subagent Task]\nReport the synthetic result code from inherited completed tool evidence.";
      const harness = createStartedThreadHarness();
      const run = runCodexAppServerAttempt(params);
      await harness.waitForMethod("turn/start");
      await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
      await run;

      const turnStart = harness.requests.find((request) => request.method === "turn/start");
      const inputText = JSON.stringify(turnStart?.params);
      expect(inputText).toContain("Inspect the completed tool evidence, then delegate analysis.");
      expect(inputText).toContain("[Subagent Task]");
      expect(inputText).not.toContain("private-input-fixture.txt");
      expect(inputText).not.toContain("sk-1234567890abcdef");
      if (preserve) {
        expect(inputText).toContain("COBALT-ORCHID-7429");
        expect(inputText).not.toContain("[content omitted]");
      } else {
        expect(inputText).not.toContain("COBALT-ORCHID-7429");
        expect(inputText).toContain("[content omitted]");
      }
    },
  );
  it("projects the canonical SQLite branch summary without a native thread binding", async () => {
    const sessionId = "session-sqlite-fresh-continuity";
    const sessionFile = `agent:main:${sessionId}`;
    const storePath = path.join(tempDir, "sqlite-fresh-continuity.sqlite");
    const workspaceDir = path.join(tempDir, "workspace-sqlite-fresh-continuity");
    const params = createParams(sessionFile, workspaceDir);
    await attachSqliteSessionTarget(params, storePath, sessionId);
    const target = {
      agentId: "main",
      sessionId,
      sessionKey: `agent:main:${sessionId}`,
      storePath,
    };
    const sessionManager = SessionManager.open(target, workspaceDir);
    const summary = "The durable code is summary-only-code-7429.";
    sessionManager.appendMessage(userMessage("discarded seed question", Date.now()));
    sessionManager.appendMessage(assistantMessage("discarded seed ACK", Date.now() + 1));
    sessionManager.resetLeaf();
    sessionManager.branchWithSummary(null, summary);
    await sessionManager.appendThinkingLevelChange("off");
    expect(
      SessionManager.openModelContext(target)
        .buildSessionContext()
        .messages.map((message) => message.role),
    ).toEqual(["branchSummary"]);
    params.prompt = "Recall the durable code from our prior work.";
    const harness = createStartedThreadHarness();

    const run = runCodexAppServerAttempt(params);
    await harness.waitForMethod("turn/start");
    await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    await run;

    const turnStart = harness.requests.find((request) => request.method === "turn/start");
    const inputText =
      (turnStart?.params as { input?: Array<{ text?: string }> } | undefined)?.input?.[0]?.text ??
      "";
    expect(harness.requests.map((request) => request.method)).toContain("thread/start");
    expect(inputText).toContain("OpenClaw assembled context for this turn:");
    expect(inputText).toContain(`[branchSummary]\n${summary}`);
    expect(inputText).not.toContain("discarded seed");
    expect(inputText).toContain(
      `</conversation_context>\n\nCurrent user request:\n${params.prompt}`,
    );
  });

  it("keeps thread-start developer instructions stable when adding fresh-thread continuity", async () => {
    let hookCalls = 0;
    type HookInputForTest = {
      messages?: Array<{ content?: Array<{ text?: string; type?: string }>; role?: string }>;
    };
    const beforePromptBuild = vi.fn(async (event: unknown) => {
      hookCalls += 1;
      (event as HookInputForTest).messages?.push({
        role: "assistant",
        content: [{ type: "text", text: `hook-side mutation ${hookCalls}` }],
      });
      return {
        systemPrompt: `custom codex system ${hookCalls}`,
        prependContext: `queued context ${hookCalls}`,
      };
    });
    initializeGlobalHookRunner(
      createMockPluginRegistry([{ hookName: "before_prompt_build", handler: beforePromptBuild }]),
    );
    const { sessionFile, workspaceDir } = createRunPaths();
    const sessionManager = openRunSession(sessionFile);
    sessionManager.appendMessage(userMessage("prior visible context", Date.now()));
    sessionManager.appendMessage(assistantMessage("prior assistant context", Date.now() + 1));
    const harness = createStartedThreadHarness();
    const run = runCodexAppServerAttempt(createParams(sessionFile, workspaceDir));
    await harness.waitForMethod("turn/start");
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    await run;
    expect(beforePromptBuild).toHaveBeenCalledTimes(2);
    const [, secondHookInput] = beforePromptBuild.mock.calls.map(
      ([event]) => event as HookInputForTest,
    );
    const secondHookMessageTexts =
      secondHookInput?.messages?.flatMap(
        (message) => message.content?.map((part) => part.text ?? "") ?? [],
      ) ?? [];
    expect(secondHookMessageTexts).toContain("prior visible context");
    expect(secondHookMessageTexts).toContain("prior assistant context");
    expect(secondHookMessageTexts).not.toContain("hook-side mutation 1");
    const threadStart = harness.requests.find((request) => request.method === "thread/start");
    const threadStartParams = threadStart?.params as { developerInstructions?: string } | undefined;
    expect(threadStartParams?.developerInstructions).toContain("custom codex system 1");
    expect(threadStartParams?.developerInstructions).not.toContain("custom codex system 2");
    const turnStart = harness.requests.find((request) => request.method === "turn/start");
    const inputText =
      (turnStart?.params as { input?: Array<{ text?: string }> } | undefined)?.input?.[0]?.text ??
      "";
    expect(inputText).toContain("queued context");
    expect(inputText).toContain("prior visible context");
    expect(inputText).not.toContain("hook-side mutation");
  });

  it("keeps resumed native web-search outcomes unknown without raw events", async () => {
    const { sessionFile, workspaceDir } = createRunPaths();
    await writeExistingBinding(sessionFile, workspaceDir, { dynamicToolsFingerprint: "[]" });
    const harness = createResumeHarness();
    const diagnosticEvents: DiagnosticEventPayload[] = [];
    const stopDiagnostics = onInternalDiagnosticEvent((event) => {
      if ("toolCallId" in event && event.toolCallId === "resumed-search") {
        diagnosticEvents.push(event);
      }
    });
    try {
      const run = runCodexAppServerAttempt(createParams(sessionFile, workspaceDir));
      await harness.waitForMethod("turn/start");
      const item = {
        id: "resumed-search",
        type: "webSearch",
        query: "sensitive resumed query",
        action: { type: "search", query: "sensitive resumed query", queries: null },
      };
      await harness.notify({
        method: "item/started",
        params: { threadId: "thread-existing", turnId: "turn-1", item },
      });
      await harness.notify({
        method: "item/completed",
        params: { threadId: "thread-existing", turnId: "turn-1", item },
      });
      await harness.completeTurn({ threadId: "thread-existing", turnId: "turn-1" });
      await run;
      await waitForDiagnosticEventsDrained();
    } finally {
      stopDiagnostics();
    }
    expect(diagnosticEvents.map((event) => event.type)).toEqual([
      "tool.execution.started",
      "tool.execution.error",
    ]);
    expect(diagnosticEvents.at(-1)).toMatchObject({
      terminalReason: "failed",
      errorCode: "tool_outcome_unknown",
    });
    expect(JSON.stringify(diagnosticEvents)).not.toContain("sensitive resumed query");
  });

  it("uses retained raw web-search status on resumed threads", async () => {
    const { sessionFile, workspaceDir } = createRunPaths();
    await writeExistingBinding(sessionFile, workspaceDir, { dynamicToolsFingerprint: "[]" });
    const harness = createResumeHarness();
    const diagnosticEvents: DiagnosticEventPayload[] = [];
    const stopDiagnostics = onInternalDiagnosticEvent((event) => {
      if ("toolCallId" in event && event.toolCallId === "resumed-search-with-raw") {
        diagnosticEvents.push(event);
      }
    });
    try {
      const run = runCodexAppServerAttempt(createParams(sessionFile, workspaceDir));
      await harness.waitForMethod("turn/start");
      const item = {
        id: "resumed-search-with-raw",
        type: "webSearch",
        query: "sensitive warm-resume query",
        action: { type: "search", query: "sensitive warm-resume query", queries: null },
      };
      await harness.notify({
        method: "item/started",
        params: { threadId: "thread-existing", turnId: "turn-1", item },
      });
      await harness.notify({
        method: "item/completed",
        params: { threadId: "thread-existing", turnId: "turn-1", item },
      });
      await harness.notify({
        method: "rawResponseItem/completed",
        params: {
          threadId: "thread-existing",
          turnId: "turn-1",
          item: {
            id: item.id,
            type: "web_search_call",
            status: "completed",
            action: item.action,
          },
        },
      });
      await harness.completeTurn({ threadId: "thread-existing", turnId: "turn-1" });
      await run;
      await waitForDiagnosticEventsDrained();
    } finally {
      stopDiagnostics();
    }
    expect(diagnosticEvents.map((event) => event.type)).toEqual([
      "tool.execution.started",
      "tool.execution.completed",
    ]);
    expect(JSON.stringify(diagnosticEvents)).not.toContain("sensitive warm-resume query");
  });

  it("projects only newer visible history when a resumed Codex binding is stale", async () => {
    const { sessionFile, workspaceDir } = createRunPaths();
    await writeExistingBinding(sessionFile, workspaceDir, { dynamicToolsFingerprint: "[]" });
    const binding = await readCodexAppServerBinding(sessionFile);
    const bindingUpdatedAt = Date.parse(binding?.historyCoveredThrough ?? "");
    if (!Number.isFinite(bindingUpdatedAt)) {
      throw new Error("expected valid Codex binding timestamp");
    }
    const sessionManager = openRunSession(sessionFile);
    sessionManager.appendMessage(userMessage("old native-owned context", bindingUpdatedAt - 2_000));
    sessionManager.appendMessage(
      userMessage("we were discussing the Sonnet leak screenshots", bindingUpdatedAt + 1_000),
    );
    sessionManager.appendMessage(
      assistantMessage("David Ondrej was mentioned in that prior thread", bindingUpdatedAt + 2_000),
    );
    const copilotMirrorMessage = {
      ...assistantMessage("copilot mirror context also matters", bindingUpdatedAt + 3_000),
      __openclaw: { mirrorIdentity: "copilot:assistant-1" },
    } as ReturnType<typeof assistantMessage> & { __openclaw: { mirrorIdentity: string } };
    sessionManager.appendMessage(copilotMirrorMessage);
    const harness = createResumeHarness();
    const params = createParams(sessionFile, workspaceDir);
    params.prompt = "is the previous message trustworthy?";
    const run = runCodexAppServerAttempt(params);
    await harness.waitForMethod("turn/start");
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    await harness.completeTurn({ threadId: "thread-existing", turnId: "turn-1" });
    await run;
    expect(harness.requests.map((request) => request.method)).toContain("thread/resume");
    const turnStart = harness.requests.find((request) => request.method === "turn/start");
    const inputText =
      (turnStart?.params as { input?: Array<{ text?: string }> } | undefined)?.input?.[0]?.text ??
      "";
    expect(inputText).toContain("OpenClaw assembled context for this turn:");
    expect(inputText).not.toContain("old native-owned context");
    expect(inputText).toContain("we were discussing the Sonnet leak screenshots");
    expect(inputText).toContain("David Ondrej was mentioned in that prior thread");
    expect(inputText).toContain("copilot mirror context also matters");
    expect(inputText).toContain("Current user request:");
    expect(inputText).toContain("is the previous message trustworthy?");
  });
  it("sizes stale-binding resume continuity from the session's recorded density", async () => {
    const { sessionFile, workspaceDir } = createRunPaths();
    await writeExistingBinding(sessionFile, workspaceDir, {
      dynamicToolsFingerprint: "[]",
      // A dense session: 1 char/token observed on the previous completed turn.
      continuityCalibration: { promptChars: 200_000, inputTokens: 200_000 },
    });
    const binding = await readCodexAppServerBinding(sessionFile);
    const bindingUpdatedAt = Date.parse(binding?.historyCoveredThrough ?? "");
    if (!Number.isFinite(bindingUpdatedAt)) {
      throw new Error("expected valid Codex binding timestamp");
    }
    const sessionManager = openRunSession(sessionFile);
    for (let index = 0; index < 12; index += 1) {
      sessionManager.appendMessage(
        assistantMessage(
          `calibrated delta block ${index}: ${"x".repeat(128_000)}`,
          bindingUpdatedAt + 1_000 + index,
        ),
      );
    }
    sessionManager.appendMessage(
      assistantMessage("calibrated recent anchor: continue the audit", bindingUpdatedAt + 2_000),
    );
    const harness = createResumeHarness();
    const params = createParams(sessionFile, workspaceDir);
    params.contextTokenBudget = 300_000;
    params.prompt = "continue after the dense resume";
    const run = runCodexAppServerAttempt(params);
    await harness.waitForMethod("turn/start");
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    await harness.completeTurn({ threadId: "thread-existing", turnId: "turn-1" });
    await run;
    const turnStart = harness.requests.find((request) => request.method === "turn/start");
    const inputText =
      (turnStart?.params as { input?: Array<{ text?: string }> } | undefined)?.input?.[0]?.text ??
      "";
    // At 1 char/token the cap collapses to the reserved token budget itself:
    // (300k − 150k) × 1 = 150,000 chars, plus header/request overhead.
    expect(inputText.length).toBeLessThanOrEqual(160_000);
    expect(inputText).toContain("calibrated recent anchor: continue the audit");
    expect(inputText).not.toContain("calibrated delta block 0:");
  });
  it("calibrates continuity from the latest response while retaining whole-turn usage", async () => {
    const { sessionFile, workspaceDir } = createRunPaths();
    const sessionManager = openRunSession(sessionFile);
    for (let index = 0; index < 12; index += 1) {
      sessionManager.appendMessage(
        assistantMessage(`density block ${index}: ${"x".repeat(128_000)}`, Date.now() + 1 + index),
      );
    }
    sessionManager.appendMessage(
      userMessage("density anchor: keep going with the migration", Date.now() + 20),
    );
    const harness = createStartedThreadHarness();
    const params = createParams(sessionFile, workspaceDir);
    params.contextTokenBudget = 300_000;
    params.prompt = "record this turn's density";
    const run = runCodexAppServerAttempt(params);
    await harness.waitForMethod("turn/start");
    for (const inputTokens of [140_000, 150_000]) {
      await harness.notify({
        method: "rawResponse/completed",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          responseId: `response-${inputTokens}`,
          usage: {
            totalTokens: inputTokens + 2_000,
            inputTokens,
            cachedInputTokens: 40_000,
            cacheWriteInputTokens: 10_000,
            outputTokens: 2_000,
            reasoningOutputTokens: 0,
          },
        },
      });
    }
    await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    expect((await run).attemptUsage?.total).toBe(294_000);
    const turnStart = harness.requests.find((request) => request.method === "turn/start");
    const inputText =
      (turnStart?.params as { input?: Array<{ text?: string }> } | undefined)?.input?.[0]?.text ??
      "";
    const binding = await readCodexAppServerBinding(sessionFile);
    // Density uses the latest full prompt, including cached input, not cumulative billing.
    expect(binding?.continuityCalibration).toEqual({
      promptChars: inputText.length,
      inputTokens: 150_000,
    });
  });
  it("does not record calibration from a large direct prompt with no continuity projection", async () => {
    const { sessionFile, workspaceDir } = createRunPaths();
    const harness = createStartedThreadHarness();
    const params = createParams(sessionFile, workspaceDir);
    params.contextTokenBudget = 300_000;
    // A dense direct paste, large enough to pass the calibration size floor, on a
    // session with no history to project: the sample must NOT be recorded, or its
    // density would later shrink continuity history it never measured.
    params.prompt = `dense direct paste: ${"y".repeat(80_000)}`;
    const run = runCodexAppServerAttempt(params);
    await harness.waitForMethod("turn/start");
    await harness.notify({
      method: "thread/tokenUsage/updated",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        tokenUsage: {
          last: {
            totalTokens: 162_000,
            inputTokens: 160_000,
            cachedInputTokens: 0,
            cacheWriteInputTokens: 0,
            outputTokens: 2_000,
            reasoningOutputTokens: 0,
          },
        },
      },
    });
    await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    await run;
    const binding = await readCodexAppServerBinding(sessionFile);
    expect(binding?.threadId).toBe("thread-1");
    expect(binding?.continuityCalibration).toBeUndefined();
  });

  it("does not project mirrored messages on consecutive resumes", async () => {
    const { sessionFile, workspaceDir } = createRunPaths();
    await writeExistingBinding(sessionFile, workspaceDir, { dynamicToolsFingerprint: "[]" });
    const oldBindingUpdatedAt = Date.now() - 60_000;
    const oldBinding = await readCodexAppServerBinding(sessionFile);
    if (!oldBinding) {
      throw new Error("expected Codex binding");
    }
    await writeCodexAppServerBinding(sessionFile, {
      ...oldBinding,
      historyCoveredThrough: new Date(oldBindingUpdatedAt).toISOString(),
    });
    const sessionManager = openRunSession(sessionFile);
    sessionManager.appendMessage(
      userMessage("we were discussing the Sonnet leak screenshots", oldBindingUpdatedAt + 1_000),
    );
    sessionManager.appendMessage(
      assistantMessage(
        "David Ondrej was mentioned in that prior thread",
        oldBindingUpdatedAt + 2_000,
      ),
    );
    const firstHarness = createResumeHarness();
    const firstParams = createParams(sessionFile, workspaceDir);
    firstParams.prompt = "is the previous message trustworthy?";
    const firstRun = runCodexAppServerAttempt(firstParams);
    await firstHarness.waitForMethod("turn/start");
    await firstHarness.completeTurn({ threadId: "thread-existing", turnId: "turn-1" });
    await firstRun;
    const firstTurnStart = firstHarness.requests.find((request) => request.method === "turn/start");
    const firstInputText =
      (firstTurnStart?.params as { input?: Array<{ text?: string }> } | undefined)?.input?.[0]
        ?.text ?? "";
    expect(firstInputText).toContain("OpenClaw assembled context for this turn:");
    expect(firstInputText).toContain("we were discussing the Sonnet leak screenshots");
    expect(firstInputText).toContain("is the previous message trustworthy?");
    firstHarness.close();
    const secondHarness = createResumeHarness();
    const secondParams = createParams(sessionFile, workspaceDir);
    secondParams.prompt = "continue from there";
    const secondRun = runCodexAppServerAttempt(secondParams);
    await secondHarness.waitForMethod("turn/start");
    await secondHarness.completeTurn({ threadId: "thread-existing", turnId: "turn-1" });
    await secondRun;
    const secondTurnStart = secondHarness.requests.find(
      (request) => request.method === "turn/start",
    );
    const secondInputText =
      (secondTurnStart?.params as { input?: Array<{ text?: string }> } | undefined)?.input?.[0]
        ?.text ?? "";
    expect(secondInputText).not.toContain("OpenClaw assembled context for this turn:");
    expect(secondInputText).not.toContain("we were discussing the Sonnet leak screenshots");
    expect(secondInputText).not.toContain("is the previous message trustworthy?");
    expect(secondInputText).toContain("continue from there");
  });

  registerCodexMemoryInstructionTests();

  it("routes AGENTS.md natively and MEMORY.md through tools", async () => {
    const { sessionFile, workspaceDir } = createRunPaths();
    const agentsGuidance = "Follow AGENTS guidance.";
    const soulGuidance = "Soul voice goes here.";
    const identityGuidance = "Identity guidance goes here.";
    const userProfile = "User profile goes here.";
    const memorySummary = "Memory summary goes here.";
    await fs.mkdir(workspaceDir, { recursive: true });
    await fs.writeFile(path.join(workspaceDir, "AGENTS.md"), agentsGuidance);
    await fs.writeFile(path.join(workspaceDir, "SOUL.md"), soulGuidance);
    await fs.writeFile(path.join(workspaceDir, "IDENTITY.md"), identityGuidance);
    await fs.writeFile(path.join(workspaceDir, "USER.md"), userProfile);
    await fs.writeFile(path.join(workspaceDir, "MEMORY.md"), memorySummary);
    registerMemoryPromptForTest();

    const params = createParams(sessionFile, workspaceDir);
    setCodexTestToolFactory(params, () => [
      createRuntimeDynamicTool("memory_search"),
      createRuntimeDynamicTool("memory_get"),
    ]);
    params.disableTools = false;
    setCodexTestModelSupportsTools(params, true);
    params.runtimePlan = createCodexRuntimePlanFixture();
    setAgentWorkspaceForTest(params, workspaceDir);
    const {
      collaborationInstructions,
      inputText,
      systemPromptReport,
      threadDeveloperInstructions,
    } = await buildCodexTurnContextForTest(params, workspaceDir);
    expect(threadDeveloperInstructions).toContain(soulGuidance);
    expect(threadDeveloperInstructions).toContain(identityGuidance);
    expect(threadDeveloperInstructions).toContain(userProfile);
    expect(threadDeveloperInstructions).not.toContain(memorySummary);
    expect(threadDeveloperInstructions).not.toContain("Codex loads AGENTS.md natively");
    expect(threadDeveloperInstructions).not.toContain(agentsGuidance);
    expect(collaborationInstructions).toBe("");
    expect(threadDeveloperInstructions).toContain("OpenClaw Agent Soul");
    expect(threadDeveloperInstructions).toContain("<AGENT_SOUL>");
    expect(threadDeveloperInstructions).toContain("</AGENT_SOUL>");
    expect(threadDeveloperInstructions).toContain(soulGuidance);
    expect(threadDeveloperInstructions).toContain(identityGuidance);
    expect(threadDeveloperInstructions).toContain(userProfile);
    expect(threadDeveloperInstructions).toContain("## Memory Recall");
    expect(threadDeveloperInstructions).toContain("MEMORY.md + memory/*.md");
    expect(threadDeveloperInstructions).toContain("OpenClaw Workspace Memory");
    expect(threadDeveloperInstructions).toContain(
      "MEMORY.md exists in the active agent workspace as a memory file, not an instruction file",
    );
    expect(threadDeveloperInstructions).toContain("memory_search");
    expect(threadDeveloperInstructions).toContain("memory_get");
    expect(threadDeveloperInstructions).toContain(
      "When the memory guidance above calls for memory recall, use an already-loaded memory tool directly.",
    );
    expect(threadDeveloperInstructions).toContain(
      "If the needed memory tool is deferred and not currently callable, use `tool_search` to load it, then call that memory tool.",
    );
    expect(threadDeveloperInstructions).not.toContain(memorySummary);
    expect(inputText).toBe("hello");
    expect(systemPromptReport.systemPrompt.chars).toBe(threadDeveloperInstructions.length);
    const fileStats = new Map(
      systemPromptReport.injectedWorkspaceFiles.map((file) => [file.name, file]),
    );
    expect(fileStats.get("SOUL.md")).toMatchObject({
      rawChars: soulGuidance.length,
      injectedChars: soulGuidance.length,
      truncated: false,
    });
    expect(fileStats.get("IDENTITY.md")).toMatchObject({
      rawChars: identityGuidance.length,
      injectedChars: identityGuidance.length,
      truncated: false,
    });
    expect(fileStats.get("USER.md")).toMatchObject({
      rawChars: userProfile.length,
      injectedChars: userProfile.length,
      truncated: false,
    });
    expect(fileStats.get("MEMORY.md")).toMatchObject({
      rawChars: memorySummary.length,
      injectedChars: 0,
      truncated: false,
    });
    expect(fileStats.get("AGENTS.md")).toMatchObject({
      rawChars: agentsGuidance.length,
      injectionStatus: "native_unverified",
      injectedChars: null,
      truncated: null,
    });
  });

  it.each([
    "compacted",

    "unsubscribed",
    "compacted during acceptance",
    "dropped by fitting",
  ] as const)(
    "introduces bounded workspace references once per native thread need: %s",
    async (scenario) => {
      const { sessionFile, workspaceDir } = createRunPaths();
      const memorySummary = "Memory summary goes here.";
      const bootstrap = "Bootstrap reference goes here.";
      await fs.mkdir(workspaceDir, { recursive: true });
      await fs.writeFile(path.join(workspaceDir, "MEMORY.md"), memorySummary);
      await fs.writeFile(path.join(workspaceDir, "BOOTSTRAP.md"), bootstrap);
      let oversizedPrefix = scenario === "dropped by fitting";
      if (oversizedPrefix) {
        openRunSession(sessionFile).appendMessage(userMessage("Earlier conversation", Date.now()));
        initializeGlobalHookRunner(
          createMockPluginRegistry([
            {
              hookName: "before_prompt_build",
              handler: () => ({ prependContext: oversizedPrefix ? "p".repeat(1 << 20) : "" }),
            },
          ]),
        );
      }
      let compactDuringAcceptance = false;
      let turnRequested = createDeferred<void>();
      const harness = createStartedThreadHarness(
        async (method) => {
          if (method === "turn/start" && compactDuringAcceptance) {
            compactDuringAcceptance = false;
            await harness.notify(
              itemNotification("item/completed", {
                type: "contextCompaction",
                id: "compact-during-start",
              }),
            );
          }
          if (method === "turn/start") {
            turnRequested.resolve();
          }
          return method === "thread/resume" ? threadStartResult("thread-1") : undefined;
        },
        { persistedThreads: [] },
      );
      const runTurn = async () => {
        const offset = harness.requests.length;
        const params = createParams(sessionFile, workspaceDir);
        const compiledPrompts: Array<string | undefined> = [];
        params.hostCapabilities = Object.freeze({
          ...params.hostCapabilities,
          trajectory: Object.freeze({
            recordEvent: (type: string, data?: { prompt?: string }) => {
              if (type === "context.compiled") {
                compiledPrompts.push(data?.prompt);
              }
            },
            flush: async () => undefined,
          }),
        });
        turnRequested = createDeferred<void>();
        const run = runCodexAppServerAttempt(params);
        await Promise.race([
          turnRequested.promise,
          run.then(() => {
            throw new Error("Reference attempt ended before turn/start");
          }),
        ]);
        await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
        const result = await run;
        expect(readAttemptTerminal(result)).toMatchObject({
          aborted: false,
          timedOut: false,
          promptError: null,
        });
        const request = harness.requests
          .slice(offset)
          .find(({ method }) => method === "turn/start");
        assert(request, "Expected the reference turn/start request");
        const input = (request.params as { input: Array<{ text?: string }> }).input[0]?.text ?? "";
        expect(compiledPrompts).toEqual([input]);
        return { input, result };
      };
      const first = await runTurn();
      if (oversizedPrefix) {
        expect(first.input.length).toBeLessThanOrEqual(1 << 20);
        expect(first.input).toContain("Earlier conversation");
        expect(first.input).toContain("Current user request:");
        expect(first.input).not.toContain(memorySummary);
        expect(first.input).not.toContain(bootstrap);
      } else {
        expect(first.input).toContain(memorySummary);
        expect(first.input).toContain(bootstrap);
        expect(
          first.result.systemPromptReport?.injectedWorkspaceFiles.find(
            (file) => file.name === "MEMORY.md",
          ),
        ).toMatchObject({
          rawChars: memorySummary.length,
          injectedChars: memorySummary.length,
          truncated: false,
        });
      }
      expect(first.input).not.toContain("memory_search");
      compactDuringAcceptance = scenario === "compacted during acceptance";
      oversizedPrefix = false;
      const second = await runTurn();
      if (scenario === "dropped by fitting") {
        expect(second.input).toContain(memorySummary);
        expect(second.input).toContain(bootstrap);
      } else {
        expect.soft(second.input).not.toContain(memorySummary);
        expect.soft(second.input).not.toContain(bootstrap);
        expect
          .soft(
            second.result.systemPromptReport?.injectedWorkspaceFiles.find(
              (file) => file.name === "MEMORY.md",
            ),
          )
          .toMatchObject({ injectedChars: 0, truncated: false });
      }
      expect(harness.requests.filter(({ method }) => method === "thread/start")).toHaveLength(1);
      expect(harness.requests.filter(({ method }) => method === "thread/resume")).toHaveLength(0);

      const expectedMemory = memorySummary;
      if (scenario === "compacted") {
        // Manual compaction may complete while no attempt projector is attached.
        await harness.notify({
          method: "item/completed",
          params: {
            threadId: "thread-1",
            turnId: "compact-1",
            item: { type: "contextCompaction", id: "compact-item" },
          },
        });
      } else if (scenario === "unsubscribed") {
        await releaseCodexAppServerLiveThread(harness.client, "thread-1");
      }
      const third = await runTurn();
      if (scenario === "dropped by fitting") {
        expect.soft(third.input).not.toContain(expectedMemory);
        expect.soft(third.input).not.toContain(bootstrap);
      } else {
        expect(third.input).toContain(expectedMemory);
        expect(third.input).toContain(bootstrap);
      }
      if (scenario === "unsubscribed") {
        expect(harness.requests.filter(({ method }) => method === "thread/resume")).toHaveLength(1);
      }
      const fourth = await runTurn();
      expect.soft(fourth.input).not.toContain(expectedMemory);
      expect.soft(fourth.input).not.toContain(bootstrap);
    },
  );

  it("reports MEMORY.md as truncated when no-tool fallback exceeds the bootstrap budget", async () => {
    const { sessionFile, workspaceDir } = createRunPaths();
    const soulGuidance = "Soul guidance ".repeat(80);
    const memorySummary = "Memory summary goes here.";
    await fs.mkdir(workspaceDir, { recursive: true });
    await fs.writeFile(path.join(workspaceDir, "SOUL.md"), soulGuidance);
    await fs.writeFile(path.join(workspaceDir, "MEMORY.md"), memorySummary);
    const harness = createStartedThreadHarness();
    const params = createParams(sessionFile, workspaceDir);
    params.config = {
      agents: {
        defaults: {
          bootstrapMaxChars: 1000,
          bootstrapTotalMaxChars: 1000,
        },
      },
    } as EmbeddedRunAttemptParams["config"];
    const run = runCodexAppServerAttempt(params);
    await harness.waitForMethod("turn/start");
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    const result = await run;
    const fileStats = new Map(
      result.systemPromptReport?.injectedWorkspaceFiles.map((file) => [file.name, file]) ?? [],
    );
    expect(fileStats.get("MEMORY.md")).toMatchObject({
      rawChars: memorySummary.length,
      injectedChars: 0,
      truncated: true,
    });
  });

  it("delivers and reports hook-supplied bootstrap files on an external connection", async () => {
    const { sessionFile, workspaceDir } = createRunPaths();
    const soulPath = path.join(workspaceDir, "SOUL.md");
    const soulGuidance = "Hook supplied soul guidance.";
    await fs.mkdir(workspaceDir, { recursive: true });
    registerInternalHook("agent:bootstrap", (event) => {
      const context = event.context as {
        bootstrapFiles: Array<{ content: string; missing: boolean; path: string }>;
      };
      context.bootstrapFiles = [
        {
          path: soulPath,
          content: soulGuidance,
          missing: false,
        },
      ];
    });
    const harness = createStartedThreadHarness();
    const run = runCodexAppServerAttempt(createParams(sessionFile, workspaceDir));
    await harness.waitForMethod("turn/start");
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    const result = await run;
    expect(result.systemPromptReport?.injectedWorkspaceFiles).toEqual([
      expect.objectContaining({
        name: "SOUL.md",
        path: soulPath,
        rawChars: soulGuidance.length,
        missing: false,
        injectedChars: soulGuidance.length,
        truncated: false,
      }),
    ]);
    const threadStart = harness.requests.find((request) => request.method === "thread/start");
    expect(
      (threadStart?.params as { developerInstructions?: string } | undefined)
        ?.developerInstructions,
    ).toContain(soulGuidance);
  });

  it("keeps lightweight cron Codex turns out of OpenClaw bootstrap context", async () => {
    const { sessionFile, workspaceDir } = createRunPaths();
    const exactCommand =
      "Delivery: to send a message, use the `message` tool.\n\ncd /repo && ./scripts/run-cron";
    await fs.mkdir(workspaceDir, { recursive: true });
    await fs.writeFile(path.join(workspaceDir, "AGENTS.md"), "Follow AGENTS guidance.");
    await fs.writeFile(path.join(workspaceDir, "SOUL.md"), "Soul voice goes here.");
    const harness = createStartedThreadHarness();
    const params = createParams(sessionFile, workspaceDir);
    params.trigger = "cron";
    params.prompt = exactCommand;
    params.bootstrapContextMode = "lightweight";
    params.bootstrapContextRunKind = "cron";
    params.skillsSnapshot = {
      prompt: "<available_skills><skill><name>demo</name></skill></available_skills>",
      skills: [],
    };
    const run = runCodexAppServerAttempt(params);
    await harness.waitForMethod("turn/start");
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    const result = await run;
    const threadStart = harness.requests.find((request) => request.method === "thread/start");
    const threadStartParams = threadStart?.params as {
      developerInstructions?: string;
      config?: Record<string, unknown>;
    };
    expect(threadStartParams.config?.project_doc_max_bytes).toBe(0);
    expect(threadStartParams.developerInstructions).not.toContain("Soul voice goes here.");
    expect(threadStartParams.developerInstructions).not.toContain("Follow AGENTS guidance.");
    expect(threadStartParams.developerInstructions).not.toContain("<available_skills>");
    const turnStart = harness.requests.find((request) => request.method === "turn/start");
    const turnStartParams = turnStart?.params as {
      input?: Array<{ text?: string }>;
    };
    expect(turnStartParams.input?.[0]?.text).toBe(exactCommand);
    expect(result.systemPromptReport?.skills).toMatchObject({ promptChars: 0, entries: [] });
    expect(result.systemPromptReport?.skills.hash).toMatch(/^[a-f0-9]{64}$/u);
  });

  registerSettledFinalizationTests({ expectResumeRequest, writeExistingBinding });

  it("keeps full exec Codex yolo when OpenClaw tool policy exists", async () => {
    initializeGlobalHookRunner(
      createMockPluginRegistry([{ hookName: "before_tool_call", handler: vi.fn() }]),
    );
    const params = createRunParams();
    params.config = { tools: { exec: { mode: "full" } } };
    const harness = createStartedThreadHarness();
    const run = runCodexAppServerAttempt(params);
    await completeStartedRun(run, harness.waitForMethod, harness.completeTurn);
    const startParams = harness.requests.find(({ method }) => method === "thread/start")?.params as
      | Record<string, unknown>
      | undefined;
    const turnParams = harness.requests.find(({ method }) => method === "turn/start")?.params as
      | Record<string, unknown>
      | undefined;
    expect(startParams?.approvalPolicy).toBe("never");
    expect(startParams?.sandbox).toBe("danger-full-access");
    expect(turnParams?.approvalPolicy).toBe("never");
    expect(turnParams?.sandboxPolicy).toEqual({ type: "dangerFullAccess" });
  });

  it("preserves a structured provider refusal through attempt finalization", async () => {
    const { sessionFile, workspaceDir } = createRunPaths();
    const harness = createStartedThreadHarness();
    const run = runCodexAppServerAttempt(createParams(sessionFile, workspaceDir));
    await harness.waitForMethod("turn/start");
    const error = {
      message: "This content was flagged for possible biological risk. Try rephrasing it.",
      codexErrorInfo: "other",
    };
    await harness.notify({
      method: "error",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        error,
        willRetry: false,
      },
    });
    await harness.notify(turnCompleted({ id: "turn-1", status: "failed", error }));

    const result = await run;

    expect(result.terminal).toEqual({ kind: "ok" });
    expect(result.currentAttemptAssistant).toMatchObject({
      stopReason: "error",
      errorMessage: error.message,
      diagnostics: [
        {
          type: "provider_refusal",
          details: { provider: "openai", category: "bio" },
        },
      ],
    });
    expect(
      result.messagesSnapshot.filter(
        (message) =>
          message.role === "assistant" &&
          message.diagnostics?.some((diagnostic) => diagnostic.type === "provider_refusal"),
      ),
    ).toHaveLength(1);
  });

  it("forwards Codex app-server verbose tool summaries and completed output", async () => {
    const onToolResult = vi.fn();
    const executeRead = vi.fn(async () => ({
      content: [{ type: "text" as const, text: "file contents" }],
      details: {},
    }));

    const { sessionFile, workspaceDir } = createRunPaths();
    const harness = createStartedThreadHarness();
    const params = createParams(sessionFile, workspaceDir);
    setCodexTestToolFactory(params, (options) => {
      const tools = createOpenClawCodingTools(options).filter((tool) => tool.name === "read");
      for (const tool of tools) {
        tool.execute = executeRead;
      }
      return tools;
    });
    setCodexTestModelSupportsTools(params, true);
    params.runtimePlan = createCodexRuntimePlanFixture();
    params.toolsAllow = ["read"];
    params.verboseLevel = "full";
    params.onToolResult = onToolResult;
    const { run, started } = startClockControlledAttempt(params);
    await started;
    const startParams = harness.requests.find((request) => request.method === "thread/start")
      ?.params as { dynamicTools: CodexDynamicToolSpec[] };
    expect(specNames(startParams.dynamicTools)).toContain("read");
    await harness.notify(
      itemNotification("item/started", {
        type: "dynamicToolCall",
        id: "tool-1",
        namespace: null,
        tool: "read",
        arguments: { path: "README.md" },
        status: "inProgress",
        contentItems: null,
        success: null,
        durationMs: null,
      }),
    );
    expect(onToolResult).not.toHaveBeenCalled();
    const response = await harness.handleServerRequest({
      id: "request-tool-1",
      method: "item/tool/call",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        callId: "tool-1",
        namespace: null,
        tool: "read",
        arguments: { path: "README.md" },
      },
    });
    expect(response).toMatchObject({
      success: true,
      contentItems: [{ type: "inputText", text: "file contents" }],
    });
    expect(executeRead).toHaveBeenCalledOnce();
    await harness.notify(
      itemNotification("item/completed", {
        type: "dynamicToolCall",
        id: "tool-1",
        namespace: null,
        tool: "read",
        arguments: { path: "README.md" },
        status: "completed",
        contentItems: [{ type: "inputText", text: "file contents" }],
        success: true,
        durationMs: 12,
      }),
    );
    await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    const result = await run;
    expect(result.terminal).toEqual({ kind: "ok" });
    expect(onToolResult).toHaveBeenCalledTimes(2);
    expect(onToolResult).toHaveBeenNthCalledWith(1, {
      text: "Read: `from README.md`",
    });
    expect(onToolResult).toHaveBeenNthCalledWith(2, {
      text: "Read\n```txt\nfile contents\n```",
    });
  });

  it("preserves every command failure from official app-server events", async () => {
    const sessionFile = path.join(tempDir, "session-multi-command-failure.jsonl");
    const workspaceDir = path.join(tempDir, "workspace-multi-command-failure");
    const harness = createStartedThreadHarness();
    const run = runCodexAppServerAttempt(createParams(sessionFile, workspaceDir));
    await harness.waitForMethod("turn/start");
    for (const [id, status, exitCode] of [
      ["command-failed-1", "failed", 1],
      ["command-succeeded", "completed", 0],
      ["command-failed-2", "failed", 2],
    ] as const) {
      await harness.notify(
        itemNotification("item/started", {
          type: "commandExecution",
          id,
          command: `/bin/bash -lc 'exit ${exitCode}'`,
          cwd: workspaceDir,
          status: "inProgress",
        }),
      );
      await harness.notify(
        itemNotification("item/completed", {
          type: "commandExecution",
          id,
          command: `/bin/bash -lc 'exit ${exitCode}'`,
          cwd: workspaceDir,
          status,
          aggregatedOutput: "",
          exitCode,
          durationMs: 1,
        }),
      );
    }
    await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    const result = await run;
    expect(result.toolMetas).toHaveLength(3);
    expect(result.toolMetas.filter((meta) => meta.isError === true)).toHaveLength(2);
  });

  it("applies the session permission mode and root to resumed harness turns", async () => {
    const { sessionFile, workspaceDir } = createRunPaths();
    const nestedCwd = path.join(workspaceDir, "packages", "app");
    await fs.mkdir(nestedCwd, { recursive: true });
    await writeExistingBinding(sessionFile, workspaceDir);
    const harness = createResumeHarness();
    const params = createParams(sessionFile, workspaceDir);
    params.cwd = nestedCwd;
    params.permissionMode = "full";
    params.sessionRoot = workspaceDir;
    const run = runCodexAppServerAttempt(params, {
      pluginConfig: { appServer: { mode: "guardian" } },
    });
    await harness.waitForMethod("turn/start");
    await harness.completeTurn({ threadId: "thread-existing", turnId: "turn-1" });
    await run;
    const resumeParams = harness.requests.find((request) => request.method === "thread/resume")
      ?.params as Record<string, unknown> | undefined;
    const turnParams = harness.requests.find((request) => request.method === "turn/start")
      ?.params as Record<string, unknown> | undefined;
    expect(resumeParams?.cwd).toBe(nestedCwd);
    expect(resumeParams?.runtimeWorkspaceRoots).toEqual([workspaceDir]);
    expect(resumeParams?.approvalPolicy).toBe("never");
    expect(resumeParams?.sandbox).toBe("danger-full-access");
    expect(turnParams?.cwd).toBe(nestedCwd);
    expect(turnParams?.runtimeWorkspaceRoots).toEqual([workspaceDir]);
    expect(turnParams?.approvalPolicy).toBe("never");
    expect(turnParams?.sandboxPolicy).toEqual({ type: "dangerFullAccess" });
  });
  it("preserves a healthy binding when invalid image cleanup hits a transient thread", async () => {
    const { sessionFile, workspaceDir } = createRunPaths();
    await writeExistingBinding(sessionFile, workspaceDir, {
      dynamicToolsFingerprint: JSON.stringify([{ name: "message" }]),
    });
    const harness = createStartedThreadHarness(async (method) => {
      if (method === "thread/start") {
        return threadStartResult("thread-transient");
      }
      if (method === "turn/start") {
        throw new Error("invalid image_url base64 payload");
      }
      return undefined;
    });
    await expect(runCodexAppServerAttempt(createParams(sessionFile, workspaceDir))).rejects.toThrow(
      "invalid image_url base64 payload",
    );
    expect(withoutCodexSkillDiscovery(harness.requests.map((request) => request.method))).toEqual([
      "config/read",
      "configRequirements/read",
      "thread/start",
      "turn/start",
      "thread/unsubscribe",
    ]);
    const binding = await readCodexAppServerBinding(sessionFile);
    expect(binding?.threadId).toBe("thread-existing");
  });

  it("preserves a healthy binding when the server rejects unsupported image input", async () => {
    const { sessionFile, workspaceDir } = createRunPaths();
    await writeExistingBinding(sessionFile, workspaceDir, { dynamicToolsFingerprint: "[]" });
    const harness = createResumeHarness("thread-existing", async (method) => {
      if (method === "turn/start") {
        throw new Error("unsupported image input");
      }
      return undefined;
    });
    await expect(runCodexAppServerAttempt(createParams(sessionFile, workspaceDir))).rejects.toThrow(
      "unsupported image input",
    );
    expect(withoutCodexSkillDiscovery(harness.requests.map((request) => request.method))).toEqual([
      "config/read",
      "configRequirements/read",
      "thread/read",
      "thread/resume",
      "thread/inject_items",
      "turn/start",
      "thread/unsubscribe",
    ]);
    const binding = await readCodexAppServerBinding(sessionFile);
    expect(binding?.threadId).toBe("thread-existing");
  });
  it("retries turn/start after a native compact turn finishes", async () => {
    const { sessionFile, workspaceDir } = createRunPaths();
    await writeExistingBinding(sessionFile, workspaceDir, { dynamicToolsFingerprint: "[]" });
    let turnStartCalls = 0;
    const harnessRef: { current?: ReturnType<typeof createAppServerHarness> } = {};
    const harness = createResumeHarness("thread-existing", async (method) => {
      if (method === "turn/start") {
        turnStartCalls += 1;
        if (turnStartCalls === 1) {
          queueMicrotask(() => {
            void harnessRef.current?.notify({
              method: "turn/completed",
              params: {
                threadId: "thread-existing",
                turnId: "compact-turn",
                turn: { id: "compact-turn", status: "completed", items: [] },
              },
            });
          });
          throw new CodexAppServerRpcError(
            {
              message: "cannot steer a compact turn",
              data: {
                message: "cannot steer a compact turn",
                codexErrorInfo: {
                  activeTurnNotSteerable: { turnKind: "compact" },
                },
                additionalDetails: null,
              },
            },
            "turn/start",
          );
        }
        return turnStartResult("turn-1");
      }
      return undefined;
    });
    harnessRef.current = harness;
    const run = runCodexAppServerAttempt(createParams(sessionFile, workspaceDir));
    await vi.waitFor(
      () =>
        expect(harness.requests.filter((request) => request.method === "turn/start")).toHaveLength(
          2,
        ),
      fastWait,
    );
    await harness.completeTurn({ threadId: "thread-existing", turnId: "turn-1" });
    await run;
    expect(withoutCodexSkillDiscovery(harness.requests.map((request) => request.method))).toEqual([
      "config/read",
      "configRequirements/read",
      "thread/read",
      "thread/resume",
      "thread/inject_items",
      "turn/start",
      "turn/start",
    ]);
    await expectRetainedSuccessfulThread(harness.client, "thread-existing");
  });

  it("waits for the exact active native turn before starting a resumed thread turn", async () => {
    const { sessionFile, workspaceDir } = createRunPaths();
    await writeExistingBinding(sessionFile, workspaceDir, { dynamicToolsFingerprint: "[]" });
    const harness = createResumeHarness("thread-existing", async (method) => {
      if (method === "thread/resume") {
        const response = threadStartResult("thread-existing");
        return {
          ...response,
          thread: {
            ...response.thread,
            status: { type: "active", activeFlags: [] },
            turns: [{ id: "compact-turn", status: "inProgress", items: [] }],
          },
        };
      }
      if (method === "turn/start") {
        return turnStartResult("turn-1");
      }
      return undefined;
    });
    const run = runCodexAppServerAttempt(createParams(sessionFile, workspaceDir));
    await harness.waitForMethod("thread/resume");
    await new Promise((resolve) => {
      setTimeout(resolve, 20);
    });
    expect(harness.requests.map((request) => request.method)).not.toContain("turn/start");
    await harness.notify({
      method: "turn/completed",
      params: {
        threadId: "thread-existing",
        turn: { id: "stale-turn", status: "completed", items: [] },
      },
    });
    expect(harness.requests.map((request) => request.method)).not.toContain("turn/start");
    await harness.notify({
      method: "error",
      params: {
        threadId: "thread-existing",
        turnId: "compact-turn",
        error: { message: "native turn has not completed" },
        willRetry: false,
      },
    });
    expect(harness.requests.map((request) => request.method)).not.toContain("turn/start");
    await harness.notify({
      method: "turn/completed",
      params: {
        threadId: "thread-existing",
        turn: { id: "compact-turn", status: "completed", items: [] },
      },
    });
    await harness.waitForMethod("turn/start");
    await harness.completeTurn({ threadId: "thread-existing", turnId: "turn-1" });
    await run;
    expect(withoutCodexSkillDiscovery(harness.requests.map((request) => request.method))).toEqual([
      "config/read",
      "configRequirements/read",
      "thread/read",
      "thread/resume",
      "thread/inject_items",
      "turn/start",
    ]);
    await expectRetainedSuccessfulThread(harness.client, "thread-existing");
  });

  it("does not leak unhandled rejections when shutdown closes before interrupt", async () => {
    const unhandledRejections: unknown[] = [];
    const onUnhandledRejection = (reason: unknown) => {
      unhandledRejections.push(reason);
    };
    process.on("unhandledRejection", onUnhandledRejection);
    try {
      createStartedThreadHarness(async (method) => {
        if (method === "turn/interrupt") {
          throw new Error("codex app-server client is closed");
        }
      });
      const abortController = new AbortController();
      const params = createRunParams();
      params.abortSignal = abortController.signal;
      const run = runCodexAppServerAttempt(params);
      await run.waitForTurnAccepted();
      abortController.abort("shutdown");
      await expect(run).rejects.toThrow("Codex cancellation could not confirm the turn stopped");
      await new Promise((resolve) => {
        setImmediate(resolve);
      });
      expect(unhandledRejections).toStrictEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandledRejection);
    }
  });
  it("forwards image attachments to the app-server turn input", async () => {
    const { requests, waitForMethod, completeTurn } = createStartedThreadHarness();
    const params = createRunParams();
    const pngBase64 =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";
    params.model = createCodexTestModel("codex", ["text", "image"]);
    setCodexTestModelSupportsTools(params, false);
    params.images = [
      {
        type: "image",
        mimeType: "image/png",
        data: pngBase64,
      },
    ];
    const run = runCodexAppServerAttempt(params);
    await completeStartedRun(run, waitForMethod, completeTurn);
    const turnStart = requests.find((entry) => entry.method === "turn/start");
    const turnStartParams = turnStart?.params as
      | { input?: Array<{ text?: string; text_elements?: unknown[]; type?: string; url?: string }> }
      | undefined;
    expect(turnStartParams?.input).toEqual([
      { type: "text", text: "hello", text_elements: [] },
      { type: "image", url: `data:image/png;base64,${pngBase64}` },
    ]);
    expect(
      requests.filter(
        (entry) =>
          entry.method === "skills/list" &&
          (entry.params as { forceReload?: boolean } | undefined)?.forceReload === false,
      ),
    ).toHaveLength(0);
  });

  it("appends path-matched explicit skills to the initial turn input", async () => {
    const params = createRunParams();
    const skillPath = path.join(params.workspaceDir, ".agents", "skills", "release", "SKILL.md");
    const harness = createStartedThreadHarness(async (method) => {
      if (method !== "skills/list") {
        return undefined;
      }
      return {
        data: [
          {
            cwd: params.workspaceDir,
            skills: [
              {
                name: "release",
                description: "Release workflow",
                path: skillPath,
                scope: "repo",
                enabled: true,
              },
            ],
            errors: [],
          },
        ],
      } satisfies import("./protocol-control-plane.js").CodexSkillsListResponse;
    });
    params.explicitSkillSelections = [{ name: "release-command", path: skillPath }];

    const run = runCodexAppServerAttempt(params);
    await completeStartedRun(run, harness.waitForMethod, harness.completeTurn);

    const turnStart = harness.requests.find((entry) => entry.method === "turn/start");
    expect((turnStart?.params as { input?: unknown[] } | undefined)?.input).toEqual([
      { type: "text", text: "hello", text_elements: [] },
      { type: "skill", name: "release", path: skillPath },
    ]);
  });

  it("clears an active run with blocked terminal delivery after user stop", async () => {
    const turnStateFactory = vi.spyOn(attemptTurnState, "createCodexAttemptTurnState");
    const harness = createStartedThreadHarness();
    harness.client.close = () => harness.close();
    const abortController = new AbortController();
    const blocked = createDeferred<void>();
    const onPartialReply = vi.fn(() => blocked.promise);
    const params = createRunParams();
    params.abortSignal = abortController.signal;
    params.onPartialReply = onPartialReply;
    const run = runCodexAppServerAttempt(params);
    const settled = vi.fn();
    const settledRun = run.then(settled, settled);
    try {
      await vi.waitFor(() => {
        expect(resolveActiveEmbeddedRunSessionId(params.sessionKey!)).toBe(params.sessionId);
      }, fastWait);
      await harness.notify(
        itemNotification("item/started", {
          id: "msg-1",
          type: "agentMessage",
          phase: "final_answer",
          text: "",
        }),
      );
      void harness.notify({
        method: "item/agentMessage/delta",
        params: { threadId: "thread-1", turnId: "turn-1", itemId: "msg-1", delta: "hello" },
      });
      await vi.waitFor(() => expect(onPartialReply).toHaveBeenCalledOnce(), fastWait);
      vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
      void harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
      abortController.abort("cancelled");
      await vi.advanceTimersByTimeAsync(2 * 60_000);
      const turnState = turnStateFactory.mock.results[0];
      if (turnState?.type !== "return") {
        throw new Error("Codex attempt did not create its turn state");
      }
      // Native abort cleanup owns the start of the projection drain grace.
      // Join that phase before advancing its clock or restoring real timers.
      await vi.waitFor(() => turnState.value.state.abortCleanup, fastWait);
      await vi.advanceTimersByTimeAsync(TURN_FINALIZE_DRAIN_ABORT_GRACE_MS + 1);
      const result = await run;
      vi.useRealTimers();
      expect(settled).toHaveBeenCalledOnce();
      expect(readAttemptTerminal(result)).toMatchObject({
        aborted: true,
        timedOut: false,
      });
      expect(resolveActiveEmbeddedRunSessionId(params.sessionKey!)).toBeUndefined();
    } finally {
      // Release only for test cleanup; the run must settle while this callback is still blocked.
      blocked.resolve();
      abortController.abort("test_cleanup");
      try {
        // Observe rejection without replacing the test body's original failure.
        await settledRun;
      } finally {
        vi.useRealTimers();
      }
    }
  });

  it("does not fail when a buffered terminal notification is followed by client close", async () => {
    let resolveBufferedTerminal!: () => void;
    const bufferedTerminal = new Promise<void>((resolve) => {
      resolveBufferedTerminal = resolve;
    });
    const harness: ReturnType<typeof createAppServerHarness> = createStartedThreadHarness(
      async (method) => {
        if (method === "turn/start") {
          await harness.notify(
            itemNotification("item/started", { id: "tool-1", type: "commandExecution" }),
          );
          await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
          resolveBufferedTerminal();
          return turnStartResult("turn-1", "inProgress");
        }
        return undefined;
      },
    );
    const run = runCodexAppServerAttempt(createRunParams());
    await bufferedTerminal;
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    harness.close();
    const result = await run;
    expect(readAttemptTerminal(result)).toMatchObject({
      promptError: null,
      aborted: false,
      timedOut: false,
    });
  });

  it("materializes Codex-native image generation into Gateway-owned reply media", async () => {
    const savedPath = "/tmp/codex-home/generated_images/session-1/ig_123.png";
    const harness = createStartedThreadHarness(async (method) => {
      if (method === "turn/start") {
        return {
          turn: {
            id: "turn-1",
            status: "completed",
            items: [
              {
                type: "imageGeneration",
                id: "ig_123",
                status: "completed",
                revisedPrompt: "A tiny blue square",
                result: "Zm9v",
                savedPath,
              },
            ],
          },
        };
      }
      return undefined;
    });
    const result = await runCodexAppServerAttempt(createRunParams());
    expect(harness.requests.map((entry) => entry.method)).toContain("turn/start");
    expect(result.assistantTexts).toEqual([]);
    expect(result.toolMediaUrls).toHaveLength(1);
    expect(result.toolMediaUrls?.[0]).not.toBe(savedPath);
    expect(result.hostOwnedToolMediaUrls).toEqual(result.toolMediaUrls);
    await expect(fs.readFile(result.toolMediaUrls?.[0] ?? "")).resolves.toEqual(Buffer.from("foo"));
  });
  it("does not complete on unscoped turn/completed notifications", async () => {
    const harness = createStartedThreadHarness();
    const run = runCodexAppServerAttempt(createRunParams());
    let resolved = false;
    void run.then(() => {
      resolved = true;
    });
    await harness.waitForMethod("turn/start");
    await harness.notify({
      method: "turn/completed",
      params: {
        turn: {
          id: "turn-1",
          status: "completed",
          items: [{ type: "agentMessage", id: "msg-wrong", text: "wrong completion" }],
        },
      },
    });
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(resolved).toBe(false);
    await harness.notify({
      method: "turn/completed",
      params: {
        threadId: "thread-1",
        turn: {
          id: "turn-1",
          status: "completed",
          items: [{ type: "agentMessage", id: "msg-right", text: "final completion" }],
        },
      },
    });
    const result = await run;
    expect(result.assistantTexts).toEqual(["final completion"]);
    expect(readAttemptTerminal(result)).toMatchObject({ aborted: false, timedOut: false });
  });

  it("routes ordinary elicitations through the per-turn input bridge after approval classification", async () => {
    const approvalSpy = vi
      .spyOn(elicitationBridge, "routeCodexAppServerElicitationRequest")
      .mockResolvedValue({ kind: "not-mine" });
    const ordinaryHandler = vi.fn().mockResolvedValue({
      action: "accept",
      content: { name: "Ada" },
      _meta: null,
    });
    vi.spyOn(userInputBridge, "createCodexUserInputBridge").mockReturnValue({
      handleRequest: vi.fn(),
      handleElicitationRequest: ordinaryHandler,
      cancelPending: vi.fn(),
    });
    const harness = createStartedThreadHarness();
    const run = runCodexAppServerAttempt(createRunParams());
    await harness.waitForMethod("turn/start");
    const mcpItem = {
      type: "mcpToolCall",
      id: "raw-item",
      server: "raw-server",
      tool: "_raw.tool",
      arguments: { query: "exact" },
      status: "inProgress",
    };
    await harness.notify({
      method: "item/started",
      params: { threadId: "thread-1", turnId: "turn-1", item: mcpItem },
    });

    const params = {
      threadId: "thread-1",
      turnId: null,
      serverName: "forms",
      mode: "form",
      message: "Enter a name",
      requestedSchema: { type: "object", properties: { name: { type: "string" } } },
    };
    await expect(
      harness.handleServerRequest({
        id: "ordinary-1",
        method: "mcpServer/elicitation/request",
        params,
      }),
    ).resolves.toEqual({ action: "accept", content: { name: "Ada" }, _meta: null });
    expect(approvalSpy).toHaveBeenCalledWith(expect.objectContaining({ requestParams: params }));
    const getActiveMcpToolCall = approvalSpy.mock.calls[0]?.[0].getActiveMcpToolCall;
    expect(getActiveMcpToolCall?.("raw-server")).toEqual({
      id: mcpItem.id,
      server: mcpItem.server,
      tool: mcpItem.tool,
      arguments: mcpItem.arguments,
    });
    expect(ordinaryHandler).toHaveBeenCalledWith(
      { id: "ordinary-1", method: "mcpServer/elicitation/request", params },
      expect.any(AbortSignal),
    );
    expect(approvalSpy).toHaveBeenCalledBefore(ordinaryHandler);

    await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    await run;
    expect(getActiveMcpToolCall?.("raw-server")).toBeUndefined();
  });
  it.each(["competing item", "terminal turn"])(
    "fences MCP persistence correlation when a %s receipt is behind a slow projection",
    async (receipt) => {
      const approvalSpy = vi
        .spyOn(elicitationBridge, "routeCodexAppServerElicitationRequest")
        .mockResolvedValue({
          kind: "handled",
          response: { action: "accept", content: {}, _meta: { persist: "always" } },
        });
      const projectionEntered = createDeferred<void>();
      const projectionRelease = createDeferred<void>();
      const params = createRunParams();
      params.onAssistantMessageStart = async () => {
        projectionEntered.resolve();
        await projectionRelease.promise;
      };
      const harness = createStartedThreadHarness();
      const run = runCodexAppServerAttempt(params);
      await harness.waitForMethod("turn/start");
      const item = {
        type: "mcpToolCall",
        id: "active-mcp",
        server: "configured-server",
        tool: "raw-tool",
        arguments: {},
        status: "inProgress",
      };
      await harness.notify({
        method: "item/started",
        params: { threadId: "thread-1", turnId: "turn-1", item },
      });
      await harness.handleServerRequest({
        id: "pending-mcp-approval",
        method: "mcpServer/elicitation/request",
        params: { threadId: "thread-1", turnId: "turn-1", serverName: item.server },
      });
      const correlate = approvalSpy.mock.calls[0]?.[0].getActiveMcpToolCall;
      expect(correlate?.(item.server)?.id).toBe(item.id);
      const slowProjection = harness.notify({
        method: "item/agentMessage/delta",
        params: { threadId: "thread-1", turnId: "turn-1", itemId: "slow", delta: "Waiting" },
      });
      await projectionEntered.promise;
      const queuedReceipt = harness.notify(
        receipt === "terminal turn"
          ? turnCompleted({ id: "turn-1", status: "completed" })
          : {
              method: "item/started",
              params: {
                threadId: "thread-1",
                turnId: "turn-1",
                item: { ...item, id: "competing-mcp" },
              },
            },
      );
      try {
        expect(correlate?.(item.server)).toBeUndefined();
      } finally {
        projectionRelease.resolve();
        await Promise.all([slowProjection, queuedReceipt]);
        if (receipt !== "terminal turn") {
          try {
            await harness.notify({
              method: "item/completed",
              params: {
                threadId: "thread-1",
                turnId: "turn-1",
                item: { ...item, id: "competing-mcp", status: "completed" },
              },
            });
            expect(correlate?.(item.server)?.id).toBe(item.id);
          } finally {
            await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
          }
        }
        await run;
      }
    },
  );

  it.each([
    {
      name: "keys plugin app inventory by the resolved Codex account",
      cachedEnabled: true,
      cacheKey: ({ appServer, agentDir }: GoogleCalendarCacheKeyInput) =>
        buildCodexPluginAppCacheKey({
          appServer,
          agentDir,
          authProfileId: "openai:work",
          accountId: "account-work",
          runtimeIdentity: getMockRuntimeIdentity(),
        }),
      appInventory: () => {
        throw new Error("App discovery should use the account-keyed cache entry");
      },
      configure: (params: EmbeddedRunAttemptParams) => {
        params.authProfileId = "openai:work";
        params.authProfileStore = {
          version: 1,
          profiles: {
            "openai:work": {
              ...createCodexTestOAuthProfile("account-work"),
              email: "work@example.test",
            },
          },
        };
      },
      expectsAppInventory: false,
      expectedAppEnabled: true,
    },
    {
      name: "provisionally enables a cached disabled plugin app after thread attestation",
      cachedEnabled: false,
      cacheKey: ({ appServer, agentDir }: GoogleCalendarCacheKeyInput) =>
        buildCodexPluginAppCacheKey({
          appServer,
          agentDir,
          envApiKeyFingerprint: resolveCodexAppServerFallbackApiKeyCacheKey({
            startOptions: appServer.start,
          }),
          runtimeIdentity: getMockRuntimeIdentity(),
        }),
      appInventory: (method: "app/installed" | "app/read") =>
        codexAppInventoryResponse(method, [googleCalendarAppInfo(false)]),
      expectsAppInventory: false,
      expectedAppEnabled: true,
    },
    {
      name: "keys plugin app inventory by inherited API key fallback credentials",
      cachedEnabled: true,
      cacheKey: ({ appServer, agentDir }: GoogleCalendarCacheKeyInput) =>
        buildCodexPluginAppCacheKey({
          appServer,
          agentDir,
          envApiKeyFingerprint: resolveCodexAppServerFallbackApiKeyCacheKey({
            startOptions: appServer.start,
            baseEnv: { CODEX_API_KEY: "old-codex-env-key" },
          }),
          runtimeIdentity: getMockRuntimeIdentity(),
        }),
      appInventory: (method: "app/installed" | "app/read") =>
        codexAppInventoryResponse(method, [googleCalendarAppInfo(true)]),
      configure: () => {
        vi.stubEnv("CODEX_API_KEY", "new-codex-env-key");
        vi.stubEnv("OPENAI_API_KEY", "");
      },
      expectsAppInventory: true,
      expectedAppEnabled: true,
    },
  ])(
    "$name",
    async ({
      cachedEnabled,
      cacheKey,
      appInventory,
      configure,
      expectsAppInventory,
      expectedAppEnabled,
    }) => {
      const { sessionFile, workspaceDir, agentDir } = createRunPaths();
      const pluginConfig = GOOGLE_CALENDAR_PLUGIN_CONFIG;
      const appServer = resolveCodexAppServerRuntimeOptions({
        pluginConfig: readCodexPluginConfig(pluginConfig),
      });
      await primeGoogleCalendarAppInventory(cacheKey({ appServer, agentDir }), cachedEnabled);
      const { requests, waitForMethod, completeTurn } = createStartedThreadHarness(
        createGoogleCalendarRequest(appInventory),
      );
      const params = createParams(sessionFile, workspaceDir);
      params.agentDir = agentDir;
      configure?.(params);
      const run = runCodexAppServerAttempt(params, { pluginConfig });
      await completeStartedRun(run, waitForMethod, completeTurn);
      const threadStart = requests.find((entry) => entry.method === "thread/start");
      const threadStartParams = threadStart?.params as
        | { config?: { apps?: Record<string, { enabled?: boolean }> } }
        | undefined;
      expect(threadStartParams?.config?.apps?.["google-calendar-app"]?.enabled).toBe(
        expectedAppEnabled,
      );
      const globalAppInventoryRequests = requests.filter(
        (entry) =>
          entry.method === "app/installed" &&
          typeof (entry.params as { threadId?: unknown } | undefined)?.threadId !== "string",
      );
      if (expectsAppInventory) {
        expect(globalAppInventoryRequests).not.toHaveLength(0);
        expect(requests.map((entry) => entry.method)).toContain("app/read");
      } else {
        expect(globalAppInventoryRequests).toHaveLength(0);
        expect(requests.map((entry) => entry.method)).not.toContain("app/read");
      }
      if (!cachedEnabled) {
        expect(
          requests.filter(
            (entry) =>
              entry.method === "app/installed" &&
              typeof (entry.params as { threadId?: unknown } | undefined)?.threadId === "string",
          ),
        ).toEqual([
          expect.objectContaining({
            method: "app/installed",
            params: { threadId: "thread-1", forceRefresh: false },
          }),
        ]);
      }
    },
  );

  it("does not install an active run handle when turn start resolves after abort", async () => {
    const turnStart = createDeferred<ReturnType<typeof turnStartResult>>();
    const harness = createStartedThreadHarness(async (method) =>
      method === "turn/start" ? await turnStart.promise : undefined,
    );
    const abortController = new AbortController();
    const params = createRunParams();
    params.abortSignal = abortController.signal;
    const run = runCodexAppServerAttempt(params);
    await harness.waitForMethod("turn/start");
    expect(harness.request.mock.calls.map(([method]) => method)).toContain("turn/start");
    abortController.abort("test_abort");
    turnStart.resolve(turnStartResult());
    await expect(run).rejects.toThrow("test_abort");
    expect(queueActiveRunMessageForTest("session-1", "after abort")).toBe(false);
    expect(harness.requests.filter(({ method }) => method === "turn/interrupt")).toEqual([
      { method: "turn/interrupt", params: { threadId: "thread-1", turnId: "turn-1" } },
    ]);
  });

  it("sends the current recorded sender on successive turns of one resumed Codex thread", async () => {
    const { sessionFile, workspaceDir } = createRunPaths();
    await writeExistingBinding(sessionFile, workspaceDir, { dynamicToolsFingerprint: "[]" });
    const turnIds = ["turn-ada", "turn-grace"] as const;
    let nextTurnIndex = 0;
    const harness = createAppServerHarness(
      async (method, params) => {
        if (method === "configRequirements/read") {
          return { requirements: null };
        }
        if (method === "config/read") {
          return { config: {}, origins: {}, layers: [] };
        }
        if (method === "thread/resume") {
          return threadStartResult((params as { threadId?: string }).threadId ?? "thread-existing");
        }
        if (method === "turn/start") {
          const turnId = turnIds[nextTurnIndex++];
          if (!turnId) {
            throw new Error("unexpected extra turn/start");
          }
          return turnStartResult(turnId);
        }
        return {};
      },
      { persistedThreads: ["thread-existing"] },
    );

    const runTurn = async (sender: { id: string; name: string }, prompt: string, runId: string) => {
      const expectedTurnStarts =
        harness.requests.filter((request) => request.method === "turn/start").length + 1;
      const params = createParams(sessionFile, workspaceDir, { prompt, runId });
      params.trigger = "user";
      const message = {
        role: "user" as const,
        content: prompt,
        timestamp: Date.now(),
        __openclaw: { senderId: sender.id, senderName: sender.name },
      };
      params.userTurnTranscriptRecorder = {
        message,
        resolveMessage: async () => message,
        getAdmissionReceipt: () => undefined,
        markRuntimePersistencePending() {},
        markRuntimePersisted() {},
      } as unknown as EmbeddedRunAttemptParams["userTurnTranscriptRecorder"];
      const run = runCodexAppServerAttempt(params);
      await vi.waitFor(
        () =>
          expect(
            harness.requests.filter((request) => request.method === "turn/start"),
          ).toHaveLength(expectedTurnStarts),
        fastWait,
      );
      await harness.completeTurn({
        threadId: "thread-existing",
        turnId: `turn-${sender.name.toLowerCase()}`,
      });
      await run;
    };

    await runTurn({ id: "profile-ada", name: "Ada" }, "first request", "run-ada");
    await runTurn({ id: "profile-grace", name: "Grace" }, "second request", "run-grace");

    expect(
      harness.requests
        .filter((request) =>
          ["thread/start", "thread/resume", "turn/start"].includes(request.method),
        )
        .map((request) => request.method),
    ).toEqual(["thread/resume", "turn/start", "turn/start"]);
    expect(
      harness.requests
        .filter((request) => request.method === "turn/start")
        .map(
          (request) =>
            (
              request.params as {
                additionalContext?: Record<string, { kind: string; value: string }>;
              }
            ).additionalContext?.openclaw_current_sender,
        ),
    ).toEqual([
      {
        kind: "untrusted",
        value: '{"sender":{"id":"profile-ada","name":"Ada"}}',
      },
      {
        kind: "untrusted",
        value: '{"sender":{"id":"profile-grace","name":"Grace"}}',
      },
    ]);
  });
  it("keeps context usage fresh across two turns of one Codex thread", async () => {
    const { sessionFile, workspaceDir } = createRunPaths();
    const turnIds = ["turn-1", "turn-2"] as const;
    let nextTurnIndex = 0;
    const harness = createAppServerHarness(async (method) => {
      if (method === "configRequirements/read") {
        return { requirements: null };
      }
      if (method === "config/read") {
        return { config: {}, origins: {}, layers: [] };
      }
      if (method === "thread/start") {
        return threadStartResult("thread-1");
      }
      if (method === "turn/start") {
        const turnId = turnIds[nextTurnIndex++];
        if (!turnId) {
          throw new Error("unexpected extra turn/start");
        }
        return turnStartResult(turnId);
      }
      return {};
    });

    const runTurn = async (index: number) => {
      const turnId = turnIds[index]!;
      const expectedTurnStarts = index + 1;
      const run = runCodexAppServerAttempt(
        createParams(sessionFile, workspaceDir, {
          prompt: `turn ${index + 1}`,
          runId: `run-${index + 1}`,
        }),
      );
      await vi.waitFor(
        () =>
          expect(
            harness.requests.filter((request) => request.method === "turn/start"),
          ).toHaveLength(expectedTurnStarts),
        fastWait,
      );
      const inputTokens = 15_000 + index * 1_000;
      const outputTokens = 100;
      if (index === 0) {
        await harness.notify({
          method: "rawResponse/completed",
          params: {
            threadId: "thread-1",
            turnId,
            responseId: "response-1",
            usage: {
              totalTokens: inputTokens + outputTokens,
              inputTokens,
              cachedInputTokens: 0,
              outputTokens,
              reasoningOutputTokens: 0,
            },
          },
        });
      }
      await harness.notify({
        method: "thread/tokenUsage/updated",
        params: {
          threadId: "thread-1",
          turnId,
          tokenUsage: {
            last: {
              totalTokens: inputTokens + outputTokens,
              inputTokens,
              cachedInputTokens: 0,
              cacheWriteInputTokens: 0,
              outputTokens,
              reasoningOutputTokens: 0,
            },
          },
        },
      });
      await harness.completeTurn({ threadId: "thread-1", turnId });
      return run;
    };

    const first = await runTurn(0);
    const second = await runTurn(1);

    expect(first.attemptUsage?.contextUsage).toEqual({
      state: "available",
      promptTokens: 15_000,
      totalTokens: 15_100,
    });
    expect(second.attemptUsage?.contextUsage).toEqual({
      state: "available",
      promptTokens: 16_000,
      totalTokens: 16_100,
    });
    expect(
      harness.requests
        .filter((request) =>
          ["thread/start", "thread/resume", "turn/start"].includes(request.method),
        )
        .map((request) => request.method),
    ).toEqual(["thread/start", "turn/start", "turn/start"]);
  });

  it("preserves stale-binding continuity when token pressure forces a fresh Codex thread", async () => {
    const { sessionFile, workspaceDir, agentDir } = createRunPaths();
    await writeExistingBinding(sessionFile, workspaceDir, { dynamicToolsFingerprint: "[]" });
    const binding = await readCodexAppServerBinding(sessionFile);
    const bindingUpdatedAt = Date.parse(binding?.historyCoveredThrough ?? "");
    if (!Number.isFinite(bindingUpdatedAt)) {
      throw new Error("expected valid Codex binding timestamp");
    }
    const sessionManager = openRunSession(sessionFile);
    sessionManager.appendMessage(
      userMessage(
        "pre-binding native-owned context: keep the original plan",
        bindingUpdatedAt - 2_000,
      ),
    );
    sessionManager.appendMessage(
      userMessage(
        "post-binding user context: resume the release checklist",
        bindingUpdatedAt + 1_000,
      ),
    );
    sessionManager.appendMessage(
      assistantMessage("post-binding assistant context", bindingUpdatedAt + 2_000),
    );
    for (let index = 0; index < 8; index += 1) {
      sessionManager.appendMessage(
        assistantMessage(
          `post-binding continuity filler ${index}: ${"x".repeat(4_000)}`,
          bindingUpdatedAt + 3_000 + index,
        ),
      );
    }
    await writeTokenPressureState(sessionFile, agentDir, {
      last_token_usage: { total_tokens: 220_000 },
      model_context_window: 258_400,
    });
    const { requests, waitForMethod, completeTurn } = createStartedThreadHarness();
    const params = createParams(sessionFile, workspaceDir);
    params.agentDir = agentDir;
    params.prompt = "large prompt ".repeat(12_000);
    const run = runCodexAppServerAttempt(params, {
      pluginConfig: { appServer: { mode: "yolo" } },
    });
    await completeStartedRun(run, waitForMethod, completeTurn);
    expect(requests.map((entry) => entry.method)).toContain("thread/start");
    expect(requests.map((entry) => entry.method)).not.toContain("thread/resume");
    const turnStart = requests.find((request) => request.method === "turn/start");
    const inputText =
      (turnStart?.params as { input?: Array<{ text?: string }> } | undefined)?.input?.[0]?.text ??
      "";
    expect(inputText).toContain("pre-binding native-owned context: keep the original plan");
    expect(inputText).toContain("post-binding user context: resume the release checklist");
    expect(inputText).toContain("post-binding assistant context");
    const savedBinding = await readCodexAppServerBinding(sessionFile);
    expect(savedBinding?.threadId).toBe("thread-1");
  });

  it("preserves bound auth when rotating a fallback-fuse native rollout", async () => {
    const { sessionFile, workspaceDir, agentDir } = createRunPaths();
    await writeExistingBinding(sessionFile, workspaceDir, {
      authProfileId: "openai:work",
      dynamicToolsFingerprint: "[]",
    });
    await writeTokenPressureState(sessionFile, agentDir, {
      total_token_usage: { total_tokens: 300_000 },
    });
    const seenAuthProfileIds: Array<string | undefined> = [];
    const { requests, waitForMethod, completeTurn } = createStartedThreadHarness(undefined, {
      onStart: (authProfileId) => {
        seenAuthProfileIds.push(authProfileId);
      },
    });
    const params = createParams(sessionFile, workspaceDir);
    delete params.authProfileId;
    params.agentDir = agentDir;
    params.config = {
      ...params.config,
      agents: {
        defaults: {
          compaction: {
            maxActiveTranscriptBytes: "1mb",
          },
        },
      },
    } as never;
    params.authProfileStore.profiles["openai:work"] =
      createCodexTestOAuthProfile("synthetic-account");
    const run = runCodexAppServerAttempt(params, {
      pluginConfig: { appServer: { mode: "yolo" } },
    });
    await completeStartedRun(run, waitForMethod, completeTurn);
    expect(requests.map((entry) => entry.method)).toContain("thread/start");
    expect(requests.map((entry) => entry.method)).not.toContain("thread/resume");
    expect(new Set(seenAuthProfileIds)).toEqual(new Set(["openai:work"]));
    const savedBinding = await readCodexAppServerBinding(sessionFile);
    expect(savedBinding?.authProfileId).toBe("openai:work");
    expect(savedBinding?.threadId).toBe("thread-1");
  });
  it("replaces a client whose settled failed thread cannot reload configuration", async () => {
    const { result, requests, client } = await runSettledFailureClientReplacementTest();
    expect(readAttemptTerminal(result).aborted).toBe(false);
    expect(requests.map(withoutCodexSkillDiscovery)).toEqual([
      ["config/read", "configRequirements/read", "thread/read"],
      [
        "config/read",
        "configRequirements/read",
        "thread/read",
        "thread/resume",
        "thread/inject_items",
        "turn/start",
      ],
    ]);
    await expectRetainedSuccessfulThread(client, "thread-existing");
  });
  it("rejects a replacement client whose managed policy disables the native shell", async () => {
    const requests: string[][] = [];
    await expect(
      runSettledFailureClientReplacementTest({ denyReplacementShell: true, requests }),
    ).rejects.toThrow("Codex native code mode requires shell_tool");
    expect(requests.map(withoutCodexSkillDiscovery)).toEqual([
      ["config/read", "configRequirements/read", "thread/read"],
      ["config/read", "configRequirements/read"],
    ]);
  });

  it("retires the shared Codex client when a spawned helper run times out during thread/start", async () => {
    const { retireSpy, state } = installFailingThreadStartClient(
      () => new Promise<never>(() => {}),
    );
    const params = createRunParams();
    params.spawnedBy = "agent:main:session-parent";
    params.timeoutMs = 1;
    await expect(runCodexAppServerAttempt(params, { startupTimeoutFloorMs: 1 })).rejects.toThrow(
      "codex app-server startup timed out",
    );
    const calledWithFailedClient = retireSpy.mock.calls.some(([arg]) => arg === state.failedClient);
    expect(calledWithFailedClient).toBe(true);
    retireSpy.mockRestore();
  });
  it("retires the shared Codex client when a spawned helper hits a thread/start write failure", async () => {
    const { retireSpy, state } = installFailingThreadStartClient(() => {
      throw Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
    });
    const params = createRunParams();
    params.spawnedBy = "agent:main:session-parent";
    await expect(runCodexAppServerAttempt(params)).rejects.toThrow("write EPIPE");
    const calledWithFailedClient = retireSpy.mock.calls.some(([arg]) => arg === state.failedClient);
    expect(calledWithFailedClient).toBe(true);
    retireSpy.mockRestore();
  });

  it("retires the shared Codex client when a top-level run fails with a logical thread/start error", async () => {
    const { retireSpy, state } = installFailingThreadStartClient(() => {
      throw new CodexAppServerRpcError(
        { message: "401 authentication_error: Invalid bearer token" },
        "thread/start",
      );
    });
    const params = createRunParams();
    await expect(runCodexAppServerAttempt(params)).rejects.toThrow("Invalid bearer token");
    const calledWithFailedClient = retireSpy.mock.calls.some(([arg]) => arg === state.failedClient);
    expect(calledWithFailedClient).toBe(true);
    retireSpy.mockRestore();
  });
  it("retains the prepared execution model across native resume without exposing it in lifecycle events", async () => {
    const { sessionFile, workspaceDir } = createRunPaths();
    const runtimeModelId = "test-runtime-model";
    const beforePromptBuild = vi.fn(() => undefined);
    initializeGlobalHookRunner(
      createMockPluginRegistry([{ hookName: "before_prompt_build", handler: beforePromptBuild }]),
    );
    const freshHarness = createStartedThreadHarness(
      async (method) =>
        method === "thread/start" ? { ...threadStartResult(), model: runtimeModelId } : undefined,
      { persistedThreads: [] },
    );
    const params = createParams(sessionFile, workspaceDir, { provider: "openai" });
    params.modelId = "gpt-5.6-sol";
    params.model = {
      ...params.model,
      id: "gpt-5.6-sol",
      params: {
        ...params.model.params,
        ...buildCodexRuntimeModelParams("gpt-5.6-sol", runtimeModelId),
      },
    };
    const onFreshAgentEvent = vi.fn();
    params.onAgentEvent = onFreshAgentEvent;

    const freshRun = runCodexAppServerAttempt(params, { runtimeModelId });
    await completeStartedRun(freshRun, freshHarness.waitForMethod, freshHarness.completeTurn);
    expect(mockCall(beforePromptBuild, "before_prompt_build", -1)[1]).toMatchObject({
      modelProviderId: params.provider,
      modelId: params.modelId,
    });

    for (const method of ["thread/start", "turn/start"]) {
      expect(freshHarness.requests.find((entry) => entry.method === method)).toMatchObject({
        params: { model: runtimeModelId },
      });
    }
    await expect(readCodexAppServerBinding(sessionFile)).resolves.toMatchObject({
      threadId: "thread-1",
      model: runtimeModelId,
      clientId: freshHarness.client.getInstanceId(),
    });

    freshHarness.close();
    const resumedHarness = createStartedThreadHarness(
      async (method) =>
        method === "thread/resume" ? { ...threadStartResult(), model: runtimeModelId } : undefined,
      { persistedThreads: ["thread-1"] },
    );

    const onResumedAgentEvent = vi.fn();
    const resumedRun = runCodexAppServerAttempt(
      { ...params, runId: "run-2", onAgentEvent: onResumedAgentEvent },
      { runtimeModelId },
    );
    await completeStartedRun(resumedRun, resumedHarness.waitForMethod, resumedHarness.completeTurn);
    expect(mockCall(beforePromptBuild, "before_prompt_build", -1)[1]).toMatchObject({
      modelProviderId: params.provider,
      modelId: params.modelId,
    });

    expectResumeRequest(resumedHarness.requests, {
      threadId: "thread-1",
      model: runtimeModelId,
    });
    expect(resumedHarness.requests.map((entry) => entry.method)).not.toContain("thread/start");
    expect(resumedHarness.requests.find((entry) => entry.method === "turn/start")).toMatchObject({
      params: { threadId: "thread-1", model: runtimeModelId },
    });
    await expect(readCodexAppServerBinding(sessionFile)).resolves.toMatchObject({
      threadId: "thread-1",
      model: runtimeModelId,
      clientId: resumedHarness.client.getInstanceId(),
    });
    for (const onAgentEvent of [onFreshAgentEvent, onResumedAgentEvent]) {
      expect(onAgentEvent).toHaveBeenCalledWith({
        stream: "codex_app_server.lifecycle",
        data: expect.objectContaining({ phase: "turn_starting", model: "gpt-5.6-sol" }),
      });
    }
  });

  it("enables Guardian on the first turn after a fresh thread confirms the OpenAI provider", async () => {
    const { sessionFile, workspaceDir } = createRunPaths();
    const { requests, waitForMethod, completeTurn } = createStartedThreadHarness();
    const params = createParams(sessionFile, workspaceDir);
    const run = runCodexAppServerAttempt(params, {
      pluginConfig: {
        appServer: {
          mode: "guardian",
        },
      },
    });
    await completeStartedRun(run, waitForMethod, completeTurn);
    const startRequest = requests.find((request) => request.method === "thread/start");
    const startRequestParams = startRequest?.params as Record<string, unknown> | undefined;
    expect(startRequestParams?.approvalsReviewer).toBe("user");
    const turnRequest = requests.find((request) => request.method === "turn/start");
    const turnRequestParams = turnRequest?.params as Record<string, unknown> | undefined;
    expect(turnRequestParams?.approvalsReviewer).toBe("auto_review");
  });

  it("uses human approval instead of Guardian for custom OpenAI-compatible endpoints", async () => {
    const { sessionFile, workspaceDir } = createRunPaths();
    const { requests, waitForMethod, completeTurn } = createStartedThreadHarness();
    const params = {
      ...createParams(sessionFile, workspaceDir),
      provider: "openai",
      modelId: "gpt-5.5",
      config: {
        tools: {
          exec: {
            mode: "auto",
          },
        },
        models: {
          providers: {
            openai: {
              baseUrl: "http://localhost:8080/v1",
              models: [],
            },
          },
        },
      },
    } as EmbeddedRunAttemptParams;
    const run = runCodexAppServerAttempt(params, { pluginConfig: {} });
    await completeStartedRun(run, waitForMethod, completeTurn);
    const startRequest = requests.find((request) => request.method === "thread/start");
    const startRequestParams = startRequest?.params as Record<string, unknown> | undefined;
    expect(startRequestParams?.modelProvider).toBe("openai");
    expect(startRequestParams?.approvalPolicy).toBe("on-request");
    expect(startRequestParams?.approvalsReviewer).toBe("user");
    const turnRequest = requests.find((request) => request.method === "turn/start");
    const turnRequestParams = turnRequest?.params as Record<string, unknown> | undefined;
    expect(turnRequestParams?.approvalsReviewer).toBe("user");
  });

  it("keeps Codex code-mode-only while disabling Guardian for provider-qualified local models", async () => {
    const { sessionFile, workspaceDir } = createRunPaths();
    const { requests, waitForMethod, completeTurn } = createStartedThreadHarness(async (method) => {
      if (method === "thread/start") {
        const response = threadStartResult();
        return {
          ...response,
          thread: {
            ...response.thread,
            modelProvider: "lmstudio",
          },
          model: "local-model",
          modelProvider: "lmstudio",
        };
      }
      return undefined;
    });
    const params = {
      ...createParams(sessionFile, workspaceDir),
      provider: "codex",
      modelId: "lmstudio/local-model",
      config: {
        tools: {
          exec: {
            mode: "auto",
          },
        },
      },
    } as EmbeddedRunAttemptParams;
    const run = runCodexAppServerAttempt(params, {
      pluginConfig: {
        appServer: {
          codeModeOnly: true,
        },
      },
    });
    await completeStartedRun(run, waitForMethod, completeTurn);
    const startRequest = requests.find((request) => request.method === "thread/start");
    const startRequestParams = startRequest?.params as Record<string, unknown> | undefined;
    const startConfig = startRequestParams?.config as Record<string, unknown> | undefined;
    expect(startRequestParams?.model).toBe("local-model");
    expect(startRequestParams?.modelProvider).toBe("lmstudio");
    expect(startRequestParams?.approvalPolicy).toBe("on-request");
    expect(startRequestParams?.approvalsReviewer).toBe("user");
    expect(startConfig?.["features.code_mode"]).toBe(true);
    expect(startConfig?.["features.code_mode_only"]).toBe(true);
    const turnRequest = requests.find((request) => request.method === "turn/start");
    const turnRequestParams = turnRequest?.params as Record<string, unknown> | undefined;
    const collaborationMode = turnRequestParams?.collaborationMode as
      | { settings?: Record<string, unknown> }
      | undefined;
    expect(turnRequestParams?.model).toBe("local-model");
    expect(collaborationMode?.settings?.model).toBe("local-model");
    expect(turnRequestParams?.approvalsReviewer).toBe("user");
  });

  it("rejects a newly observed native model before inference with stale prepared host auth", async () => {
    const { sessionFile, workspaceDir, agentDir } = createRunPaths();
    const modelRef = { provider: "openai", model: "gpt-5.5" };
    const beforePromptBuild = vi.fn(() => undefined);
    initializeGlobalHookRunner(
      createMockPluginRegistry([{ hookName: "before_prompt_build", handler: beforePromptBuild }]),
    );
    await writeExistingBinding(sessionFile, workspaceDir, {
      preserveNativeModel: true,
      authProfileId: "openai:host",
      model: modelRef.model,
      modelProvider: modelRef.provider,
    });
    const harness = createStartedThreadHarness(
      async (method) => {
        if (method === "thread/resume") {
          return {
            ...threadStartResult("thread-existing", { cwd: workspaceDir }),
            model: "gpt-5.6-luna",
            modelProvider: "openai",
          };
        }
        // Keep pre-fix execution finite: the regression is accepting inference, not a timeout.
        if (method === "turn/start") {
          return { turn: { id: "turn-1", status: "completed", items: [] } };
        }
        return undefined;
      },
      { persistedThreads: ["thread-existing"] },
    );
    const params = createParams(sessionFile, workspaceDir, { provider: "openai" });
    params.agentDir = agentDir;
    params.modelId = modelRef.model;
    params.model = { ...params.model, id: modelRef.model };
    params.authProfileId = "openai:host";
    params.resolvedApiKey = "prepared-host-api-key";
    params.authProfileStore = {
      version: 1,
      profiles: {
        "openai:host": { type: "api_key", provider: "openai", key: "prepared-host-api-key" },
      },
    };
    const expectedOwnership = { model: "native" as const, auth: "host" as const, modelRef };
    params.expectedSessionRuntimeOwnership = expectedOwnership;
    const result = await runCodexAppServerAttempt(params).catch((error: unknown) => {
      if (!(error instanceof Error)) {
        throw error;
      }
      return error;
    });
    expect(beforePromptBuild).toHaveBeenCalled();
    const hookContext = mockCall(beforePromptBuild, "before_prompt_build")[1];
    expect(hookContext).not.toHaveProperty("modelProviderId");
    expect(hookContext).not.toHaveProperty("modelId");
    expect(harness.requests.some(({ method }) => method === "thread/resume")).toBe(true);
    expect(harness.requests.some(({ method }) => method === "turn/start")).toBe(false);
    expect(result instanceof Error || Boolean(readAttemptTerminal(result).promptError)).toBe(true);
    expect(await readCodexAppServerBinding(sessionFile)).toMatchObject({
      threadId: "thread-existing",
      preserveNativeModel: true,
      model: "gpt-5.6-luna",
      modelProvider: "openai",
    });
  });

  it("rejects subscription sharing on a supervised session before native client startup", async () => {
    const { sessionFile, workspaceDir } = createRunPaths();
    await writeExistingBinding(sessionFile, workspaceDir, {
      connectionScope: "supervision",
      supervisionSourceThreadId: "thread-source",
      model: "gpt-5.5",
      modelProvider: "openai",
      preserveNativeModel: true,
      conversationSourceTransferComplete: true,
    });
    const params = createParams(sessionFile, workspaceDir);
    const runtimePlan = createCodexRuntimePlanFixture();
    params.runtimePlan = {
      ...runtimePlan,
      auth: {
        ...runtimePlan.auth,
        selectedAuthMode: "oauth",
        selectedAuthFlow: "chatgpt-token-sharing",
      },
    };
    const clientFactory = vi.fn(async () => {
      throw new Error("client must not start");
    });
    await expect(
      runCodexAppServerAttempt(params, {
        pluginConfig: { supervision: { enabled: true } },
        clientFactory,
      }),
    ).rejects.toThrow("detach from native supervision first");
    expect(clientFactory).not.toHaveBeenCalled();
  });

  it("does not inherit a bound local provider for explicit native OpenAI resumed runs", async () => {
    const { sessionFile, workspaceDir } = createRunPaths();
    await writeExistingBinding(sessionFile, workspaceDir, {
      authProfileId: "openai-profile",
      model: "local-model",
      modelProvider: "lmstudio",
    });
    const { requests, waitForMethod, completeTurn } = createResumeHarness();
    const params = createParams(sessionFile, workspaceDir);
    params.provider = "openai";
    params.authProfileId = "openai-profile";
    params.modelId = "gpt-5.5";
    params.authProfileStore = {
      version: 1,
      profiles: {
        "openai-profile": {
          ...createCodexTestOAuthProfile("account-work"),
          email: "work@example.test",
        },
      },
    };
    const run = runCodexAppServerAttempt(params, {
      pluginConfig: {
        appServer: {
          mode: "guardian",
        },
      },
    });
    await completeStartedRun(run, waitForMethod, completeTurn, "thread-existing");
    const resumeRequest = requests.find((request) => request.method === "thread/resume");
    const resumeRequestParams = resumeRequest?.params as Record<string, unknown> | undefined;
    expect(resumeRequestParams?.model).toBe("gpt-5.5");
    expect(resumeRequestParams).not.toHaveProperty("modelProvider");
    expect(resumeRequestParams?.approvalsReviewer).toBe("auto_review");
    expect(requests.find((request) => request.method === "turn/start")).toMatchObject({
      params: {
        model: "gpt-5.5",
        collaborationMode: { settings: { model: "gpt-5.5" } },
      },
    });
    expect(await readCodexAppServerBinding(sessionFile)).toMatchObject({ model: "gpt-5.5" });
  });
  it("does not apply bound local model providers to provider-qualified resumed models", async () => {
    const { sessionFile, workspaceDir } = createRunPaths();
    await writeExistingBinding(sessionFile, workspaceDir, {
      model: "local-model",
      modelProvider: "lmstudio",
    });
    const { requests, waitForMethod, completeTurn } = createResumeHarness();
    const params = createParams(sessionFile, workspaceDir);
    params.provider = "codex";
    params.modelId = "openai/gpt-5.5";
    const run = runCodexAppServerAttempt(params, {
      pluginConfig: {
        appServer: {
          mode: "guardian",
          approvalsReviewer: "guardian_subagent",
        },
      },
    });
    await completeStartedRun(run, waitForMethod, completeTurn, "thread-existing");
    const resumeRequest = requests.find((request) => request.method === "thread/resume");
    const resumeRequestParams = resumeRequest?.params as Record<string, unknown> | undefined;
    expect(resumeRequestParams?.model).toBe("gpt-5.5");
    expect(resumeRequestParams?.modelProvider).toBe("openai");
    expect(resumeRequestParams?.approvalsReviewer).toBe("guardian_subagent");
  });

  registerCodexFastModeTests({ createRunPaths, writeExistingBinding, completeStartedRun });

  it("announces Codex app-server fast auto progress after the crossing tool result", async () => {
    const { harness, now, onAgentEvent, onToolResult, run, workspaceDir } =
      await startFastAutoProgressTest();
    const notifyCommand = async (id: string, output: string, nowMs: number) => {
      await harness.notify(
        itemNotification("item/started", {
          type: "commandExecution",
          id,
          command: `echo ${id}`,
          cwd: workspaceDir,
          status: "inProgress",
        }),
      );
      now.mockReturnValue(nowMs);
      await harness.notify(
        itemNotification("item/completed", {
          type: "commandExecution",
          id,
          command: `echo ${id}`,
          cwd: workspaceDir,
          status: "completed",
          aggregatedOutput: output,
          exitCode: 0,
          durationMs: 1,
        }),
      );
    };
    await notifyCommand("tool-before", "before", 20_000);
    await notifyCommand("tool-crossing", "crossing", 35_500);
    await notifyCommand("tool-after", "after", 42_000);
    await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    await run;
    const payloads = onToolResult.mock.calls.map(([payload]) => payload) as Array<{
      channelData?: Record<string, unknown>;
      text?: string;
    }>;
    const texts = payloads.map((payload) => payload.text ?? "");
    expect(texts.filter((text) => text.startsWith("💨Fast: auto-off"))).toEqual([
      "💨Fast: auto-off(34s>=30s)",
    ]);
    expect(texts.filter((text) => text === "💨Fast: auto-on")).toHaveLength(1);
    const offIndex = texts.indexOf("💨Fast: auto-off(34s>=30s)");
    const onIndex = texts.indexOf("💨Fast: auto-on");
    expect(offIndex).toBeGreaterThan(0);
    expect(onIndex).toBeGreaterThan(offIndex + 1);
    expect(texts.slice(offIndex + 1, onIndex).some((text) => !text.startsWith("💨Fast:"))).toBe(
      true,
    );
    expect(payloads[offIndex]?.channelData).toEqual({
      openclawProgressKind: "fast-mode-auto",
    });
    expect(payloads[onIndex]?.channelData).toEqual({
      openclawProgressKind: "fast-mode-auto",
    });
    expect(fastProgressEventSummaries(onAgentEvent)).toEqual([
      "💨Fast: auto-off(34s>=30s)",
      "💨Fast: auto-on",
    ]);
  });

  it("announces Codex app-server fast auto progress for raw function call outputs", async () => {
    const { harness, now, onAgentEvent, onToolResult, run } = await startFastAutoProgressTest();
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    now.mockReturnValue(35_500);
    await harness.notify(
      rawItemCompleted({
        type: "function_call_output",
        id: "call-raw-output",
        call_id: "call-raw-output",
        output: "tool output",
      }),
    );
    await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    await run;
    const texts = onToolResult.mock.calls.map(([payload]) => payload.text ?? "");
    expect(texts.filter((text) => text.startsWith("💨Fast: auto-off"))).toEqual([
      "💨Fast: auto-off(34s>=30s)",
    ]);
    expect(texts.filter((text) => text === "💨Fast: auto-on")).toHaveLength(1);
    expect(fastProgressEventSummaries(onAgentEvent)).toEqual([
      "💨Fast: auto-off(34s>=30s)",
      "💨Fast: auto-on",
    ]);
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */

describe("saved assistant occurrence settlement", () => {
  it.each([{ label: "failed after sleep", barrier: true, commentary: false }])(
    "defers $label lifecycle terminal ownership",
    async ({ barrier, commentary }) => {
      const onRunAgentEvent = vi.fn();
      const harness = createStartedThreadHarness();
      const params = createTestParams();
      const error = "codex exploded";
      const target = {
        agentId: "main",
        sessionKey: params.sessionKey!,
        sessionId: params.sessionId,
        storePath: path.join(tempDir, "agents/main/sessions/sessions.json"),
      };
      await upsertSessionEntry({
        ...target,
        entry: { sessionId: params.sessionId, updatedAt: Date.now() },
      });
      params.sessionTarget = target;
      params.deferTerminalLifecycle = true;
      params.onAgentEvent = onRunAgentEvent;
      const run = runCodexAppServerAttempt(params);
      await harness.waitForMethod("turn/start");

      if (commentary) {
        await harness.notify(
          itemNotification("item/completed", {
            id: "commentary-1",
            type: "agentMessage",
            phase: "commentary",
            text: "Earlier commentary",
            status: "completed",
          }),
        );
      } else {
        const earlier = {
          id: "earlier-final",
          type: "agentMessage",
          phase: "final_answer",
          text: "Earlier final",
        };
        await harness.notify(itemNotification("item/started", { ...earlier, text: "" }));
        await harness.notify({
          method: "item/agentMessage/delta",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            itemId: earlier.id,
            delta: earlier.text,
          },
        });
        await harness.notify(itemNotification("item/completed", earlier));
        if (barrier) {
          const sleep = { id: "sleep-1", type: "sleep", durationMs: 250 };
          await harness.notify(itemNotification("item/started", sleep));
          await harness.notify(itemNotification("item/completed", sleep));
        }
        await harness.notify(
          itemNotification("item/started", {
            id: "msg-1",
            type: "agentMessage",
            phase: "final_answer",
            text: "",
          }),
        );
      }
      await harness.notify({
        method: "item/agentMessage/delta",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          itemId: "msg-1",
          delta: "hello back",
        },
      });
      await harness.notify(
        turnCompleted({
          id: "turn-1",
          status: "failed",
          items: [],
          error: { message: error },
        }),
      );
      const result = await run;

      const lifecycleEvents = onRunAgentEvent.mock.calls
        .map(([event]) => event)
        .filter((event) => event.stream === "lifecycle");
      expect(lifecycleEvents.map((event) => event.data.phase)).toEqual([
        "start",
        "model",
        "finishing",
      ]);
      expect(lifecycleEvents.at(-1)?.data.error).toBe(error);
      expect(result.assistantTranscriptIdempotencyKey).toBe(
        "codex-app-server:thread-1:turn-1:assistant",
      );
      expect(lifecycleEvents.at(-1)?.data.assistantTranscriptIdempotencyKey).toBe(
        result.assistantTranscriptIdempotencyKey,
      );
      if (!commentary) {
        const selectedText = barrier ? "hello back" : "Earlier final\n\nhello back";
        expect(result.assistantTexts.join("\n\n")).toBe(selectedText);
        const assistantEvents = onRunAgentEvent.mock.calls
          .map(([event]) => event)
          .filter((event) => event.stream === "assistant");
        expect(assistantEvents.at(-1)?.data).toEqual({
          text: selectedText,
          itemId: result.assistantTranscriptIdempotencyKey,
          replace: true,
          replaceable: true,
        });
      }
    },
  );
});

async function startAttempt(
  requestImpl?: Parameters<typeof createStartedThreadHarness>[0],
  options?: Parameters<typeof runCodexAppServerAttempt>[1],
) {
  vi.useFakeTimers({
    toFake: ["Date", "setTimeout", "clearTimeout"],
    shouldAdvanceTime: false,
  });
  const turnAccepted = createDeferred<void>();
  const params = createTestParams();
  params.onExecutionPhase = ({ phase }) => {
    if (phase === "turn_accepted") {
      turnAccepted.resolve();
    }
  };
  const harness = createStartedThreadHarness(requestImpl);
  const run = runCodexAppServerAttempt(params, options);
  await Promise.race([
    turnAccepted.promise,
    run.then(() => {
      throw new Error("Codex attempt ended before turn acceptance");
    }),
  ]);
  return { harness, run };
}

describe("runCodexAppServerAttempt", () => {
  it.each([true])("continues after bounded plan restoration (failure: %s)", async (fails) => {
    const { harness, run } = await startAttempt(async (method) => {
      if (fails && method === "thread/inject_items") {
        throw new Error("injected test failure");
      }
      return undefined;
    });
    await harness.notify({
      method: "turn/plan/updated",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        explanation: "e".repeat(10_000),
        plan: Array.from({ length: 100 }, (_, index) => ({
          step: `${index}: ${"x".repeat(2_000)}`,
          status: index === 0 ? "inProgress" : "pending",
        })),
      },
    });
    await harness.notify(
      itemNotification("item/started", { type: "contextCompaction", id: "compact-1" }),
    );
    await harness.notify(
      itemNotification("item/completed", { type: "contextCompaction", id: "compact-1" }),
    );

    const request = harness.requests.find((entry) => entry.method === "thread/inject_items");
    const text = (
      request?.params as { items?: Array<{ content?: Array<{ text?: string }> }> } | undefined
    )?.items?.[0]?.content?.[0]?.text;
    expect(text).toBeDefined();
    const payloadText = text?.slice((text?.indexOf("\n") ?? -1) + 1) ?? "";
    const payload = JSON.parse(payloadText) as {
      markdown?: string;
      plan: Array<{ step: string; status: string }>;
    };
    expect(Buffer.byteLength(payloadText, "utf8")).toBeLessThanOrEqual(32 * 1024);
    expect(Buffer.byteLength(payload.markdown ?? "", "utf8")).toBeLessThanOrEqual(2 * 1024);
    expect(payload.plan.length).toBeLessThanOrEqual(50);
    expect(payload.plan.every((step) => Buffer.byteLength(step.step, "utf8") <= 512)).toBe(true);
    expect(payload.plan[0]?.status).toBe("in_progress");

    await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    const result = await run;
    expect(readAttemptTerminal(result).promptError).toBeNull();
  });
});

describe("runCodexAppServerAttempt native lifecycle", () => {
  it("releases completion and native hook relay state after marker plus interrupted completion", async () => {
    const { harness, run } = await startAttempt(undefined, {
      nativeHookRelay: { enabled: true },
    });
    let resolved = false;
    void run.then(() => {
      resolved = true;
    });

    const startRequest = harness.requests.find((request) => request.method === "thread/start");
    const relayId = extractRelayIdFromThreadRequest(startRequest?.params);
    await harness.notify(
      rawItemCompleted({
        id: "abort-marker-1",
        type: "message",
        role: "user",
        content: [
          {
            type: "input_text",
            text: "<turn_aborted>\nThe user interrupted the previous turn on purpose. Any running unified exec processes may still be running in the background. If any tools/commands were aborted, they may have partially executed.\n</turn_aborted>",
          },
        ],
      }),
    );

    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(resolved).toBe(false);
    expect(nativeHookRelayTesting.getNativeHookRelayRegistrationForTests(relayId)).toBeDefined();

    await harness.notify(turnCompleted({ id: "turn-1", status: "interrupted", items: [] }));

    const result = await run;
    expect(resolved).toBe(true);
    expect(readAttemptTerminal(result).aborted).toBe(true);
    expect(readAttemptTerminal(result).timedOut).toBe(false);
    expect(readAttemptTerminal(result).promptError).toBeNull();
    expect(harness.request.mock.calls.some(([method]) => method === "turn/interrupt")).toBe(false);
    expect(nativeHookRelayTesting.getNativeHookRelayRegistrationForTests(relayId)).toBeUndefined();
    await expect(
      invokeNativeHookRelay({
        provider: "codex",
        relayId,
        event: "pre_tool_use",
        rawPayload: {
          hook_event_name: "PreToolUse",
          tool_name: "Bash",
          tool_input: { command: "pnpm test" },
        },
      }),
    ).rejects.toThrow("native hook relay not found");
    await nativeHookRelayUnregisterQueue.flush();
    expect(nativeHookRelayTesting.getNativeHookRelayRegistrationForTests(relayId)).toBeUndefined();
  });
});

function expectUsageLimitPromptError(value: unknown): Error & { status: 429 } {
  expect(value).toBeInstanceOf(Error);
  const error = value as Error & { status?: unknown };
  expect(error.status).toBe(429);
  return error as Error & { status: 429 };
}

function createUsageParams(agentDirectory?: string) {
  return Object.assign(
    createParams(path.join(tempDir, "session.jsonl"), path.join(tempDir, "workspace")),
    {
      ...(agentDirectory ? { agentDir: path.join(tempDir, agentDirectory) } : {}),
      authProfileId: "openai:work",
      authProfileStore: {
        version: 1,
        profiles: {
          "openai:work": {
            type: "oauth",
            provider: "openai",
            access: "placeholder",
            refresh: "placeholder",
            expires: Date.now() + 60_000,
          },
        },
      },
    } satisfies Partial<ReturnType<typeof createParams>>,
  );
}

describe("runCodexAppServerAttempt usage limits", () => {
  it("preserves Codex usage-limit reset details when turn/start fails", async () => {
    const resetsAt = Math.ceil(Date.now() / 1000) + 120;
    const harnessRef: { current?: ReturnType<typeof createStartedThreadHarness> } = {};
    const harness = createStartedThreadHarness(async (method) => {
      if (method === "turn/start") {
        if (!harnessRef.current) {
          throw new Error("Expected Codex app-server harness to be initialized");
        }
        const revisionBeforeUpdate = readCodexRateLimitsRevision(harnessRef.current.client);
        await harnessRef.current.notify(rateLimitsUpdated(resetsAt));
        expect(readCodexRateLimitsRevision(harnessRef.current.client)).toBe(
          revisionBeforeUpdate + 1,
        );
        throw Object.assign(new Error("You've reached your usage limit."), {
          data: { codexErrorInfo: "usageLimitExceeded" },
        });
      }
      return undefined;
    });
    harnessRef.current = harness;

    const params = createUsageParams("agent");

    const result = await runCodexAppServerAttempt(params);
    expect(readAttemptTerminal(result).promptErrorSource).toBe("prompt");
    const promptError = expectUsageLimitPromptError(readAttemptTerminal(result).promptError);
    expect(promptError.message).toContain("You've reached your Codex subscription usage limit.");
    expect(promptError.message).toContain("Next reset in");
  });

  it("does not trust an unrelated in-turn rate-limit update for profile blocking", async () => {
    const resetsAt = Math.ceil(Date.now() / 1000) + 120;
    const authProfileId = "openai:work";
    const harnessRef: { current?: ReturnType<typeof createStartedThreadHarness> } = {};
    const harness = createStartedThreadHarness(async (method) => {
      if (method === "turn/start") {
        if (!harnessRef.current) {
          throw new Error("Expected Codex app-server harness to be initialized");
        }
        await harnessRef.current.notify({
          method: "account/rateLimits/updated",
          params: {
            rateLimits: {
              limitId: "codex_other",
              primary: { usedPercent: 100, windowDurationMins: 60, resetsAt: resetsAt + 60 },
              rateLimitReachedType: "rate_limit_reached",
            },
          },
        });
        throw Object.assign(new Error("You've reached your usage limit."), {
          data: { codexErrorInfo: "usageLimitExceeded" },
        });
      }
      return undefined;
    });
    harnessRef.current = harness;
    rememberCodexRateLimitsRead(harness.client, {
      rateLimits: {
        limitId: "codex",
        primary: { usedPercent: 100, windowDurationMins: 300, resetsAt },
        rateLimitReachedType: "rate_limit_reached",
      },
    });
    const params = createUsageParams();

    const result = await runCodexAppServerAttempt(params);

    expect(expectUsageLimitPromptError(readAttemptTerminal(result).promptError).message).toContain(
      "Next reset in",
    );
    expect(params.authProfileStore.usageStats?.[authProfileId]?.blockedUntil).toBeUndefined();
  });

  it.each([
    { ordinaryUsageAllowed: true, usedPercent: 100 },
    { ordinaryUsageAllowed: null, usedPercent: 100 },
  ])(
    "does not block a refreshed account with ordinary permission $ordinaryUsageAllowed and $usedPercent% usage",
    async ({ ordinaryUsageAllowed, usedPercent }) => {
      const resetsAt = Math.ceil(Date.now() / 1000) + 120;
      const authProfileId = "openai:work";
      const harness = createStartedThreadHarness(async (method) => {
        if (method === "turn/start") {
          throw Object.assign(new Error("You've reached your usage limit."), {
            data: { codexErrorInfo: "usageLimitExceeded" },
          });
        }
        if (method === "account/rateLimits/read") {
          return {
            ...(ordinaryUsageAllowed === undefined ? {} : { ordinaryUsageAllowed }),
            rateLimits: {
              limitId: "codex",
              primary: { usedPercent, windowDurationMins: 300, resetsAt },
              secondary: null,
              rateLimitReachedType: null,
            },
          };
        }
        return undefined;
      });
      const params = createUsageParams("available-usage-limit-agent");
      saveAuthProfileStore(params.authProfileStore, params.agentDir);

      const run = runCodexAppServerAttempt(params);
      await harness.waitForMethod("account/rateLimits/read");

      const result = await run;
      expect(readAttemptTerminal(result).promptErrorSource).toBe("prompt");
      const promptError = expectUsageLimitPromptError(readAttemptTerminal(result).promptError);
      if (ordinaryUsageAllowed === null) {
        expect(promptError.message).toContain("could not determine a reset time");
        expect(promptError.message).not.toContain("Next reset");
        expect(promptError.message).not.toContain("does not report an exhausted limit");
      } else {
        expect(promptError.message).toContain(
          "current account usage does not report an exhausted limit",
        );
        expect(promptError.message).not.toContain("subscription usage limit");
        expect(promptError.message).not.toContain("could not determine a reset time");
      }
      expect(params.authProfileStore.usageStats?.[authProfileId]?.blockedUntil).toBeUndefined();
    },
  );

  it("refreshes Codex account rate limits when a failed turn omits reset details", async () => {
    const resetsAt = Math.ceil(Date.now() / 1000) + 120;
    const authProfileId = "openai:work";
    const harness = createStartedThreadHarness(async (method) => {
      if (method === "account/rateLimits/read") {
        return rateLimitsUpdated(resetsAt).params;
      }
      return undefined;
    });

    const params = createUsageParams("streamed-usage-limit-agent");
    saveAuthProfileStore(params.authProfileStore, params.agentDir);
    const run = runCodexAppServerAttempt(params);
    await harness.waitForMethod("turn/start");
    await harness.notify(
      turnCompleted({
        id: "turn-1",
        status: "failed",
        error: {
          message: "You've reached your usage limit.",
          codexErrorInfo: "usageLimitExceeded",
        },
      }),
    );

    const result = await run;

    const promptError = expectUsageLimitPromptError(readAttemptTerminal(result).promptError);
    expect(promptError.message).toContain("You've reached your Codex subscription usage limit.");
    expect(promptError.message).toContain("Next reset in");
    expect(promptError.message).not.toContain("Codex did not return a reset time");
    expect(params.authProfileStore.usageStats?.[authProfileId]?.blockedUntil).toBe(resetsAt * 1000);
    expect(harness.requests.some((request) => request.method === "account/rateLimits/read")).toBe(
      true,
    );
  });

  it.each([
    {
      error: { message: "You've reached your usage limit.", codexErrorInfo: "usageLimitExceeded" },
      blocked: true,
    },
    {
      error: {
        message: "Too many requests; please retry later.",
        codexErrorInfo: { responseTooManyFailedAttempts: { httpStatusCode: 429 } },
      },
      blocked: false,
    },
  ])(
    "blocks only native usage exhaustion with trusted in-turn limits: $blocked",
    async ({ error, blocked }) => {
      const resetsAt = Math.ceil(Date.now() / 1000) + 120;
      const authProfileId = "openai:work";
      const harness = createStartedThreadHarness(async () => undefined);
      const params = createUsageParams("trusted-streamed-usage-limit-agent");
      saveAuthProfileStore(params.authProfileStore, params.agentDir);

      const run = runCodexAppServerAttempt(params);
      await harness.waitForMethod("turn/start");
      await harness.notify(rateLimitsUpdated(resetsAt));
      await harness.notify(turnCompleted({ id: "turn-1", status: "failed", error }));

      const result = await run;

      expect(
        expectUsageLimitPromptError(readAttemptTerminal(result).promptError).message,
      ).toContain(blocked ? "Next reset in" : error.message);
      expect(params.authProfileStore.usageStats?.[authProfileId]?.blockedUntil).toBe(
        blocked ? resetsAt * 1000 : undefined,
      );
      expect(harness.requests.some((request) => request.method === "account/rateLimits/read")).toBe(
        false,
      );
    },
  );
});
