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
import { replaceRuntimeAuthProfileStoreSnapshots } from "openclaw/plugin-sdk/agent-runtime";
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
import { setRuntimeConfigSnapshot } from "openclaw/plugin-sdk/runtime-config-snapshot";
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
import { prepareTestNativeExecutionPolicy } from "./native-execution-policy.test-support.js";
import { nativeHookRelayUnregisterQueue } from "./native-hook-relay-state.js";
import {
  buildCodexAppServerConnectionFingerprint,
  buildCodexPluginAppCacheKey,
} from "./plugin-app-cache-key.js";
import { codexApprovalTimeoutText } from "./plugin-approval-roundtrip.js";
import {
  appInfo,
  appSummary,
  pluginDetail,
  pluginInstalled,
  pluginList,
  pluginSummary,
} from "./plugin-inventory.test-helpers.js";
import { buildCodexPluginThreadConfig } from "./plugin-thread-config.js";
import {
  flattenCodexDynamicToolFunctions,
  isJsonObject,
  type CodexDynamicToolFunctionSpec,
  type CodexDynamicToolSpec,
  type CodexThreadStartParams,
  type CodexThreadResumeParams,
  type CodexTurnStartParams,
  type CodexServerNotification,
  type JsonObject,
  type v2,
} from "./protocol.js";
import { itemNotification, rawItemCompleted, turnCompleted } from "./protocol.test-helpers.js";
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
import { registerCodexUsageLimitTests } from "./run-attempt.usage-limits.test-support.js";
import { registerCodexWorkspacePolicyTests } from "./run-attempt.workspace-policy.test-support.js";
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
  createLifecycleRequest,
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
  overrides: Partial<Parameters<typeof buildDynamicTools>[0]> = {},
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
    ...overrides,
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
) {
  const signal = new AbortController().signal;
  return createCodexDynamicToolBridge({
    tools,
    registeredTools,
    signal,
    directToolNames: resolveCodexDynamicToolDirectNames(params, registeredTools, false),
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
  const nativeToolSurfaceEnabled = shouldEnableCodexAppServerNativeToolSurface(params, undefined, {
    nativeExecutionPolicy: await prepareTestNativeExecutionPolicy(params),
  });
  const dynamicTools = await buildDynamicToolsForTest(params, workspaceDir, {
    nativeToolSurfaceEnabled,
    pluginConfig: options.pluginConfig ?? {},
    effectiveCwd: undefined,
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

function createRunFixture(identity?: Parameters<typeof createParams>[2]) {
  const paths = createRunPaths();
  return { ...paths, params: createParams(paths.sessionFile, paths.workspaceDir, identity) };
}

type AttemptHarness = ReturnType<typeof createStartedThreadHarness>;

type RequestParams = {
  "thread/start": CodexThreadStartParams;
  "thread/resume": CodexThreadResumeParams;
  "turn/start": CodexTurnStartParams;
  "environment/add": { environmentId?: string; execServerUrl?: string };
};

function getRequestParams<M extends keyof RequestParams>(
  requests: ReadonlyArray<{ method: string; params?: unknown }>,
  method: M,
): RequestParams[M] | undefined {
  return requests.find((request) => request.method === method)?.params as
    | RequestParams[M]
    | undefined;
}

function turnInput(requests: AttemptHarness["requests"]) {
  const first = getRequestParams(requests, "turn/start")?.input?.[0];
  return first?.type === "text" ? first.text : "";
}

function getMockRequestParams<M extends keyof RequestParams>(
  mock: { mock: { calls: ReadonlyArray<readonly [string, ...unknown[]]> } },
  method: M,
) {
  return getRequestParams(
    mock.mock.calls.map(([name, params]) => ({ method: name, params })),
    method,
  );
}

function turnNotification(method: string, params: JsonObject): CodexServerNotification {
  return { method, params: { threadId: "thread-1", turnId: "turn-1", ...params } };
}

function emit(harness: AttemptHarness, method: string, params: JsonObject) {
  return harness.notify(turnNotification(method, params));
}

function emitItem(harness: AttemptHarness, phase: "started" | "completed", item: JsonObject) {
  return harness.notify(itemNotification(`item/${phase}`, item));
}

function expectEvent(spy: ReturnType<typeof vi.fn>, stream: string, data: unknown) {
  expect(spy).toHaveBeenCalledWith({ stream, data });
}

function eventsFor(spy: ReturnType<typeof vi.fn>, stream: string) {
  return spy.mock.calls.map(([event]) => event).filter((event) => event.stream === stream);
}

function callTool(
  harness: AttemptHarness,
  id: string,
  callId: string,
  tool: string,
  args: JsonObject,
) {
  return harness.handleServerRequest({
    id,
    method: "item/tool/call",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      callId,
      namespace: null,
      tool,
      arguments: args,
    },
  });
}

async function finishRun<T>(
  run: Promise<T>,
  harness: Pick<AttemptHarness, "waitForMethod" | "completeTurn">,
  threadId = "thread-1",
) {
  await awaitTurnStart(harness, run);
  await harness.completeTurn({ threadId, turnId: "turn-1" });
  return await run;
}

function awaitTurnStart(harness: Pick<AttemptHarness, "waitForMethod">, run: Promise<unknown>) {
  return awaitGateBeforeSettlement(
    harness.waitForMethod("turn/start"),
    run,
    "Codex attempt settled before turn/start",
  );
}

function nextImmediate() {
  return new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

async function bindingTimestamp(sessionFile: string) {
  const binding = await readCodexAppServerBinding(sessionFile);
  const timestamp = Date.parse(binding?.historyCoveredThrough ?? "");
  assert(Number.isFinite(timestamp), "expected valid Codex binding timestamp");
  return timestamp;
}

function enableRuntimeTools(params: EmbeddedRunAttemptParams) {
  params.disableTools = false;
  setCodexTestModelSupportsTools(params, true);
  params.runtimePlan = createCodexRuntimePlanFixture();
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

function googleCalendarAppInfo(isEnabled: boolean): v2.AppInfo {
  return { ...appInfo("google-calendar-app", true, isEnabled), name: "Google Calendar" };
}

const GOOGLE_CALENDAR_PLUGIN_SUMMARY = pluginSummary("google-calendar", {
  installed: true,
  enabled: true,
});
const GOOGLE_CALENDAR_PLUGIN_INSTALLED_RESULT = pluginInstalled([GOOGLE_CALENDAR_PLUGIN_SUMMARY]);
const GOOGLE_CALENDAR_PLUGIN_LIST_RESULT = pluginList([GOOGLE_CALENDAR_PLUGIN_SUMMARY]);
const GOOGLE_CALENDAR_PLUGIN_READ_RESULT = pluginDetail("google-calendar", [
  { ...appSummary("google-calendar-app"), name: "Google Calendar" },
]);
GOOGLE_CALENDAR_PLUGIN_READ_RESULT.plugin.mcpServers = ["google-calendar"];

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
  const failedThreadRead = createDeferred<void>();
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
      const response = nativeRequest(method, params, requestOptions);
      if (startIndex === 0 && method === "thread/read") {
        void response.then(() => failedThreadRead.resolve());
      }
      return response;
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
  await failedThreadRead.promise;
  await vi.advanceTimersByTimeAsync(2_000);
  const [readyClient] = await Promise.all([turnStarted.promise, started]);
  readyClient.notify({
    method: "turn/completed",
    params: { threadId: "thread-existing", turn: { id: "turn-1", status: "completed", items: [] } },
  });
  const result = await run;
  return { result, requests, client: readyClient.client };
}

async function startFastAutoProgressTest() {
  const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
  const onToolResult = vi.fn();
  const onAgentEvent = vi.fn();
  const { sessionFile, workspaceDir } = createRunPaths();
  const harness = createStartedThreadHarness();
  const params = createParams(sessionFile, workspaceDir);
  params.verboseLevel = "full";
  params.fastModeAuto = true;
  params.fastModeStartedAtMs = 1_000;
  params.fastModeAutoOnSeconds = 30;
  params.onToolResult = onToolResult;
  params.onAgentEvent = onAgentEvent;
  const run = runCodexAppServerAttempt(params);
  await awaitTurnStart(harness, run);
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
  await finishRun(run, { waitForMethod, completeTurn }, threadId);
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
    const { params } = createRunFixture();

    setCodexTestToolFactory(params, (options) => {
      cleanupOwners.push(options?.registerRunCleanup !== undefined);
      options?.registerRunCleanup?.(cleanup);
      return [createRuntimeDynamicTool("message")];
    });
    enableRuntimeTools(params);
    const harness = createStartedThreadHarness();

    const run = runCodexAppServerAttempt(params);
    await finishRun(run, harness);

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
    const { params } = createRunFixture();

    setCodexTestToolFactory(params, (options) => {
      options?.registerRunCleanup?.(cleanup);
      throw preparationError;
    });
    const warning = vi.spyOn(embeddedAgentLog, "warn");
    params.oneShotCliRun = true;
    enableRuntimeTools(params);

    const harness = createStartedThreadHarness();
    await expect(
      completeStartedRun(
        runCodexAppServerAttempt(params),
        harness.waitForMethod,
        harness.completeTurn,
      ),
    ).rejects.toBe(preparationError);
    expect(cleanup).toHaveBeenCalledOnce();
    expect(warning).toHaveBeenCalledWith(
      expect.stringContaining("step=codex-dynamic-tool-cleanup error=Codex tool cleanup failed"),
    );
  });

  it("executes and reports the same materialized SecretRef credential", async () => {
    const { agentDir, params } = createRunFixture();
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

    params.agentDir = agentDir;
    params.authProfileId = authProfileId;
    params.authProfileStore = authProfileStore;
    params.config = config;
    setRuntimeConfigSnapshot(params.config);
    const expected = await prepareCodexAppServerAuthBinding({
      authProfileId,
      authProfileStore,
      agentDir,
      config,
    });
    const run = runCodexAppServerAttempt(params);
    const result = await finishRun(run, harness);
    expect(result.authBindingFingerprint).toBe(expected?.fingerprint);
    expect(clientOptions?.authBindingFingerprint).toBe(expected?.fingerprint);
    expect(clientOptions?.authProfileStore?.profiles[authProfileId]).toEqual({
      type: "api_key",
      provider: "openai",
      key: "work-key",
    });
    expect(authProfileStore.profiles[authProfileId]).toHaveProperty("keyRef");
  });
  it.each([false, true])(
    "routes sandbox execution through exec-server only when opted in: %s",
    async (execServer) => {
      const { workspaceDir, params } = createRunFixture();
      setCodexTestToolFactory(params, () =>
        ["exec", "process", "message"].map(createRuntimeDynamicTool),
      );
      enableRuntimeTools(params);
      const appServer = {
        ...createThreadLifecycleAppServerOptions(),
        ...(execServer ? { sandbox: "danger-full-access" as const } : {}),
      };
      const sandbox = execServer
        ? {
            ...createSandboxContext({
              runShellCommand: async () => ({
                stdout: Buffer.alloc(0),
                stderr: Buffer.alloc(0),
                code: 0,
              }),
            }),
            backendId: "codex-test-sandbox",
            runtimeId: "codex-test-runtime-" + path.basename(tempDir),
            runtimeLabel: "Codex Test Sandbox",
          }
        : { enabled: true, backendId: "codex-test-sandbox", workspaceAccess: "rw" };
      const request = vi.fn(async (method: string, _requestParams?: unknown) => {
        if (method === "config/read") {
          return execServer ? { config: {}, origins: {}, layers: [] } : { config: {}, layers: [] };
        }
        if (execServer && method === "configRequirements/read") {
          return { requirements: null };
        }
        if (execServer && method === "environment/add") {
          return {};
        }
        if (method === "thread/start") {
          return threadStartResult();
        }
        throw new Error("unexpected method: " + method);
      });
      const client = { ...(execServer ? mockClientRuntimeMethods() : {}), request };
      try {
        if (execServer) {
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
          setRuntimeConfigSnapshot(params.config);
        }
        const nativeToolSurfaceEnabled = shouldEnableCodexAppServerNativeToolSurface(
          params,
          sandbox as never,
          {
            ...(execServer ? { sandboxExecServerEnabled: true } : {}),
            nativeExecutionPolicy: await prepareTestNativeExecutionPolicy(params, {
              sandbox: sandbox as never,
            }),
          },
        );
        const dynamicTools = await buildDynamicToolsForTest(params, workspaceDir, {
          effectiveWorkspace: execServer ? "/workspace" : workspaceDir,
          sandbox: sandbox as never,
          nativeToolSurfaceEnabled,
          pluginConfig: execServer
            ? { appServer: { mode: "yolo", experimental: { sandboxExecServer: true } } }
            : {},
          effectiveCwd: undefined,
        });
        const environment = execServer
          ? await ensureCodexSandboxExecServerEnvironment({
              client: client as never,
              sandbox: sandbox as never,
              appServerStartOptions: appServer.start,
            })
          : undefined;
        if (execServer) {
          assert(environment, "expected sandbox exec-server environment");
        }
        const environmentSelection = environment ? [environment] : [];
        await startOrResumeThread({
          client: client as never,
          params,
          cwd: environment?.cwd ?? workspaceDir,
          dynamicTools: dynamicTools as never,
          appServer,
          nativeCodeModeEnabled: nativeToolSurfaceEnabled,
          nativeCodeModeOnlyEnabled: false,
          userMcpServersEnabled: nativeToolSurfaceEnabled,
          environmentSelection,
        });
        const startParams = getMockRequestParams(request, "thread/start");
        expect(startParams?.config).toMatchObject({
          "features.code_mode": execServer,
          "features.code_mode_only": false,
        });
        expect(specNames(startParams?.dynamicTools ?? [])).toEqual(
          execServer ? ["message"] : ["message", "sandbox_exec", "sandbox_process"],
        );
        if (!execServer) {
          expect(startParams?.environments).toEqual([]);
          return;
        }
        assert(environment);
        const turnParams = await buildTurnStartParams(params, {
          threadId: "thread-1",
          cwd: environment.cwd,
          appServer,
          sandboxPolicy: { type: "externalSandbox", networkAccess: "enabled" },
          environmentSelection,
        });
        const environmentAddParams = getMockRequestParams(request, "environment/add");
        expect(nativeToolSurfaceEnabled).toBe(true);
        expect(environmentAddParams?.environmentId).toMatch(/^openclaw-sandbox-/);
        expect(environmentAddParams?.execServerUrl).toMatch(new RegExp("^ws://127[.]0[.]0[.]1:"));
        expect(startParams).toMatchObject({
          cwd: "/workspace",
          sandbox: "danger-full-access",
          config: { "features.apply_patch_streaming_events": true },
        });
        expect(startParams?.environments).toEqual([
          { environmentId: environmentAddParams?.environmentId, cwd: "/workspace" },
        ]);
        expect(turnParams.sandboxPolicy).toEqual({
          type: "externalSandbox",
          networkAccess: "enabled",
        });
        expect(turnParams.cwd).toBe("/workspace");
        expect(turnParams.environments).toEqual(startParams?.environments);
      } finally {
        if (execServer) {
          await releaseCodexSandboxExecServerEnvironment(sandbox as never);
        }
      }
    },
  );

  it("emits TUI-compatible tool events for Codex dynamic tool calls", async () => {
    const { params } = createRunFixture();
    const harness = createStartedThreadHarness();
    await attachSqliteSessionTarget(
      params,
      path.join(tempDir, "tool-event-sessions.json"),
      "tool-event-session",
    );
    const onRunAgentEvent = vi.fn();
    params.timeoutMs = 60_000;
    params.onAgentEvent = onRunAgentEvent;
    const run = runCodexAppServerAttempt(params);
    await awaitTurnStart(harness, run);
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
    await finishRun(run, harness);
    expectEvent(onRunAgentEvent, "tool", {
      phase: "start",
      name: "python",
      itemId: "call-1",
      toolCallId: "call-1",
      args: { code: "print('hi')" },
    });
    expectEvent(onRunAgentEvent, "tool", {
      phase: "result",
      name: "python",
      itemId: "call-1",
      toolCallId: "call-1",
      isError: true,
      result: {
        content: [{ type: "text", text: "Unknown OpenClaw tool: python" }],
      },
    });
    const toolPhases = eventsFor(onRunAgentEvent, "tool").map((event) => event.data?.phase);
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
      await finishRun(run, harness);
      const inputText = turnInput(harness.requests);
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
    await emitItem(harness, "started", commentary);
    await emit(harness, "item/agentMessage/delta", { itemId: commentary.id, delta: "I found" });
    const command = {
      type: "commandExecution",
      id: "command-1",
      command: "pwd",
      cwd: workspaceDir,
      status: "inProgress",
    };
    await emitItem(harness, "started", command);
    expect(await readTranscriptMessagesByIdentity(params)).toEqual(messagesBeforeCompletion);
    await emitItem(harness, "completed", commentary);
    await emitItem(harness, "completed", {
      ...command,
      status: "completed",
      aggregatedOutput: workspaceDir,
      exitCode: 0,
    });
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
    await awaitTurnStart(harness, run);
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
    await emitItem(harness, "completed", {
      type: "agentMessage",
      id: "terminal-answer",
      phase: "final_answer",
      text,
    });
    await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    await expect(run).rejects.toBe(disconnectError);
    expectEvent(
      onAgentEvent,
      "lifecycle",
      expect.objectContaining({ phase: "error", error: disconnectError.message }),
    );
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
    await awaitTurnStart(harness, run);
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
    await finishRun(run, harness);
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
    await awaitTurnStart(harness, run);
    const item = {
      type: "fileChange" as const,
      id: "patch-approval-timeout",
      changes: [{ path: "src/example.ts", kind: { type: "add" as const } }],
    };
    await emitItem(harness, "started", {
      ...item,
      status: "inProgress",
      durationMs: null,
    });

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
    await emitItem(harness, "completed", { ...item, status: "declined", durationMs: 1 });
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

  it("keeps a deferred tool schema stable across turns with different tool availability", async () => {
    const { sessionFile, workspaceDir } = createRunPaths();
    const registeredTools = ["message", "web_search"].map(createRuntimeDynamicTool);
    const makeTurn = (webSearchAvailable = false) => {
      const params = createParams(sessionFile, workspaceDir);
      params.disableTools = false;
      params.runtimePlan = createCodexRuntimePlanFixture();
      params.sourceReplyDeliveryMode = "message_tool_only";
      const tools = (webSearchAvailable ? ["message", "web_search"] : ["message"]).map(
        createRuntimeDynamicTool,
      );
      const bridge = createCodexToolBridgeForTest(params, tools, registeredTools);
      return {
        params,
        bridge,
        get instructions() {
          return buildDeveloperInstructions(params, { dynamicTools: bridge.availableSpecs });
        },
      };
    };
    const normal = makeTurn();
    const withWebSearch = makeTurn(true);
    const nextNormal = makeTurn();
    const registeredToolNames = specNames(normal.bridge.specs);
    expect(registeredToolNames).toContain("message");
    expect(registeredToolNames).toContain("web_search");
    expect(normal.instructions).not.toContain(
      "Deferred searchable OpenClaw dynamic tools available: openclaw.web_search",
    );
    expect(withWebSearch.instructions).toContain(
      "Deferred searchable OpenClaw dynamic tools available: openclaw.web_search.",
    );
    for (const bridge of [normal.bridge, withWebSearch.bridge, nextNormal.bridge]) {
      const webSearchSpec = flattenSpecsWithNamespace(bridge.specs).find(
        (tool) => tool.name === "web_search",
      );
      expect(webSearchSpec).toMatchObject({ namespace: "openclaw", deferLoading: true });
    }
    expect(codexDynamicToolsFingerprint(withWebSearch.bridge.specs)).toBe(
      codexDynamicToolsFingerprint(normal.bridge.specs),
    );
    expect(codexDynamicToolsFingerprint(nextNormal.bridge.specs)).toBe(
      codexDynamicToolsFingerprint(normal.bridge.specs),
    );
    let startedThreadId: string | undefined;
    const respond = createLifecycleRequest(async (method) => {
      if (method === "thread/start") {
        startedThreadId = "thread-stable-tools";
        return threadStartResult(startedThreadId);
      }
      if (method === "thread/resume") {
        return threadStartResult(startedThreadId);
      }
      throw new Error(`unexpected method: ${method}`);
    });
    const fixture = await createLeasedCodexLifecycleHarness({
      agentDir: path.join(tempDir, "stable-tools-agent"),
      respond,
    });
    const { client, request } = fixture;
    const turns = [
      { params: createRunParams(), bridge: normal.bridge },
      { params: withWebSearch.params, bridge: withWebSearch.bridge },
      { params: nextNormal.params, bridge: nextNormal.bridge },
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
      await fixture.endTurn("thread-stable-tools");
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
    enableRuntimeTools(params);
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
    expect(startParams?.config).toMatchObject({
      "features.code_mode": false,
      "features.code_mode_only": false,
    });
    expect(startParams?.config?.apps?.["_default"]).toEqual({
      enabled: false,
      destructive_enabled: false,
      open_world_enabled: false,
    });
    expect(startParams?.config?.apps?.["google-calendar-app"]?.enabled).toBeUndefined();
    expect(request.mock.calls.map(([method]) => method)).not.toContain("app/installed");
    expect(request.mock.calls.map(([method]) => method)).not.toContain("app/read");
  });

  it("rejects a legacy managed MDM shell denial before a native creator can start", async () => {
    const params = createRunParams();
    enableRuntimeTools(params);
    const harness = createStartedThreadHarness(async (method) => {
      if (method === "configRequirements/read") {
        return { requirements: null };
      }
      if (method === "config/read") {
        const metadata = {
          name: { type: "legacyManagedConfigTomlFromMdm" },
          version: "sha256:managed-shell-denied",
        };
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
  });

  it("overrides a user-level shell disable when native code mode is enabled", async () => {
    const params = createRunParams();
    enableRuntimeTools(params);
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
    await awaitTurnStart(harness, run);
    await expect(finishRun(run, harness)).resolves.toBeDefined();
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
    enableRuntimeTools(params);
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
    const startParams = getRequestParams(harness.requests, "thread/start");
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
    const response = await callTool(harness, "request-plan-1", "call-plan-1", "progress_card", {
      markdown: "Plan restored",
      plan,
    });
    expect(response).toMatchObject({ success: true });
    expectEvent(onAgentEvent, "plan", {
      phase: "update",
      title: "Plan updated",
      source: "openclaw",
      explanation: "1/2 complete",
      steps: plan,
    });
    expect(executeProgressCard).toHaveBeenCalledTimes(1);

    await emitItem(harness, "started", { type: "contextCompaction", id: "compact-1" });
    await emitItem(harness, "completed", { type: "contextCompaction", id: "compact-1" });
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
    await emit(harness, "turn/plan/updated", {
      explanation: "m".repeat(9_000),
      plan: nativePlan,
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
    await emitItem(harness, "started", { type: "contextCompaction", id: "compact-2" });
    await emitItem(harness, "completed", { type: "contextCompaction", id: "compact-2" });
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

    const noteResponse = await callTool(
      harness,
      "request-plan-note",
      "call-plan-note",
      "progress_card",
      {
        markdown:
          '<progress aria-label="private" value="1" max="2"></progress>\n\n**Working** [results](https://example.com "<script>").',
      },
    );
    expect(noteResponse).toMatchObject({ success: true });
    expectEvent(onAgentEvent, "plan", {
      phase: "update",
      title: "Plan updated",
      source: "openclaw",
      explanation: "Working results.",
      explanationFormat: "plain",
      steps: [],
    });

    const clearResponse = await callTool(
      harness,
      "request-plan-clear",
      "call-plan-clear",
      "progress_card",
      {},
    );
    expect(clearResponse).toMatchObject({ success: true });
    expect(executeProgressCard).toHaveBeenCalledTimes(4);
    expectEvent(onAgentEvent, "plan", {
      phase: "update",
      title: "Plan updated",
      source: "openclaw",
      steps: [],
    });
    await emitItem(harness, "started", { type: "contextCompaction", id: "compact-3" });
    await emitItem(harness, "completed", { type: "contextCompaction", id: "compact-3" });
    expect(
      harness.requests.filter((request) => request.method === "thread/inject_items"),
    ).toHaveLength(2);

    const result = await finishRun(run, harness);
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

  it("keeps private native history out of authorized prompt acquisition and clones", async () => {
    const marker = "synthetic-native-payload:";
    const privateText = marker + "x".repeat(1024 * 1024);
    const hook = vi.fn(() => ({ prependContext: "hook context" }));
    initializeGlobalHookRunner(
      createMockPluginRegistry([
        {
          hookName: "before_prompt_build",
          requiresToolAuthority: true,
          handler: hook,
        },
      ]),
    );
    const { params } = createRunFixture();

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
      const run = runCodexAppServerAttempt(params);
      await finishRun(run, harness);
      expect(privateParseBytes).toBe(0);
      expect(privateCloneBytes).toBe(0);
      expect(historyClones).toBeGreaterThan(0);
      expect(hook).toHaveBeenCalled();
    } finally {
      parseSpy.mockRestore();
      cloneSpy.mockRestore();
    }
  });

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
      const { params } = createRunFixture();
      const harness = createStartedThreadHarness();

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
      await finishRun(run, harness);

      const [, hookContext] = mockCall(beforePromptBuild, "before_prompt_build");
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
    const { params } = createRunFixture();

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
    const { sessionFile, params } = createRunFixture();
    openRunSession(sessionFile).appendMessage(userMessage("previous request", Date.now()));
    const { closeAndWait, events, retireSpy } = installCleanupTrackingClient();
    const abortController = new AbortController();
    const removeAbortListener = vi.spyOn(abortController.signal, "removeEventListener");

    params.abortSignal = abortController.signal;
    params.cleanupBundleMcpOnRunEnd = true;

    await expect(runCodexAppServerAttempt(params)).rejects.toThrow(
      "Codex app-server cannot enforce before_prompt_build toolsAllow",
    );

    expect(beforePromptBuild).toHaveBeenCalledTimes(2);
    expect(events).toContain("request:thread/start");
    expect(events).not.toContain("request:turn/start");
    expect(retireSpy).not.toHaveBeenCalled();
    expect(closeAndWait).not.toHaveBeenCalled();
    expect(removeAbortListener).toHaveBeenCalledWith("abort", expect.any(Function));
  });

  it("preserves binding retention errors while releasing the shared thread subscription", async () => {
    const bindingStore = createCodexTestBindingStore();
    const originalWithLease = bindingStore.withLease.bind(bindingStore);
    const { params } = createRunFixture();

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
    expect(events).toContain("request:turn/start");
    expect(events).toContain("request:thread/unsubscribe");
    expect(events).not.toContain("closeAndWait");
    expect(retireSpy).not.toHaveBeenCalled();
    expect(closeAndWait).not.toHaveBeenCalled();
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
      await finishRun(run, harness);

      const turnStart = harness.requests.find((request) => request.method === "turn/start");
      const inputText = JSON.stringify(turnStart?.params);
      expect(inputText).toContain("Inspect the completed tool evidence, then delegate analysis.");
      expect(inputText).toContain("[Subagent Task]");
      expect(inputText).not.toContain("private-input-fixture.txt");
      expect(inputText.includes("sk-1234567890abcdef")).toBe(preserve);
      expect(inputText).not.toContain("[content omitted]");
      if (preserve) {
        expect(inputText).toContain("COBALT-ORCHID-7429");
      } else {
        expect(inputText).not.toContain("COBALT-ORCHID-7429");
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
    await finishRun(run, harness);

    const inputText = turnInput(harness.requests);
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
    await awaitTurnStart(harness, run);
    await nextImmediate();
    await finishRun(run, harness);
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
    const threadStartParams = getRequestParams(harness.requests, "thread/start");
    expect(threadStartParams?.developerInstructions).toContain("custom codex system 1");
    expect(threadStartParams?.developerInstructions).not.toContain("custom codex system 2");
    const inputText = turnInput(harness.requests);
    expect(inputText).toContain("queued context");
    expect(inputText).toContain("prior visible context");
    expect(inputText).not.toContain("hook-side mutation");
  });

  it.each([false, true])(
    "projects resumed search with retained raw status: %s",
    async (rawStatus) => {
      const { sessionFile, workspaceDir } = createRunPaths();
      await writeExistingBinding(sessionFile, workspaceDir, { dynamicToolsFingerprint: "[]" });
      const harness = createResumeHarness();
      const diagnosticEvents: DiagnosticEventPayload[] = [];
      const item = {
        id: rawStatus ? "resumed-search-with-raw" : "resumed-search",
        type: "webSearch",
        query: rawStatus ? "sensitive warm-resume query" : "sensitive resumed query",
        action: {
          type: "search",
          query: rawStatus ? "sensitive warm-resume query" : "sensitive resumed query",
          queries: null,
        },
      };
      const stopDiagnostics = onInternalDiagnosticEvent((event) => {
        if ("toolCallId" in event && event.toolCallId === item.id) {
          diagnosticEvents.push(event);
        }
      });
      try {
        const run = runCodexAppServerAttempt(createParams(sessionFile, workspaceDir));
        await awaitTurnStart(harness, run);
        await emit(harness, "item/started", { threadId: "thread-existing", item });
        await emit(harness, "item/completed", { threadId: "thread-existing", item });
        if (rawStatus) {
          await emit(harness, "rawResponseItem/completed", {
            threadId: "thread-existing",
            item: {
              id: item.id,
              type: "web_search_call",
              status: "completed",
              action: item.action,
            },
          });
        }
        await harness.completeTurn({ threadId: "thread-existing", turnId: "turn-1" });
        await run;
        await waitForDiagnosticEventsDrained();
      } finally {
        stopDiagnostics();
      }
      expect(diagnosticEvents.map((event) => event.type)).toEqual([
        "tool.execution.started",
        rawStatus ? "tool.execution.completed" : "tool.execution.error",
      ]);
      if (!rawStatus) {
        expect(diagnosticEvents.at(-1)).toMatchObject({
          terminalReason: "failed",
          errorCode: "tool_outcome_unknown",
        });
      }
      expect(JSON.stringify(diagnosticEvents)).not.toContain(item.query);
    },
  );

  it("projects only newer visible history when a resumed Codex binding is stale", async () => {
    const { sessionFile, workspaceDir, params } = createRunFixture();
    await writeExistingBinding(sessionFile, workspaceDir, { dynamicToolsFingerprint: "[]" });
    const bindingUpdatedAt = await bindingTimestamp(sessionFile);
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

    params.prompt = "is the previous message trustworthy?";
    const run = runCodexAppServerAttempt(params);
    await awaitTurnStart(harness, run);
    await nextImmediate();
    await harness.completeTurn({ threadId: "thread-existing", turnId: "turn-1" });
    await run;
    expect(harness.requests.map((request) => request.method)).toContain("thread/resume");
    const inputText = turnInput(harness.requests);
    expect(inputText).toContain("OpenClaw assembled context for this turn:");
    expect(inputText).toContain("we were discussing the Sonnet leak screenshots");
    expect(inputText).toContain("David Ondrej was mentioned in that prior thread");
    expect(inputText).toContain("copilot mirror context also matters");
    expect(inputText).toContain("Current user request:");
    expect(inputText).toContain("is the previous message trustworthy?");
    expect(inputText).not.toContain("old native-owned context");
  });
  it("sizes stale-binding resume continuity from the session's recorded density", async () => {
    const { sessionFile, workspaceDir, params } = createRunFixture();
    await writeExistingBinding(sessionFile, workspaceDir, {
      dynamicToolsFingerprint: "[]",
      // A dense session: 1 char/token observed on the previous completed turn.
      continuityCalibration: { promptChars: 200_000, inputTokens: 200_000 },
    });
    const bindingUpdatedAt = await bindingTimestamp(sessionFile);
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

    params.contextTokenBudget = 300_000;
    params.prompt = "continue after the dense resume";
    const run = runCodexAppServerAttempt(params);
    await awaitTurnStart(harness, run);
    await nextImmediate();
    await harness.completeTurn({ threadId: "thread-existing", turnId: "turn-1" });
    await run;
    const inputText = turnInput(harness.requests);
    // At 1 char/token the cap collapses to the reserved token budget itself:
    // (300k − 150k) × 1 = 150,000 chars, plus header/request overhead.
    expect(inputText.length).toBeLessThanOrEqual(160_000);
    expect(inputText).toContain("calibrated recent anchor: continue the audit");
    expect(inputText).not.toContain("calibrated delta block 0:");
  });
  it("calibrates continuity from the latest response while retaining whole-turn usage", async () => {
    const { sessionFile, params } = createRunFixture();
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

    params.contextTokenBudget = 300_000;
    params.prompt = "record this turn's density";
    const run = runCodexAppServerAttempt(params);
    await awaitTurnStart(harness, run);
    for (const inputTokens of [140_000, 150_000]) {
      await emit(harness, "rawResponse/completed", {
        responseId: `response-${inputTokens}`,
        usage: {
          totalTokens: inputTokens + 2_000,
          inputTokens,
          cachedInputTokens: 40_000,
          cacheWriteInputTokens: 10_000,
          outputTokens: 2_000,
          reasoningOutputTokens: 0,
        },
      });
    }
    await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    expect((await run).attemptUsage?.total).toBe(294_000);
    const inputText = turnInput(harness.requests);
    const binding = await readCodexAppServerBinding(sessionFile);
    // Density uses the latest full prompt, including cached input, not cumulative billing.
    expect(binding?.continuityCalibration).toEqual({
      promptChars: inputText.length,
      inputTokens: 150_000,
    });
  });
  it("does not record calibration from a large direct prompt with no continuity projection", async () => {
    const { sessionFile, params } = createRunFixture();
    const harness = createStartedThreadHarness();

    params.contextTokenBudget = 300_000;
    // A dense direct paste, large enough to pass the calibration size floor, on a
    // session with no history to project: the sample must NOT be recorded, or its
    // density would later shrink continuity history it never measured.
    params.prompt = `dense direct paste: ${"y".repeat(80_000)}`;
    const run = runCodexAppServerAttempt(params);
    await awaitTurnStart(harness, run);
    await emit(harness, "thread/tokenUsage/updated", {
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
    });
    await finishRun(run, harness);
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
    await finishRun(firstRun, firstHarness, "thread-existing");
    const firstInputText = turnInput(firstHarness.requests);
    expect(firstInputText).toContain("OpenClaw assembled context for this turn:");
    expect(firstInputText).toContain("we were discussing the Sonnet leak screenshots");
    expect(firstInputText).toContain("is the previous message trustworthy?");
    firstHarness.close();
    const secondHarness = createResumeHarness();
    const secondParams = createParams(sessionFile, workspaceDir);
    secondParams.prompt = "continue from there";
    const secondRun = runCodexAppServerAttempt(secondParams);
    await finishRun(secondRun, secondHarness, "thread-existing");
    const secondInputText = turnInput(secondHarness.requests);
    expect(secondInputText).toContain("continue from there");
    expect(secondInputText).not.toContain("OpenClaw assembled context for this turn:");
    expect(secondInputText).not.toContain("we were discussing the Sonnet leak screenshots");
    expect(secondInputText).not.toContain("is the previous message trustworthy?");
  });

  registerCodexMemoryInstructionTests();

  it("routes AGENTS.md natively and MEMORY.md through tools", async () => {
    const { workspaceDir, params } = createRunFixture();
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

    setCodexTestToolFactory(params, () => [
      createRuntimeDynamicTool("memory_search"),
      createRuntimeDynamicTool("memory_get"),
    ]);
    enableRuntimeTools(params);
    setAgentWorkspaceForTest(params, workspaceDir);
    const {
      collaborationInstructions,
      inputText,
      systemPromptReport,
      threadDeveloperInstructions,
    } = await buildCodexTurnContextForTest(params, workspaceDir);
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
    for (const [name, content] of [
      ["SOUL.md", soulGuidance],
      ["IDENTITY.md", identityGuidance],
      ["USER.md", userProfile],
    ] as const) {
      expect(fileStats.get(name)).toMatchObject({
        rawChars: content.length,
        injectedChars: content.length,
        truncated: false,
      });
    }
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
            await emitItem(harness, "completed", {
              type: "contextCompaction",
              id: "compact-during-start",
            });
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
        await emit(harness, "item/completed", {
          turnId: "compact-1",
          item: { type: "contextCompaction", id: "compact-item" },
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
    const { workspaceDir, params } = createRunFixture();
    const soulGuidance = "Soul guidance ".repeat(80);
    const memorySummary = "Memory summary goes here.";
    await fs.mkdir(workspaceDir, { recursive: true });
    await fs.writeFile(path.join(workspaceDir, "SOUL.md"), soulGuidance);
    await fs.writeFile(path.join(workspaceDir, "MEMORY.md"), memorySummary);
    const harness = createStartedThreadHarness();

    params.config = {
      agents: {
        defaults: {
          bootstrapMaxChars: 1000,
          bootstrapTotalMaxChars: 1000,
        },
      },
    } satisfies NonNullable<EmbeddedRunAttemptParams["config"]>;
    setRuntimeConfigSnapshot(params.config);
    const run = runCodexAppServerAttempt(params);
    await awaitTurnStart(harness, run);
    await nextImmediate();
    const result = await finishRun(run, harness);
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
    await awaitTurnStart(harness, run);
    await nextImmediate();
    const result = await finishRun(run, harness);
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
    expect(getRequestParams(harness.requests, "thread/start")?.developerInstructions).toContain(
      soulGuidance,
    );
  });

  it("keeps lightweight cron Codex turns out of OpenClaw bootstrap context", async () => {
    const { workspaceDir, params } = createRunFixture();
    const exactCommand =
      "Delivery: to send a message, use the `message` tool.\n\ncd /repo && ./scripts/run-cron";
    await fs.mkdir(workspaceDir, { recursive: true });
    await fs.writeFile(path.join(workspaceDir, "AGENTS.md"), "Follow AGENTS guidance.");
    await fs.writeFile(path.join(workspaceDir, "SOUL.md"), "Soul voice goes here.");
    const harness = createStartedThreadHarness();

    params.trigger = "cron";
    params.prompt = exactCommand;
    params.bootstrapContextMode = "lightweight";
    params.bootstrapContextRunKind = "cron";
    params.skillsSnapshot = {
      prompt: "<available_skills><skill><name>demo</name></skill></available_skills>",
      skills: [],
    };
    const run = runCodexAppServerAttempt(params);
    await awaitTurnStart(harness, run);
    await nextImmediate();
    const result = await finishRun(run, harness);
    const threadStartParams = getRequestParams(harness.requests, "thread/start");
    assert(threadStartParams);
    expect(threadStartParams.config?.project_doc_max_bytes).toBe(0);
    expect(threadStartParams.developerInstructions).not.toContain("Soul voice goes here.");
    expect(threadStartParams.developerInstructions).not.toContain("Follow AGENTS guidance.");
    expect(threadStartParams.developerInstructions).not.toContain("<available_skills>");
    const turnStartParams = getRequestParams(harness.requests, "turn/start");
    const firstInput = turnStartParams?.input?.[0];
    assert(firstInput?.type === "text");
    expect(firstInput.text).toBe(exactCommand);
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
    setRuntimeConfigSnapshot(params.config);
    const harness = createStartedThreadHarness();
    const run = runCodexAppServerAttempt(params);
    await completeStartedRun(run, harness.waitForMethod, harness.completeTurn);
    const startParams = getRequestParams(harness.requests, "thread/start");
    const turnParams = getRequestParams(harness.requests, "turn/start");
    expect(startParams).toMatchObject({ approvalPolicy: "never", sandbox: "danger-full-access" });
    expect(turnParams?.approvalPolicy).toBe("never");
    expect(turnParams?.sandboxPolicy).toEqual({ type: "dangerFullAccess" });
  });

  it("preserves a structured provider refusal through attempt finalization", async () => {
    const { sessionFile, workspaceDir } = createRunPaths();
    const harness = createStartedThreadHarness();
    const run = runCodexAppServerAttempt(createParams(sessionFile, workspaceDir));
    await awaitTurnStart(harness, run);
    const error = {
      message: "This content was flagged for possible biological risk. Try rephrasing it.",
      codexErrorInfo: "other",
    };
    await emit(harness, "error", {
      error,
      willRetry: false,
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

    const { params } = createRunFixture();
    const harness = createStartedThreadHarness();

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
    expect(
      specNames(getRequestParams(harness.requests, "thread/start")?.dynamicTools ?? []),
    ).toContain("read");
    await emitItem(harness, "started", {
      type: "dynamicToolCall",
      id: "tool-1",
      namespace: null,
      tool: "read",
      arguments: { path: "README.md" },
      status: "inProgress",
      contentItems: null,
      success: null,
      durationMs: null,
    });
    expect(onToolResult).not.toHaveBeenCalled();
    const response = await callTool(harness, "request-tool-1", "tool-1", "read", {
      path: "README.md",
    });
    expect(response).toMatchObject({
      success: true,
      contentItems: [{ type: "inputText", text: "file contents" }],
    });
    expect(executeRead).toHaveBeenCalledOnce();
    await emitItem(harness, "completed", {
      type: "dynamicToolCall",
      id: "tool-1",
      namespace: null,
      tool: "read",
      arguments: { path: "README.md" },
      status: "completed",
      contentItems: [{ type: "inputText", text: "file contents" }],
      success: true,
      durationMs: 12,
    });
    const result = await finishRun(run, harness);
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
    await awaitTurnStart(harness, run);
    for (const [id, status, exitCode] of [
      ["command-failed-1", "failed", 1],
      ["command-succeeded", "completed", 0],
      ["command-failed-2", "failed", 2],
    ] as const) {
      await emitItem(harness, "started", {
        type: "commandExecution",
        id,
        command: `/bin/bash -lc 'exit ${exitCode}'`,
        cwd: workspaceDir,
        status: "inProgress",
      });
      await emitItem(harness, "completed", {
        type: "commandExecution",
        id,
        command: `/bin/bash -lc 'exit ${exitCode}'`,
        cwd: workspaceDir,
        status,
        aggregatedOutput: "",
        exitCode,
        durationMs: 1,
      });
    }
    const result = await finishRun(run, harness);
    expect(result.toolMetas).toHaveLength(3);
    expect(result.toolMetas.filter((meta) => meta.isError === true)).toHaveLength(2);
  });

  registerCodexWorkspacePolicyTests({ createRunPaths, writeExistingBinding });

  it.each([
    { transient: true, error: "invalid image_url base64 payload" },
    { transient: false, error: "unsupported image input" },
  ])("preserves a healthy binding after $error", async ({ transient, error }) => {
    const { sessionFile, workspaceDir } = createRunPaths();
    await writeExistingBinding(sessionFile, workspaceDir, {
      dynamicToolsFingerprint: transient ? JSON.stringify([{ name: "message" }]) : "[]",
    });
    const failTurn: Parameters<typeof createStartedThreadHarness>[0] = async (method) => {
      if (transient && method === "thread/start") {
        return threadStartResult("thread-transient");
      }
      if (method === "turn/start") {
        throw new Error(error);
      }
      return undefined;
    };
    const harness = transient
      ? createStartedThreadHarness(failTurn)
      : createResumeHarness("thread-existing", failTurn);
    await expect(runCodexAppServerAttempt(createParams(sessionFile, workspaceDir))).rejects.toThrow(
      error,
    );
    expect(withoutCodexSkillDiscovery(harness.requests.map((request) => request.method))).toEqual([
      "config/read",
      "configRequirements/read",
      ...(transient ? ["thread/start"] : ["thread/read", "thread/resume", "thread/inject_items"]),
      "turn/start",
      "thread/unsubscribe",
    ]);
    expect((await readCodexAppServerBinding(sessionFile))?.threadId).toBe("thread-existing");
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
            assert(harnessRef.current);
            void emit(harnessRef.current, "turn/completed", {
              threadId: "thread-existing",
              turnId: "compact-turn",
              turn: { id: "compact-turn", status: "completed", items: [] },
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
    await awaitGateBeforeSettlement(
      harness.waitForMethod("thread/resume"),
      run,
      "Codex attempt settled before thread/resume",
    );
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
    await emit(harness, "error", {
      threadId: "thread-existing",
      turnId: "compact-turn",
      error: { message: "native turn has not completed" },
      willRetry: false,
    });
    expect(harness.requests.map((request) => request.method)).not.toContain("turn/start");
    await harness.notify({
      method: "turn/completed",
      params: {
        threadId: "thread-existing",
        turn: { id: "compact-turn", status: "completed", items: [] },
      },
    });
    await finishRun(run, harness, "thread-existing");
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
      await nextImmediate();
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
    const turnStartParams = getRequestParams(requests, "turn/start");
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

    expect(getRequestParams(harness.requests, "turn/start")?.input).toEqual([
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
      // The controller reports the session active from admission; native events need the turn.
      await run.waitForTurnAccepted();
      await emitItem(harness, "started", {
        id: "msg-1",
        type: "agentMessage",
        phase: "final_answer",
        text: "",
      });
      void emit(harness, "item/agentMessage/delta", { itemId: "msg-1", delta: "hello" });
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
    const bufferedTerminal = createDeferred<void>();
    const harness: ReturnType<typeof createAppServerHarness> = createStartedThreadHarness(
      async (method) => {
        if (method === "turn/start") {
          await emitItem(harness, "started", { id: "tool-1", type: "commandExecution" });
          await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
          bufferedTerminal.resolve();
          return turnStartResult("turn-1", "inProgress");
        }
        return undefined;
      },
    );
    const run = runCodexAppServerAttempt(createRunParams());
    await bufferedTerminal.promise;
    await nextImmediate();
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
    expect(harness.requests.map((request) => request.method)).toContain("turn/start");
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
    await awaitTurnStart(harness, run);
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
    await nextImmediate();
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
    await awaitTurnStart(harness, run);
    const mcpItem = {
      type: "mcpToolCall",
      id: "raw-item",
      server: "raw-server",
      tool: "_raw.tool",
      arguments: { query: "exact" },
      status: "inProgress",
    };
    await emit(harness, "item/started", { item: mcpItem });

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

    await finishRun(run, harness);
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
      await awaitTurnStart(harness, run);
      const item = {
        type: "mcpToolCall",
        id: "active-mcp",
        server: "configured-server",
        tool: "raw-tool",
        arguments: {},
        status: "inProgress",
      };
      await emit(harness, "item/started", { item });
      await harness.handleServerRequest({
        id: "pending-mcp-approval",
        method: "mcpServer/elicitation/request",
        params: { threadId: "thread-1", turnId: "turn-1", serverName: item.server },
      });
      const correlate = approvalSpy.mock.calls[0]?.[0].getActiveMcpToolCall;
      expect(correlate?.(item.server)?.id).toBe(item.id);
      const slowProjection = emit(harness, "item/agentMessage/delta", {
        itemId: "slow",
        delta: "Waiting",
      });
      await projectionEntered.promise;
      const queuedReceipt = harness.notify(
        receipt === "terminal turn"
          ? turnCompleted({ id: "turn-1", status: "completed" })
          : turnNotification("item/started", {
              item: { ...item, id: "competing-mcp" },
            }),
      );
      try {
        expect(correlate?.(item.server)).toBeUndefined();
      } finally {
        projectionRelease.resolve();
        await Promise.all([slowProjection, queuedReceipt]);
        if (receipt !== "terminal turn") {
          try {
            await emit(harness, "item/completed", {
              item: { ...item, id: "competing-mcp", status: "completed" },
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

  it("preserves on-request approval policy for native plugin threads and turns", async () => {
    const { agentDir, params } = createRunFixture();
    const { requests, waitForMethod, completeTurn } = createStartedThreadHarness(
      createGoogleCalendarRequest((method) =>
        codexAppInventoryResponse(method, [googleCalendarAppInfo(true)]),
      ),
    );

    params.agentDir = agentDir;
    const run = runCodexAppServerAttempt(params, {
      pluginConfig: {
        ...GOOGLE_CALENDAR_PLUGIN_CONFIG,
        appServer: { approvalPolicy: "on-request" },
      },
    });
    await completeStartedRun(run, waitForMethod, completeTurn);

    const threadStart = requests.find((request) => request.method === "thread/start");
    expect(threadStart?.params).toMatchObject({
      approvalPolicy: "on-request",
      config: { apps: { "google-calendar-app": { enabled: true } } },
    });
    expect(requests.find((request) => request.method === "turn/start")?.params).toMatchObject({
      approvalPolicy: "on-request",
    });
  });

  it.each([
    {
      name: "keys plugin app inventory by the resolved Codex account",
      key: "account",
      cachedEnabled: true,
    },
    {
      name: "provisionally enables a cached disabled plugin app after thread attestation",
      key: "current",
      cachedEnabled: false,
    },
    {
      name: "keys plugin app inventory by inherited API key fallback credentials",
      key: "changed",
      cachedEnabled: true,
    },
  ])("$name", async ({ key, cachedEnabled }) => {
    const { agentDir, params } = createRunFixture();
    const pluginConfig = GOOGLE_CALENDAR_PLUGIN_CONFIG;
    const appServer = resolveCodexAppServerRuntimeOptions({
      pluginConfig: readCodexPluginConfig(pluginConfig),
    });
    vi.stubEnv("CODEX_API_KEY", "old-codex-env-key");
    vi.stubEnv("OPENAI_API_KEY", "");
    const cacheKey = buildCodexPluginAppCacheKey({
      appServer,
      agentDir,
      runtimeIdentity: getMockRuntimeIdentity(),
      ...(key === "account"
        ? { authProfileId: "openai:work", accountId: "account-work" }
        : {
            envApiKeyFingerprint: resolveCodexAppServerFallbackApiKeyCacheKey({
              startOptions: appServer.start,
            }),
          }),
    });
    await primeGoogleCalendarAppInventory(cacheKey, cachedEnabled);
    const harness = createStartedThreadHarness(
      createGoogleCalendarRequest((method) => {
        if (key === "account") {
          throw new Error("App discovery should use the account-keyed cache entry");
        }
        return codexAppInventoryResponse(method, [googleCalendarAppInfo(cachedEnabled)]);
      }),
    );
    params.agentDir = agentDir;
    if (key === "account") {
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
    } else if (key === "changed") {
      vi.stubEnv("CODEX_API_KEY", "new-codex-env-key");
    }
    await finishRun(runCodexAppServerAttempt(params, { pluginConfig }), harness);
    const { requests } = harness;
    expect(getRequestParams(requests, "thread/start")).toMatchObject({
      config: { apps: { "google-calendar-app": { enabled: true } } },
    });
    const inventory = requests.filter((entry) => entry.method === "app/installed");
    const globalAppInventoryRequests = inventory.filter(
      (entry) => typeof (entry.params as { threadId?: unknown } | undefined)?.threadId !== "string",
    );
    if (key === "changed") {
      expect(globalAppInventoryRequests).not.toHaveLength(0);
      expect(requests.map((request) => request.method)).toContain("app/read");
    } else {
      expect(globalAppInventoryRequests).toHaveLength(0);
      expect(requests.map((request) => request.method)).not.toContain("app/read");
    }
    if (!cachedEnabled) {
      expect(
        inventory.filter(
          (entry) =>
            typeof (entry.params as { threadId?: unknown } | undefined)?.threadId === "string",
        ),
      ).toEqual([
        expect.objectContaining({
          method: "app/installed",
          params: { threadId: "thread-1", forceRefresh: false },
        }),
      ]);
    }
  });

  it("does not install an active run handle when turn start resolves after abort", async () => {
    const turnStart = createDeferred<ReturnType<typeof turnStartResult>>();
    const harness = createStartedThreadHarness(async (method) =>
      method === "turn/start" ? await turnStart.promise : undefined,
    );
    const abortController = new AbortController();
    const params = createRunParams();
    params.abortSignal = abortController.signal;
    const run = runCodexAppServerAttempt(params);
    await awaitTurnStart(harness, run);
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
      createLifecycleRequest(async (method, params) => {
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
      }),
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
    const harness = createAppServerHarness(
      createLifecycleRequest(async (method) => {
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
      }),
    );

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
    const { sessionFile, workspaceDir, agentDir, params } = createRunFixture();
    await writeExistingBinding(sessionFile, workspaceDir, { dynamicToolsFingerprint: "[]" });
    const bindingUpdatedAt = await bindingTimestamp(sessionFile);
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

    params.agentDir = agentDir;
    params.prompt = "large prompt ".repeat(12_000);
    const run = runCodexAppServerAttempt(params, {
      pluginConfig: { appServer: { mode: "yolo" } },
    });
    await completeStartedRun(run, waitForMethod, completeTurn);
    expect(requests.map((request) => request.method)).toContain("thread/start");
    expect(requests.map((request) => request.method)).not.toContain("thread/resume");
    const inputText = turnInput(requests);
    expect(inputText).toContain("pre-binding native-owned context: keep the original plan");
    expect(inputText).toContain("post-binding user context: resume the release checklist");
    expect(inputText).toContain("post-binding assistant context");
    const savedBinding = await readCodexAppServerBinding(sessionFile);
    expect(savedBinding?.threadId).toBe("thread-1");
  });

  it("preserves bound auth when rotating a fallback-fuse native rollout", async () => {
    const { sessionFile, workspaceDir, agentDir, params } = createRunFixture();
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
    setRuntimeConfigSnapshot(params.config);
    params.authProfileStore.profiles["openai:work"] =
      createCodexTestOAuthProfile("synthetic-account");
    const run = runCodexAppServerAttempt(params, {
      pluginConfig: { appServer: { mode: "yolo" } },
    });
    await completeStartedRun(run, waitForMethod, completeTurn);
    expect(requests.map((request) => request.method)).toContain("thread/start");
    expect(requests.map((request) => request.method)).not.toContain("thread/resume");
    expect(new Set(seenAuthProfileIds)).toEqual(new Set(["openai:work"]));
    const savedBinding = await readCodexAppServerBinding(sessionFile);
    expect(savedBinding).toMatchObject({ authProfileId: "openai:work", threadId: "thread-1" });
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

  it.each([
    { kind: "startup timeout", spawned: true, message: "codex app-server startup timed out" },
    { kind: "write failure", spawned: true, message: "write EPIPE" },
    { kind: "logical failure", spawned: false, message: "Invalid bearer token" },
  ])("retires a failed thread-start client after $kind", async ({ kind, spawned, message }) => {
    const { retireSpy, state } = installFailingThreadStartClient(() => {
      if (kind === "startup timeout") {
        return new Promise<never>(() => {});
      }
      if (kind === "write failure") {
        throw Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
      }
      throw new CodexAppServerRpcError(
        { message: "401 authentication_error: Invalid bearer token" },
        "thread/start",
      );
    });
    const params = createRunParams();
    if (spawned) {
      params.spawnedBy = "agent:main:session-parent";
    }
    if (kind === "startup timeout") {
      params.timeoutMs = 1;
    }
    await expect(
      runCodexAppServerAttempt(
        params,
        kind === "startup timeout" ? { startupTimeoutFloorMs: 1 } : undefined,
      ),
    ).rejects.toThrow(message);
    expect(retireSpy.mock.calls.some(([client]) => client === state.failedClient)).toBe(true);
    retireSpy.mockRestore();
  });
  it("retains the prepared execution model across native resume without exposing it in lifecycle events", async () => {
    const { sessionFile, params } = createRunFixture({ provider: "openai" });
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
      expectEvent(
        onAgentEvent,
        "codex_app_server.lifecycle",
        expect.objectContaining({ phase: "turn_starting", model: "gpt-5.6-sol" }),
      );
    }
  });

  it.each([
    {
      route: "native",
      start: { approvalsReviewer: "user" },
      turn: { approvalsReviewer: "auto_review" },
    },
    {
      route: "custom endpoint",
      start: { modelProvider: "openai", approvalPolicy: "on-request", approvalsReviewer: "user" },
      turn: { approvalsReviewer: "user" },
    },
    {
      route: "local model",
      start: {
        model: "local-model",
        modelProvider: "lmstudio",
        approvalPolicy: "on-request",
        approvalsReviewer: "user",
        config: { "features.code_mode": true, "features.code_mode_only": true },
      },
      turn: {
        model: "local-model",
        collaborationMode: { settings: { model: "local-model" } },
        approvalsReviewer: "user",
      },
    },
  ] as const)("selects native approval ownership for $route", async ({ route, start, turn }) => {
    const params = createRunParams();
    if (route !== "native") {
      params.provider = route === "local model" ? "codex" : "openai";
      params.modelId = route === "local model" ? "lmstudio/local-model" : "gpt-5.5";
      params.config = {
        tools: { exec: { mode: "auto" } },
        ...(route === "custom endpoint"
          ? {
              models: {
                providers: { openai: { baseUrl: "http://localhost:8080/v1", models: [] } },
              },
            }
          : {}),
      };
    }
    const harness = createStartedThreadHarness(async (method) => {
      if (route === "local model" && method === "thread/start") {
        const response = threadStartResult();
        return {
          ...response,
          thread: { ...response.thread, modelProvider: "lmstudio" },
          model: "local-model",
          modelProvider: "lmstudio",
        };
      }
      return undefined;
    });
    const pluginConfig =
      route === "native"
        ? { appServer: { mode: "guardian" as const } }
        : route === "local model"
          ? { appServer: { codeModeOnly: true } }
          : {};
    await finishRun(runCodexAppServerAttempt(params, { pluginConfig }), harness);
    expect(getRequestParams(harness.requests, "thread/start")).toMatchObject(start);
    expect(getRequestParams(harness.requests, "turn/start")).toMatchObject(turn);
  });

  it("rejects a newly observed native model before inference with stale prepared host auth", async () => {
    const { sessionFile, workspaceDir, agentDir, params } = createRunFixture({
      provider: "openai",
    });
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
    const { sessionFile, workspaceDir, params } = createRunFixture();
    await writeExistingBinding(sessionFile, workspaceDir, {
      connectionScope: "supervision",
      supervisionSourceThreadId: "thread-source",
      model: "gpt-5.5",
      modelProvider: "openai",
      preserveNativeModel: true,
      conversationSourceTransferComplete: true,
    });

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

  it("rejects a resumed provider mismatch before inference and preserves the binding", async () => {
    const { sessionFile, workspaceDir, params } = createRunFixture();
    await writeExistingBinding(sessionFile, workspaceDir, {
      model: "gpt-5.4",
      modelProvider: "openai",
    });
    const harness = createStartedThreadHarness(
      async (method) => {
        if (method === "thread/resume") {
          return {
            ...threadStartResult("thread-existing", { cwd: workspaceDir }),
            model: "gpt-5.4",
            modelProvider: "local-provider",
          };
        }
        if (method === "turn/start") {
          return { turn: { id: "turn-1", status: "completed", items: [] } };
        }
        return undefined;
      },
      { persistedThreads: ["thread-existing"] },
    );

    params.provider = "openai";
    params.modelId = "gpt-5.5";
    await expect(runCodexAppServerAttempt(params)).rejects.toThrow(
      "Codex resumed a different model provider",
    );
    expect(harness.requests.some(({ method }) => method === "thread/resume")).toBe(true);
    expect(harness.requests.some(({ method }) => method === "turn/start")).toBe(false);
    expect(await readCodexAppServerBinding(sessionFile)).toMatchObject({
      threadId: "thread-existing",
      model: "gpt-5.4",
      modelProvider: "openai",
    });
  });

  it.each([
    { provider: "openai", modelId: "gpt-5.5", reviewer: "auto_review" },
    { provider: "codex", modelId: "openai/gpt-5.5", reviewer: "guardian_subagent" },
  ] as const)(
    "does not inherit a bound local provider for $provider/$modelId",
    async ({ provider, modelId, reviewer }) => {
      const { sessionFile, workspaceDir, params } = createRunFixture();
      await writeExistingBinding(sessionFile, workspaceDir, {
        ...(provider === "openai" ? { authProfileId: "openai-profile" } : {}),
        model: "local-model",
        modelProvider: "lmstudio",
      });
      const harness = createResumeHarness();
      params.provider = provider;
      params.modelId = modelId;
      if (provider === "openai") {
        params.authProfileId = "openai-profile";
        params.authProfileStore = {
          version: 1,
          profiles: {
            "openai-profile": {
              ...createCodexTestOAuthProfile("account-work"),
              email: "work@example.test",
            },
          },
        };
      }
      const run = runCodexAppServerAttempt(params, {
        pluginConfig: {
          appServer: {
            mode: "guardian",
            ...(provider === "codex" ? { approvalsReviewer: reviewer } : {}),
          },
        },
      });
      await finishRun(run, harness, "thread-existing");
      const resume = getRequestParams(harness.requests, "thread/resume");
      expect(resume).toMatchObject({ model: "gpt-5.5", approvalsReviewer: reviewer });
      if (provider === "codex") {
        expect(resume?.modelProvider).toBe("openai");
      } else {
        expect(resume).not.toHaveProperty("modelProvider");
        expect(getRequestParams(harness.requests, "turn/start")).toMatchObject({
          model: "gpt-5.5",
          collaborationMode: { settings: { model: "gpt-5.5" } },
        });
        expect(await readCodexAppServerBinding(sessionFile)).toMatchObject({ model: "gpt-5.5" });
      }
    },
  );

  registerCodexFastModeTests({ createRunPaths, writeExistingBinding, completeStartedRun });

  it("announces Codex app-server fast auto progress after the crossing tool result", async () => {
    const { harness, now, onAgentEvent, onToolResult, run, workspaceDir } =
      await startFastAutoProgressTest();
    const notifyCommand = async (id: string, output: string, nowMs: number) => {
      await emitItem(harness, "started", {
        type: "commandExecution",
        id,
        command: `echo ${id}`,
        cwd: workspaceDir,
        status: "inProgress",
      });
      now.mockReturnValue(nowMs);
      await emitItem(harness, "completed", {
        type: "commandExecution",
        id,
        command: `echo ${id}`,
        cwd: workspaceDir,
        status: "completed",
        aggregatedOutput: output,
        exitCode: 0,
        durationMs: 1,
      });
    };
    await notifyCommand("tool-before", "before", 20_000);
    await notifyCommand("tool-crossing", "crossing", 35_500);
    await notifyCommand("tool-after", "after", 42_000);
    await finishRun(run, harness);
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
    await nextImmediate();
    now.mockReturnValue(35_500);
    await harness.notify(
      rawItemCompleted({
        type: "function_call_output",
        id: "call-raw-output",
        call_id: "call-raw-output",
        output: "tool output",
      }),
    );
    await finishRun(run, harness);
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
  it("defers failed-after-sleep lifecycle terminal ownership", async () => {
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
    await awaitTurnStart(harness, run);

    const earlier = {
      id: "earlier-final",
      type: "agentMessage",
      phase: "final_answer",
      text: "Earlier final",
    };
    await emitItem(harness, "started", { ...earlier, text: "" });
    await emit(harness, "item/agentMessage/delta", {
      itemId: earlier.id,
      delta: earlier.text,
    });
    await emitItem(harness, "completed", earlier);
    const sleep = { id: "sleep-1", type: "sleep", durationMs: 250 };
    await emitItem(harness, "started", sleep);
    await emitItem(harness, "completed", sleep);
    await emitItem(harness, "started", {
      id: "msg-1",
      type: "agentMessage",
      phase: "final_answer",
      text: "",
    });
    await emit(harness, "item/agentMessage/delta", {
      itemId: "msg-1",
      delta: "hello back",
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

    const lifecycleEvents = eventsFor(onRunAgentEvent, "lifecycle");
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
    const selectedText = "hello back";
    expect(result.assistantTexts.join("\n\n")).toBe(selectedText);
    const assistantEvents = eventsFor(onRunAgentEvent, "assistant");
    expect(assistantEvents.at(-1)?.data).toEqual({
      text: selectedText,
      itemId: result.assistantTranscriptIdempotencyKey,
      replace: true,
      replaceable: true,
    });
  });
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
  it("continues after bounded plan restoration fails", async () => {
    const { harness, run } = await startAttempt(async (method) => {
      if (method === "thread/inject_items") {
        throw new Error("injected test failure");
      }
      return undefined;
    });
    await emit(harness, "turn/plan/updated", {
      explanation: "e".repeat(10_000),
      plan: Array.from({ length: 100 }, (_, index) => ({
        step: `${index}: ${"x".repeat(2_000)}`,
        status: index === 0 ? "inProgress" : "pending",
      })),
    });
    await emitItem(harness, "started", { type: "contextCompaction", id: "compact-1" });
    await emitItem(harness, "completed", { type: "contextCompaction", id: "compact-1" });

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

    const result = await finishRun(run, harness);
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

    await nextImmediate();
    expect(resolved).toBe(false);
    expect(nativeHookRelayTesting.getNativeHookRelayRegistrationForTests(relayId)).toBeDefined();

    await harness.notify(turnCompleted({ id: "turn-1", status: "interrupted", items: [] }));

    const result = await run;
    expect(resolved).toBe(true);
    expect(readAttemptTerminal(result)).toMatchObject({ aborted: true, timedOut: false });
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

registerCodexUsageLimitTests();
