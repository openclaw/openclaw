import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  buildAgentHookContextChannelFields,
  embeddedAgentLog,
  formatErrorMessage,
  resolveSandboxContext,
  runAgentCleanupStep,
  type AgentHarnessSideQuestionParamsV2,
  type AgentHarnessSideQuestionResult,
  type EmbeddedRunAttemptParamsV2,
  type NativeHookRelayEvent,
  type registerNativeHookRelay,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { resolveAgentWorkspaceDir } from "openclaw/plugin-sdk/agent-runtime";
import { resolveSessionAgentIdsStrict } from "openclaw/plugin-sdk/agent-scope-runtime";
import {
  loadCodexBundleMcpApprovalConfig,
  resolveCodexMcpToolOverridesForAgent,
} from "openclaw/plugin-sdk/codex-mcp-projection";
import { loadExecApprovals } from "openclaw/plugin-sdk/exec-approvals-runtime";
import { registerNativeHookRelayForBundledRuntime } from "openclaw/plugin-sdk/native-hook-relay-runtime";
import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import { readStringField as readString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { resolveCodexAppServerForModelProvider } from "./app-server-policy.js";
import { handleCodexAppServerApprovalRequest } from "./approval-bridge.js";
import { retireUnsafeCodexTurnClientBestEffort } from "./attempt-client-cleanup.js";
import { resolveCodexAppServerPreparedAuthHandoff } from "./auth-bridge.js";
import {
  requireCodexSupervisionModelSelection,
  resolveCodexBindingAppServerConnection,
} from "./binding-connection.js";
import {
  isCodexAppServerApprovalRequest,
  isCodexAppServerIndeterminateRequestCancellationError,
  type CodexAppServerClient,
} from "./client.js";
import {
  canUseCodexModelBackedApprovalsReviewerForModel,
  hasCodexMcpToolApprovalOverrides,
  isCodexPairedNodeRemoteExecPlacementSandbox,
  isCodexRemoteExecPlacementSandbox,
  isCodexSandboxExecServerEnabled,
  readCodexPluginConfig,
  readCodexRequirementsToml,
  resolveCodexAppServerHomeScope,
  resolveOpenClawExecPolicyForCodexAppServer,
  resolveCodexModelBackedReviewerPolicyContext,
  shouldAutoApproveCodexAppServerApprovals,
  withMcpElicitationsApprovalPolicy,
  type CodexAppServerRuntimeOptions,
} from "./config.js";
import {
  buildDynamicTools,
  resolveCodexExternalSandboxPolicyForOpenClawSandbox,
  resolveCodexMessageToolProvider,
  resolveCodexSandboxEnvironmentSelection,
  shouldEnableCodexAppServerNativeToolSurface,
  shouldRequireCodexSandboxExecServerEnvironment,
} from "./dynamic-tool-build.js";
import {
  emitDynamicToolErrorDiagnostic,
  emitDynamicToolStartedDiagnostic,
  emitDynamicToolTerminalDiagnostic,
} from "./dynamic-tool-diagnostics.js";
import {
  handleDynamicToolCallWithTimeout,
  resolveCodexToolAbortTerminalReason,
  resolveDynamicToolCallTimeoutMs,
} from "./dynamic-tool-execution.js";
import { resolveCodexDynamicToolsLoading } from "./dynamic-tool-profile.js";
import { createCodexDynamicToolBridge, type CodexDynamicToolBridge } from "./dynamic-tools.js";
import { routeCodexAppServerElicitationRequest } from "./elicitation-bridge.js";
import { createCodexElicitationResponse } from "./elicitation-response.js";
import { CodexEphemeralTurn } from "./ephemeral-turn.js";
import { CodexNativeToolLifecycleProjector } from "./event-projector-native-tool-lifecycle.js";
import {
  buildCodexNativeHookRelayConfig,
  buildCodexNativeHookRelayDisabledConfig,
  CODEX_NATIVE_HOOK_RELAY_EVENTS,
  emitCodexNativePreToolUseFailureDiagnostic,
  type CodexNativePreToolUseFailure,
} from "./native-hook-relay.js";
import {
  mergeCodexThreadConfigs,
  refreshCodexPluginAppApprovalPolicy,
} from "./plugin-thread-config.js";
import {
  assertCodexThreadForkResponse,
  assertCodexTurnStartResponse,
  readCodexDynamicToolCallParams,
} from "./protocol-validators.js";
import {
  isJsonObject,
  type CodexThreadForkParams,
  type JsonObject,
  type JsonValue,
} from "./protocol.js";
import { resolveCodexProviderWebSearchSupportForClient } from "./provider-capabilities.js";
import { readRecentCodexRateLimits } from "./rate-limit-cache.js";
import { formatCodexUsageLimitErrorMessage } from "./rate-limits.js";
import {
  readCodexSupportedReasoningEfforts,
  resolveCodexAppServerReasoningEffort,
} from "./reasoning-effort.js";
import {
  ensureCodexSandboxExecServerEnvironment,
  releaseCodexSandboxExecServerEnvironment,
  type CodexSandboxExecEnvironment,
} from "./sandbox-exec-server.js";
import { resolveCodexNativeExecutionBlock } from "./sandbox-guard.js";
import {
  sessionBindingIdentity,
  resolveCodexSessionBinding,
  type CodexAppServerBindingStore,
} from "./session-binding.js";
import {
  applyCodexSessionPermissionPolicy,
  CODEX_SESSION_PERMISSION_EXEC_MODES,
  resolveCodexEffectiveSessionPermissionPolicy,
  resolveCodexSessionPermissionCwd,
  type CodexEffectiveSessionPermissionPolicy,
} from "./session-permission-policy.js";
import {
  getLeasedSharedCodexAppServerClient,
  releaseCodexAppServerClientLease,
  withLeasedCodexAppServerClientStartSelectionRetry,
  type CodexAppServerClientLease,
  type CodexAppServerClientOptions,
} from "./shared-client.js";
import { cleanupCodexSideQuestion } from "./side-question-cleanup.js";
import { SIDE_DEVELOPER_INSTRUCTIONS } from "./side-question-instructions.js";
import {
  buildCodexRuntimeThreadConfig,
  CODEX_NATIVE_PERSONALITY_NONE,
  resolveCodexAppServerRequestModelSelection,
  resolveCodexAppServerModelProvider,
  resolveCodexBindingModelProviderFallback,
} from "./thread-lifecycle.js";
import {
  assertCodexSupervisionThreadLineage,
  CodexThreadPolicyHandoffError,
  refreshCodexThreadPolicy,
} from "./thread-policy.js";
import { buildCodexTemporalAdditionalContext } from "./turn-params.js";
import type { CodexAppServerServerRequest, CodexThreadRouteScope } from "./turn-router.js";
import { buildCodexUserInput } from "./user-input.js";
import {
  resolveCodexWebSearchPlan,
  type CodexNativeWebSearchSupport,
  type CodexWebSearchPlan,
} from "./web-search.js";

const SIDE_QUESTION_COMPLETION_TIMEOUT_MS = 600_000;

class CodexSideQuestionTimeoutError extends Error {
  override name = "TimeoutError";
}
const CODEX_SIDE_NATIVE_HOOK_RELAY_MIN_TTL_MS = 30 * 60_000;
const CODEX_SIDE_NATIVE_HOOK_RELAY_TTL_GRACE_MS = 5 * 60_000;
const CODEX_SIDE_NATIVE_HOOK_RELAY_STARTUP_REQUEST_COUNT = 3;
const CODEX_SIDE_NATIVE_HOOK_RELAY_EVENTS_WITH_APP_SERVER_APPROVALS =
  CODEX_NATIVE_HOOK_RELAY_EVENTS.filter((event) => event !== "permission_request");
export async function runCodexAppServerSideQuestion(
  params: AgentHarnessSideQuestionParamsV2,
  options: {
    bindingStore: CodexAppServerBindingStore;
    runtime?: PluginRuntime;
    pluginConfig?: unknown;
    /** Private app-server request identity; public side-run identity remains params.model. */
    runtimeModelId?: string;
    nativeHookRelay?: {
      enabled?: boolean;
      events?: readonly NativeHookRelayEvent[];
      ttlMs?: number;
      gatewayTimeoutMs?: number;
      hookTimeoutSec?: number;
    };
  },
): Promise<AgentHarnessSideQuestionResult> {
  const bindingIdentity = sessionBindingIdentity({
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    agentId: params.agentId,
    config: params.cfg,
  });
  const hostCapabilities = params.hostCapabilities;
  const { binding, assertCurrent } = await resolveCodexSessionBinding({
    bindingStore: options.bindingStore,
    identity: bindingIdentity,
    config: params.cfg,
    storePath: params.storePath,
    assertCurrent: hostCapabilities.assertActive,
    signal: params.opts?.abortSignal,
  });
  if (!binding?.threadId) {
    throw new Error(
      "Codex /btw needs an active Codex thread. Send a normal message first, then try /btw again.",
    );
  }
  if (isCodexPairedNodeRemoteExecPlacementSandbox(params.sandbox)) {
    throw new Error(
      "Normal Codex turns are supported on nodes, but /btw is not yet bound to the active placement.",
    );
  }
  const pluginConfig = readCodexPluginConfig(options.pluginConfig);
  const { sessionAgentId } = resolveSessionAgentIdsStrict({
    sessionKey: params.sessionKey,
    config: params.cfg,
    agentId: params.agentId,
  });
  const agentWorkspaceDir =
    params.workspaceDir?.trim() || resolveAgentWorkspaceDir(params.cfg, sessionAgentId);
  const execPolicy = resolveOpenClawExecPolicyForCodexAppServer({
    permissionMode: params.sessionEntry.permissionMode,
    execOverrides: params.sessionEntry.permissionMode
      ? { mode: CODEX_SESSION_PERMISSION_EXEC_MODES[params.sessionEntry.permissionMode] }
      : undefined,
    approvals: params.sessionEntry.permissionMode === "full" ? undefined : loadExecApprovals(),
    config: params.cfg,
    agentId: sessionAgentId,
  });
  const usesSupervisionConnection = binding.connectionScope === "supervision";
  const supervisionModelSelection = usesSupervisionConnection
    ? requireCodexSupervisionModelSelection(binding)
    : undefined;
  const preparedRuntimeAuth = params.preparedRuntimeAuth;
  const authHandoff = usesSupervisionConnection
    ? { authProfileId: undefined, nativeAuthProfile: true, preparedAuth: undefined }
    : await resolveCodexAppServerPreparedAuthHandoff({
        authRequirement: preparedRuntimeAuth.plan.modelRoute?.authRequirement,
        resolvedApiKey: preparedRuntimeAuth.resolvedApiKey,
        authProfileId: preparedRuntimeAuth.plan.forwardedAuthProfileId,
        authProfileStore: preparedRuntimeAuth.authProfileStore,
        agentDir: params.agentDir,
        homeScope: resolveCodexAppServerHomeScope({ appServer: pluginConfig.appServer }),
        requirePreparedAuth: isCodexRemoteExecPlacementSandbox(params.sandbox),
        config: params.cfg,
        subscriptionProfileRequiredError:
          "Prepared Codex subscription route requires a scoped native OAuth or token profile.",
        subscriptionProfileUnusableError: `Prepared Codex auth profile "${preparedRuntimeAuth.plan.forwardedAuthProfileId}" is unusable.`,
      });
  const {
    authProfileId,
    nativeAuthProfile: preparedNativeAuthProfile,
    preparedAuth: startupPreparedAuth,
  } = authHandoff;
  const modelProvider = supervisionModelSelection
    ? supervisionModelSelection.modelProvider
    : (resolveCodexAppServerModelProvider({
        provider: params.provider,
        authProfileId,
        authProfileStore: preparedRuntimeAuth.authProfileStore,
        agentDir: params.agentDir,
        config: params.cfg,
      }) ??
      resolveCodexBindingModelProviderFallback({
        provider: params.provider,
        currentModel: params.model,
        bindingModel: binding.model,
        bindingModelProvider: binding.modelProvider,
      }));
  const modelSelection = resolveCodexAppServerRequestModelSelection({
    model: supervisionModelSelection?.model ?? options.runtimeModelId ?? params.model,
    modelProvider,
    authProfileId,
    authProfileStore: preparedRuntimeAuth.authProfileStore,
    agentDir: params.agentDir,
    config: params.cfg,
  });
  const reviewerPolicyContext = resolveCodexModelBackedReviewerPolicyContext({
    provider: usesSupervisionConnection ? "codex" : params.provider,
    model: supervisionModelSelection?.model ?? params.model,
    bindingModelProvider: binding.modelProvider,
    bindingModel: binding.model,
    nativeAuthProfile: usesSupervisionConnection || preparedNativeAuthProfile,
  });
  const connection = await resolveCodexBindingAppServerConnection({
    binding,
    authProfileId,
    pluginConfig,
    execPolicy,
    assertCurrent,
    modelProvider: reviewerPolicyContext.modelProvider,
    model: reviewerPolicyContext.model,
    config: params.cfg,
    agentDir: params.agentDir,
  });
  const reviewerContext = {
    modelProvider: reviewerPolicyContext.modelProvider,
    model: reviewerPolicyContext.model,
    config: params.cfg,
    env: process.env,
    agentDir: params.agentDir,
  };
  const appServer = resolveCodexAppServerForModelProvider({
    appServer: applyCodexSessionPermissionPolicy({
      appServer: connection.appServer,
      permissionMode: params.sessionEntry.permissionMode,
      sessionRoot: params.sessionEntry.sessionRoot,
      defaultRoot: agentWorkspaceDir,
      pluginConfig,
      canUseAutoReview: canUseCodexModelBackedApprovalsReviewerForModel(reviewerContext),
      requirementsToml: readCodexRequirementsToml({}),
      policyLocked: usesSupervisionConnection,
      execMode: execPolicy.mode,
    }),
    ...reviewerContext,
    provider: reviewerContext.modelProvider,
  });
  const sessionPermissionPolicy = resolveCodexEffectiveSessionPermissionPolicy({
    appServer,
    permissionMode: params.sessionEntry.permissionMode,
    sessionRoot: params.sessionEntry.sessionRoot,
    defaultRoot: agentWorkspaceDir,
  });
  const cwd = resolveCodexSessionPermissionCwd({
    permissionMode: params.sessionEntry.permissionMode,
    sessionRoot: params.sessionEntry.sessionRoot,
    defaultRoot: agentWorkspaceDir,
    requestedCwd: binding.cwd,
    fallbackCwd: agentWorkspaceDir,
  });
  const runId = params.opts?.runId ?? randomUUID();
  // Side runs inherit private-binding capabilities, not outer model metadata.
  const effectiveParams: AgentHarnessSideQuestionParamsV2 = supervisionModelSelection
    ? {
        ...params,
        provider: supervisionModelSelection.modelProvider,
        model: supervisionModelSelection.model,
        runtimeModel: {
          id: supervisionModelSelection.model,
          name: supervisionModelSelection.model,
          provider: supervisionModelSelection.modelProvider,
          api: "openai-chatgpt-responses",
          reasoning: true,
          input: ["text", "image"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        } as NonNullable<AgentHarnessSideQuestionParamsV2["runtimeModel"]>,
      }
    : params;
  const sideRunParams = buildSideRunAttemptParams(effectiveParams, {
    cwd,
    authProfileId,
    runId,
    timeoutMs: appServer.requestTimeoutMs,
  });
  sideRunParams.permissionMode = sessionPermissionPolicy?.mode;
  sideRunParams.sessionRoot = sessionPermissionPolicy?.root;
  sideRunParams.execOverrides = sessionPermissionPolicy && {
    mode: sessionPermissionPolicy.execMode,
  };
  const sandboxExecServerEnabled = isCodexSandboxExecServerEnabled(pluginConfig, params.sandbox);
  const nativeToolSurfaceEnabled = shouldEnableCodexAppServerNativeToolSurface(
    sideRunParams,
    params.sandbox ?? undefined,
    { agentId: sideRunParams.agentId, sandboxExecServerEnabled },
  );
  const sandboxEnvironmentRequired = shouldRequireCodexSandboxExecServerEnvironment({
    sandbox: params.sandbox ?? undefined,
    nativeToolSurfaceEnabled,
    sandboxExecServerEnabled,
  });
  const nativeExecutionBlock = resolveCodexNativeExecutionBlock({
    config: sideRunParams.config,
    sessionKey: sideRunParams.sandboxSessionKey?.trim() || sideRunParams.sessionKey,
    sessionId: sideRunParams.sessionId,
    agentId: sideRunParams.agentId,
    sandbox: params.sandbox,
    sandboxEnvironmentSelected: sandboxEnvironmentRequired,
    surface: "/btw side-question mode",
  });
  if (nativeExecutionBlock) {
    throw new Error(nativeExecutionBlock);
  }
  if (!nativeToolSurfaceEnabled) {
    throw new Error(
      "Codex-native /btw side-question mode is unavailable because the effective tool policy restricts Codex native tools for this session.",
    );
  }
  const clientOptions = {
    assertCurrent,
    startOptions: appServer.start,
    timeoutMs: appServer.requestTimeoutMs,
    authRequirement: preparedRuntimeAuth.plan.modelRoute?.authRequirement,
    ...(startupPreparedAuth
      ? { preparedAuth: startupPreparedAuth }
      : { authProfileId: connection.clientAuthProfileId }),
    agentDir: params.agentDir,
    config: params.cfg,
    ...(params.opts?.abortSignal ? { abandonSignal: params.opts.abortSignal } : {}),
  } satisfies CodexAppServerClientOptions;
  let client = await getLeasedSharedCodexAppServerClient(clientOptions);
  const clientLease: CodexAppServerClientLease = { client };
  let collector: CodexEphemeralTurn | undefined;
  const runAbortController = new AbortController();
  let nativeToolLifecycleProjector: CodexNativeToolLifecycleProjector | undefined;
  const pendingNativePreToolUseFailures: CodexNativePreToolUseFailure[] = [];
  let nativePreToolUseFailureFallbackActive = false;
  let nativeToolRunWasAbortedBeforeCleanup: boolean | undefined;
  let nativePreToolUseFailureFallbackTerminalReason:
    | CodexNativePreToolUseFailure["disposition"]
    | undefined;
  const emitNativePreToolUseFailure = (failure: CodexNativePreToolUseFailure) => {
    emitCodexNativePreToolUseFailureDiagnostic({
      agentId: sessionAgentId,
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
      runId: sideRunParams.runId,
      signal: runAbortController.signal,
      failure,
      ...(nativePreToolUseFailureFallbackActive
        ? {
            terminalReason: nativePreToolUseFailureFallbackTerminalReason ?? failure.disposition,
          }
        : {}),
    });
  };
  const flushPendingNativePreToolUseFailures = () => {
    for (const failure of pendingNativePreToolUseFailures.splice(0)) {
      emitNativePreToolUseFailure(failure);
    }
  };
  const activateNativePreToolUseFailureFallback = () => {
    if (!nativePreToolUseFailureFallbackActive) {
      nativePreToolUseFailureFallbackTerminalReason = nativeToolRunWasAbortedBeforeCleanup
        ? resolveCodexToolAbortTerminalReason(runAbortController.signal)
        : undefined;
      nativePreToolUseFailureFallbackActive = true;
    }
    flushPendingNativePreToolUseFailures();
  };
  const abortFromUpstream = () =>
    runAbortController.abort(params.opts?.abortSignal?.reason ?? "codex_side_question_abort");
  if (params.opts?.abortSignal?.aborted) {
    abortFromUpstream();
  } else {
    params.opts?.abortSignal?.addEventListener("abort", abortFromUpstream, { once: true });
  }
  let childThreadId: string | undefined;
  let pluginAppPolicyContext = binding.pluginAppPolicyContext;
  let childClient: CodexAppServerClient | undefined;
  let policyWriteUncertain = false;
  let turnId: string | undefined;
  let sandboxEnvironment: CodexSandboxExecEnvironment | undefined;
  let sandboxDisconnectError: Error | undefined;
  let sandboxEnvironmentClient: CodexAppServerClient | undefined;
  let nativeHookRelay: ReturnType<typeof registerNativeHookRelayForBundledRuntime> | undefined;
  const activeDynamicToolCalls = new Set<Promise<unknown>>();
  let primaryFailure: { error: unknown } | undefined;
  const releaseSandboxEnvironment = async () => {
    if (!sandboxEnvironment) {
      return;
    }
    const environment = sandboxEnvironment;
    sandboxEnvironment = undefined;
    sandboxEnvironmentClient = undefined;
    await releaseCodexSandboxExecServerEnvironment(params.sandbox, environment);
  };
  const ensureSandboxEnvironment = async (targetClient: CodexAppServerClient) => {
    if (!sandboxEnvironmentRequired || sandboxEnvironmentClient === targetClient) {
      return;
    }
    await releaseSandboxEnvironment();
    assertCurrent();
    const environment = await ensureCodexSandboxExecServerEnvironment({
      client: targetClient,
      sandbox: params.sandbox ?? null,
      runtime: options.runtime,
      appServerStartOptions: appServer.start,
      timeoutMs: appServer.requestTimeoutMs,
      signal: runAbortController.signal,
      onExecutionDisconnect: (error) => {
        sandboxDisconnectError = error;
        embeddedAgentLog.warn(error.message);
        runAbortController.abort("client_closed");
      },
    });
    if (!environment) {
      throw new Error(
        "Codex app-server did not register an OpenClaw sandbox exec-server environment.",
      );
    }
    sandboxEnvironment = environment;
    sandboxEnvironmentClient = targetClient;
  };

  try {
    assertCurrent();
    const autoApproveMcpTools = shouldAutoApproveCodexAppServerApprovals(appServer);
    const projectedMcpServers = loadCodexBundleMcpApprovalConfig({
      workspaceDir: agentWorkspaceDir,
      cfg: params.cfg,
      toolOverrides: resolveCodexMcpToolOverridesForAgent(params.cfg, {
        agentId: sessionAgentId,
        toolOverrides: params.sessionEntry.toolOverrides,
      }),
    });
    // Native app prompts must reach their reviewer even when the side thread's
    // general policy is Never, matching normal plugin-backed turns.
    const approvalPolicy =
      Object.keys(binding.pluginAppPolicyContext?.apps ?? {}).length > 0 ||
      hasCodexMcpToolApprovalOverrides(
        params.cfg?.mcp?.servers,
        Object.keys(projectedMcpServers),
        projectedMcpServers,
      )
        ? withMcpElicitationsApprovalPolicy(appServer.approvalPolicy)
        : appServer.approvalPolicy;
    const sandbox = appServer.sandbox;
    const nativeProviderWebSearchSupport =
      resolveCodexWebSearchPlan({
        config: params.cfg,
        nativeToolSurfaceEnabled,
      }).kind === "native-hosted"
        ? await resolveCodexProviderWebSearchSupportForClient({
            client,
            timeoutMs: appServer.requestTimeoutMs,
            modelProviderOverride: modelSelection.modelProvider,
            signal: runAbortController.signal,
          })
        : "unsupported";
    const { toolBridge, webSearchPlan } = await createCodexSideToolBridge({
      params: sideRunParams,
      cwd,
      resolvedWorkspace: effectiveParams.workspaceDir ?? cwd,
      pluginConfig,
      sessionAgentId,
      nativeToolSurfaceEnabled,
      nativeProviderWebSearchSupport,
      sessionPermissionPolicy,
      runAbortController,
    });
    const handleServerRequest = async (
      request: CodexAppServerServerRequest,
      _scope: CodexThreadRouteScope,
      requestSignal: AbortSignal,
      setExecutionTimeoutMs?: (timeoutMs: number) => void,
    ) => {
      const signal = AbortSignal.any([requestSignal, runAbortController.signal]);
      if (signal.aborted || !childThreadId || !turnId) {
        return undefined;
      }
      if (request.method === "mcpServer/elicitation/request") {
        const approvalResult = await routeCodexAppServerElicitationRequest({
          requestParams: request.params,
          paramsForRun: sideRunParams,
          threadId: childThreadId,
          turnId,
          autoApproveMcpTools,
          projectedMcpServers,
          getActiveMcpToolCall: (serverName) =>
            nativeToolLifecycleProjector?.getActiveMcpToolCall(serverName),
          pluginAppPolicyContext,
          signal,
        });
        return approvalResult.kind === "handled"
          ? approvalResult.response
          : createCodexElicitationResponse("decline", null, {
              message: "OpenClaw Codex side questions do not support interactive MCP input.",
            });
      }
      if (request.method === "item/tool/requestUserInput") {
        return isSideUserInputRequest(request.params, childThreadId, turnId)
          ? emptySideUserInputResponse()
          : undefined;
      }
      if (isCodexAppServerApprovalRequest(request.method)) {
        return handleCodexAppServerApprovalRequest({
          method: request.method,
          requestParams: request.params,
          paramsForRun: sideRunParams,
          threadId: childThreadId,
          turnId,
          nativeHookRelay,
          autoApprove: autoApproveMcpTools,
          signal,
          onNativeToolFailureDisposition: (itemId, disposition) =>
            nativeToolLifecycleProjector?.recordApprovalFailureDisposition(itemId, disposition),
        });
      }
      if (request.method !== "item/tool/call") {
        return undefined;
      }
      const call = readCodexDynamicToolCallParams(request.params);
      if (!call || call.threadId !== childThreadId || call.turnId !== turnId) {
        return undefined;
      }
      const timeoutMs = resolveDynamicToolCallTimeoutMs({
        call,
        config: params.cfg,
        toolBridge,
      });
      setExecutionTimeoutMs?.(timeoutMs);
      const toolStartedAt = Date.now();
      const diagnosticContext = {
        call,
        agentId: sessionAgentId,
        runId: sideRunParams.runId,
        sessionId: params.sessionId,
        sessionKey: params.sessionKey,
      };
      emitDynamicToolStartedDiagnostic(diagnosticContext);
      const toolCall = handleDynamicToolCallWithTimeout({
        call,
        toolBridge,
        signal,
        timeoutMs,
        observeToolTerminal: sideRunParams.observeToolTerminal,
      });
      activeDynamicToolCalls.add(toolCall);
      try {
        const response = await toolCall;
        emitDynamicToolTerminalDiagnostic({
          ...diagnosticContext,
          response,
          durationMs: Math.max(0, Date.now() - toolStartedAt),
        });
        return {
          contentItems: response.contentItems,
          success: response.success,
        } as JsonValue;
      } catch (error) {
        emitDynamicToolErrorDiagnostic({
          ...diagnosticContext,
          durationMs: Math.max(0, Date.now() - toolStartedAt),
          terminalReason: signal.aborted ? resolveCodexToolAbortTerminalReason(signal) : "failed",
        });
        throw error;
      } finally {
        activeDynamicToolCalls.delete(toolCall);
      }
    };

    const serviceTier = binding.serviceTier ?? appServer.serviceTier;
    const nativeHookRelayEvents = resolveCodexSideNativeHookRelayEvents({
      configuredEvents: options.nativeHookRelay?.events,
      approvalPolicy: appServer.approvalPolicy,
    });
    nativeHookRelay = options.nativeHookRelay
      ? registerCodexSideNativeHookRelay({
          options: options.nativeHookRelay,
          events: nativeHookRelayEvents,
          agentId: sessionAgentId,
          sessionId: params.sessionId,
          sessionKey: params.sessionKey,
          config: params.cfg,
          autoApproveMcpTools,
          projectedMcpServers,
          runId: sideRunParams.runId,
          channelId: buildAgentHookContextChannelFields({
            sessionKey: params.sessionKey,
            messageChannel: params.messageChannel,
            messageProvider: params.messageProvider,
            currentChannelId: params.currentChannelId,
          }).channelId,
          requestTimeoutMs: appServer.requestTimeoutMs,
          completionTimeoutMs: SIDE_QUESTION_COMPLETION_TIMEOUT_MS,
          loopDetectionPreToolUseRelay: appServer.loopDetectionPreToolUseRelay,
          signal: runAbortController.signal,
          hostCapabilities: sideRunParams.hostCapabilities,
          assertCurrent,
          onPreToolUseFailure: (failure) => {
            if (nativePreToolUseFailureFallbackActive) {
              emitNativePreToolUseFailure(failure);
            } else if (nativeToolLifecycleProjector) {
              nativeToolLifecycleProjector.recordPreToolUseFailure(
                failure,
                nativeToolRunWasAbortedBeforeCleanup,
              );
            } else {
              pendingNativePreToolUseFailures.push(failure);
            }
          },
        })
      : undefined;
    await nativeHookRelay?.prepareInvocation();
    assertCurrent();
    const nativeHookRelayConfig = nativeHookRelay
      ? buildCodexNativeHookRelayConfig({
          relay: nativeHookRelay,
          events: nativeHookRelayEvents,
          hookTimeoutSec: options.nativeHookRelay?.hookTimeoutSec,
          clearOmittedEvents: true,
        })
      : options.nativeHookRelay?.enabled === false
        ? buildCodexNativeHookRelayDisabledConfig()
        : undefined;
    const runtimeThreadConfig = buildCodexRuntimeThreadConfig(webSearchPlan.threadConfig, {
      nativeCodeModeEnabled: nativeToolSurfaceEnabled,
      nativeCodeModeOnlyEnabled: appServer.codeModeOnly,
    });
    const sideThreadId = await withLeasedCodexAppServerClientStartSelectionRetry({
      lease: clientLease,
      options: clientOptions,
      signal: runAbortController.signal,
      run: async (forkClient, requestOptions) =>
        options.bindingStore.withLease(bindingIdentity, async () => {
          const assertCurrentBinding = () => {
            assertCurrent();
            runAbortController.signal.throwIfAborted();
            if (!isDeepStrictEqual(options.bindingStore.read(bindingIdentity), binding)) {
              throw new Error("Codex side-question binding changed before fork");
            }
          };
          const currentRequestOptions = () => {
            const scoped = requestOptions();
            return {
              ...scoped,
              assertCurrent: () => {
                scoped.assertCurrent();
                assertCurrentBinding();
              },
            };
          };
          assertCurrentBinding();
          if (binding.connectionScope === "supervision") {
            const { thread } = await forkClient.request(
              "thread/read",
              {
                threadId: binding.threadId,
                includeTurns: false,
              },
              currentRequestOptions(),
            );
            assertCurrentBinding();
            assertCodexSupervisionThreadLineage(binding, thread);
          }
          await ensureSandboxEnvironment(forkClient);
          assertCurrentBinding();
          const executionCwd = sandboxEnvironment?.cwd ?? cwd;
          let pluginAppsConfigPatch: JsonObject | undefined;
          if (binding.pluginAppPolicyContext) {
            const refreshed = await refreshCodexPluginAppApprovalPolicy({
              policyContext: binding.pluginAppPolicyContext,
              configCwd: executionCwd,
              request: (method, requestParams) => {
                assertCurrentBinding();
                return forkClient.request(method, requestParams, currentRequestOptions());
              },
            }).finally(assertCurrentBinding);
            pluginAppPolicyContext = refreshed.policyContext;
            pluginAppsConfigPatch = refreshed.configPatch;
            for (const diagnostic of refreshed.diagnostics) {
              embeddedAgentLog.warn(diagnostic.message);
            }
          }
          assertCurrentBinding();
          // Fork reloads native config; refresh ask overrides before replaying the
          // bound app policy, including when /btw is the first run after restart.
          const threadConfig =
            mergeCodexThreadConfigs(
              nativeHookRelayConfig,
              runtimeThreadConfig,
              pluginAppsConfigPatch,
              appServer.networkProxy?.configPatch,
            ) ?? runtimeThreadConfig;
          const response = assertCodexThreadForkResponse(
            await forkCodexSideThread(
              forkClient,
              {
                threadId: binding.threadId,
                model: modelSelection.model,
                ...(modelSelection.modelProvider
                  ? { modelProvider: modelSelection.modelProvider }
                  : {}),
                cwd: executionCwd,
                ...(sessionPermissionPolicy
                  ? { runtimeWorkspaceRoots: [sessionPermissionPolicy.root] }
                  : {}),
                approvalPolicy,
                approvalsReviewer: appServer.approvalsReviewer,
                ...(sandboxEnvironment || appServer.networkProxy ? {} : { sandbox }),
                ...(serviceTier ? { serviceTier } : {}),
                config: threadConfig,
                developerInstructions: SIDE_DEVELOPER_INSTRUCTIONS,
                ephemeral: true,
                // Paginated ephemeral forks require metadata-only responses; history stays native.
                excludeTurns: true,
                threadSource: "user",
              },
              currentRequestOptions(),
            ),
          );
          if (!response.thread.id.trim() || response.thread.id === binding.threadId) {
            await retireUnsafeCodexTurnClientBestEffort(forkClient, "unsafe side child identity");
            throw new Error("Codex side fork returned an unsafe child identity");
          }
          childThreadId = response.thread.id;
          childClient = forkClient;
          collector = new CodexEphemeralTurn(forkClient, childThreadId, {
            textMode: "last",
            onRequest: handleServerRequest,
            onAssistantMessageStart: async () => {
              await params.opts?.onAssistantMessageStart?.();
            },
            onNotification: (notification) =>
              nativeToolLifecycleProjector?.handleNotification(notification),
          });
          // A terminal answer may still be projecting after transport closure;
          // native hook authority ends with the route, not that projection.
          if (nativeHookRelay) {
            collector.route.signal.addEventListener("abort", nativeHookRelay.unregister, {
              once: true,
            });
          }
          try {
            assertCurrentBinding();
            if (
              supervisionModelSelection &&
              (response.model !== supervisionModelSelection.model ||
                response.modelProvider !== supervisionModelSelection.modelProvider)
            ) {
              throw new Error(
                "Codex supervised side thread did not preserve its native model and provider",
              );
            }
            const scoped = requestOptions();
            await refreshCodexThreadPolicy({
              client: forkClient,
              threadId: childThreadId,
              developerInstructions: SIDE_DEVELOPER_INSTRUCTIONS,
              ...scoped,
              signal: runAbortController.signal,
              assertCurrent: () => {
                assertCurrent();
                runAbortController.signal.throwIfAborted();
                scoped.assertCurrent();
              },
            });
          } catch (error) {
            policyWriteUncertain =
              error instanceof CodexThreadPolicyHandoffError && error.outcome === "unknown";
            // A child already exists: selection recovery cannot repeat this callback.
            throw error instanceof CodexThreadPolicyHandoffError
              ? error
              : new CodexThreadPolicyHandoffError("not-written", error);
          }
          return response.thread.id;
        }),
      onClientChange: (nextClient) => {
        client = nextClient;
      },
    });

    const effort = usesSupervisionConnection
      ? undefined
      : resolveCodexAppServerReasoningEffort({
          thinkLevel: params.resolvedThinkLevel ?? "off",
          modelId: modelSelection.model,
          supportedReasoningEfforts: readCodexSupportedReasoningEfforts(
            params.runtimeModel?.compat,
          ),
        });
    const turnResponse = assertCodexTurnStartResponse(
      await client
        .request(
          "turn/start",
          {
            threadId: sideThreadId,
            input: buildCodexUserInput(params.question.trim(), params.images),
            additionalContext: buildCodexTemporalAdditionalContext(sideRunParams, {
              sessionStatusAvailable: toolBridge.availableTools.some(
                (tool) => tool.name === "session_status",
              ),
            }),
            ...(sandboxEnvironment
              ? {
                  cwd: sandboxEnvironment.cwd,
                  sandboxPolicy: resolveCodexExternalSandboxPolicyForOpenClawSandbox(
                    params.sandbox ?? undefined,
                  ),
                  environments: resolveCodexSandboxEnvironmentSelection(
                    sandboxEnvironment,
                    nativeToolSurfaceEnabled,
                  ),
                }
              : { cwd }),
            model: modelSelection.model,
            ...(usesSupervisionConnection ? {} : { personality: CODEX_NATIVE_PERSONALITY_NONE }),
            ...(serviceTier ? { serviceTier } : {}),
            ...(usesSupervisionConnection
              ? {}
              : {
                  effort,
                  collaborationMode: {
                    mode: "default" as const,
                    settings: {
                      model: modelSelection.model,
                      reasoning_effort: effort,
                      developer_instructions: null,
                    },
                  },
                }),
          },
          {
            timeoutMs: appServer.requestTimeoutMs,
            signal: runAbortController.signal,
            assertCurrent,
          },
        )
        .catch((error: unknown) => {
          if (isCodexAppServerIndeterminateRequestCancellationError(error)) {
            // Codex serializes an empty-id startup interrupt after this written turn/start.
            turnId = "";
          }
          throw error;
        }),
    );
    turnId = turnResponse.turn.id;
    assertCurrent();
    nativeToolLifecycleProjector = new CodexNativeToolLifecycleProjector(
      { ...sideRunParams, agentId: sessionAgentId },
      sideThreadId,
      turnId,
      {
        runAbortSignal: runAbortController.signal,
      },
    );
    for (const failure of pendingNativePreToolUseFailures) {
      nativeToolLifecycleProjector.recordPreToolUseFailure(failure);
    }
    pendingNativePreToolUseFailures.length = 0;
    if (!collector) {
      throw new Error("Codex side thread route was not reserved");
    }
    let result: Awaited<ReturnType<CodexEphemeralTurn["wait"]>>;
    try {
      result = await collector.wait(turnResponse.turn, {
        signal: runAbortController.signal,
        abortError: () => sandboxDisconnectError ?? new Error("Codex /btw was aborted."),
        timeout: {
          ms: SIDE_QUESTION_COMPLETION_TIMEOUT_MS,
          error: new CodexSideQuestionTimeoutError(
            "Codex /btw timed out waiting for the side thread to finish.",
          ),
        },
      });
    } catch (error) {
      if (error instanceof CodexSideQuestionTimeoutError && !runAbortController.signal.aborted) {
        runAbortController.abort(error);
      }
      throw error;
    }
    if (result.error || result.turn?.status === "failed") {
      throw formatCodexErrorMessage(
        result.error ?? {
          error: {
            message: result.turn?.error?.message ?? null,
            codexErrorInfo: result.turn?.error?.codexErrorInfo ?? null,
          },
        },
        readRecentCodexRateLimits(client),
      );
    }
    if (result.turn?.status === "interrupted") {
      throw new Error("Codex /btw side thread was interrupted.");
    }
    assertCurrent();
    if (!result.text) {
      throw new Error("Codex /btw completed without an answer.");
    }
    return { text: result.text, usage: result.usage };
  } catch (error) {
    primaryFailure = { error };
    throw error;
  } finally {
    // Cleanup aborts are ownership teardown, not a terminal run outcome.
    nativeToolRunWasAbortedBeforeCleanup = runAbortController.signal.aborted;
    params.opts?.abortSignal?.removeEventListener("abort", abortFromUpstream);
    if (!runAbortController.signal.aborted) {
      runAbortController.abort("codex_side_question_finished");
    }
    // Join dispatched side tools before releasing their native subscription.
    await Promise.allSettled(activeDynamicToolCalls);
    await cleanupCodexSideQuestion(childClient ?? client, {
      threadId: childThreadId,
      turnId,
      interrupt: !(collector?.completed || collector?.route.completed),
      terminateBackgroundTerminals: nativeToolRunWasAbortedBeforeCleanup,
      timeoutMs: appServer.requestTimeoutMs,
      failure: primaryFailure,
      afterThreadCleanup: [
        async () => {
          if (policyWriteUncertain && childClient) {
            await retireUnsafeCodexTurnClientBestEffort(childClient, "side policy handoff");
          }
        },
        () => collector?.route.release(),
        () => nativeToolLifecycleProjector?.finalizeActive(nativeToolRunWasAbortedBeforeCleanup),
        activateNativePreToolUseFailureFallback,
        flushPendingNativePreToolUseFailures,
        releaseSandboxEnvironment,
        () => releaseCodexAppServerClientLease(clientLease),
        () => nativeHookRelay?.unregister(),
        () =>
          runAgentCleanupStep({
            runId: sideRunParams.runId,
            sessionId: sideRunParams.sessionId,
            step: "codex-side-native-hook-relay-release",
            log: embeddedAgentLog,
            cleanup: async () => {
              await nativeHookRelay?.drain();
            },
          }),
      ],
    });
  }
}

function resolveCodexSideNativeHookRelayEvents(params: {
  configuredEvents?: readonly NativeHookRelayEvent[];
  approvalPolicy: CodexAppServerRuntimeOptions["approvalPolicy"];
}): readonly NativeHookRelayEvent[] {
  if (params.configuredEvents?.length) {
    return params.configuredEvents;
  }
  return params.approvalPolicy === "never"
    ? CODEX_NATIVE_HOOK_RELAY_EVENTS
    : CODEX_SIDE_NATIVE_HOOK_RELAY_EVENTS_WITH_APP_SERVER_APPROVALS;
}

function registerCodexSideNativeHookRelay(params: {
  options: {
    enabled?: boolean;
    ttlMs?: number;
    gatewayTimeoutMs?: number;
  };
  events: readonly NativeHookRelayEvent[];
  agentId: string | undefined;
  sessionId: string;
  sessionKey: string | undefined;
  config: EmbeddedRunAttemptParamsV2["config"];
  autoApproveMcpTools: boolean;
  projectedMcpServers: Parameters<typeof registerNativeHookRelay>[0]["projectedMcpServers"];
  runId: string;
  channelId?: string;
  requestTimeoutMs: number;
  completionTimeoutMs: number;
  loopDetectionPreToolUseRelay: boolean;
  signal: AbortSignal;
  hostCapabilities: EmbeddedRunAttemptParamsV2["hostCapabilities"];
  assertCurrent: () => void;
  onPreToolUseFailure: (failure: CodexNativePreToolUseFailure) => void;
}): ReturnType<typeof registerNativeHookRelayForBundledRuntime> | undefined {
  if (params.options.enabled === false) {
    return undefined;
  }
  return registerNativeHookRelayForBundledRuntime({
    provider: "codex",
    ...(params.agentId ? { agentId: params.agentId } : {}),
    sessionId: params.sessionId,
    ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
    ...(params.config ? { config: params.config } : {}),
    autoApproveMcpTools: params.autoApproveMcpTools,
    projectedMcpServers: params.projectedMcpServers,
    runId: params.runId,
    ...(params.channelId ? { channelId: params.channelId } : {}),
    allowedEvents: params.events,
    preToolUseLoopDetection: params.loopDetectionPreToolUseRelay,
    ttlMs: resolveCodexSideNativeHookRelayTtlMs({
      explicitTtlMs: params.options.ttlMs,
      requestTimeoutMs: params.requestTimeoutMs,
      completionTimeoutMs: params.completionTimeoutMs,
    }),
    signal: params.signal,
    runBeforeToolCall: params.hostCapabilities.runBeforeToolCall,
    assertActive: params.assertCurrent,
    onPreToolUseFailure: params.onPreToolUseFailure,
    command: {
      timeoutMs: params.options.gatewayTimeoutMs,
    },
  });
}

function resolveCodexSideNativeHookRelayTtlMs(params: {
  explicitTtlMs: number | undefined;
  requestTimeoutMs: number;
  completionTimeoutMs: number;
}): number {
  if (params.explicitTtlMs !== undefined) {
    return params.explicitTtlMs;
  }
  const relayBudgetMs =
    params.requestTimeoutMs * CODEX_SIDE_NATIVE_HOOK_RELAY_STARTUP_REQUEST_COUNT +
    params.completionTimeoutMs +
    CODEX_SIDE_NATIVE_HOOK_RELAY_TTL_GRACE_MS;
  return Math.max(CODEX_SIDE_NATIVE_HOOK_RELAY_MIN_TTL_MS, Math.floor(relayBudgetMs));
}

function buildSideRunAttemptParams(
  params: AgentHarnessSideQuestionParamsV2,
  options: { cwd: string; authProfileId?: string; runId: string; timeoutMs: number },
): EmbeddedRunAttemptParamsV2 {
  const sideParams = {
    params,
    config: params.cfg,
    agentDir: params.agentDir,
    provider: params.provider,
    modelId: params.model,
    model: params.runtimeModel ?? ({ id: params.model, provider: params.provider } as never),
    prompt: params.question,
    timeoutMs: options.timeoutMs,
    sessionId: params.sessionId,
    sessionFile: params.sessionFile,
    sessionKey: params.sessionKey,
    ...(params.sandboxSessionKey ? { sandboxSessionKey: params.sandboxSessionKey } : {}),
    agentId: params.agentId,
    ...(params.messageChannel ? { messageChannel: params.messageChannel } : {}),
    ...(params.messageProvider ? { messageProvider: params.messageProvider } : {}),
    ...(params.chatType ? { chatType: params.chatType } : {}),
    ...(params.agentAccountId ? { agentAccountId: params.agentAccountId } : {}),
    ...(params.messageTo ? { messageTo: params.messageTo } : {}),
    ...(params.messageThreadId !== undefined ? { messageThreadId: params.messageThreadId } : {}),
    ...(params.chatId ? { chatId: params.chatId } : {}),
    ...(params.messageActionTurnCapability
      ? { messageActionTurnCapability: params.messageActionTurnCapability }
      : {}),
    ...(params.groupId !== undefined ? { groupId: params.groupId } : {}),
    ...(params.groupChannel !== undefined ? { groupChannel: params.groupChannel } : {}),
    ...(params.groupSpace !== undefined ? { groupSpace: params.groupSpace } : {}),
    ...(params.memberRoleIds ? { memberRoleIds: params.memberRoleIds } : {}),
    ...(params.spawnedBy !== undefined ? { spawnedBy: params.spawnedBy } : {}),
    ...(params.senderId !== undefined ? { senderId: params.senderId } : {}),
    ...(params.senderName !== undefined ? { senderName: params.senderName } : {}),
    ...(params.senderUsername !== undefined ? { senderUsername: params.senderUsername } : {}),
    ...(params.senderE164 !== undefined ? { senderE164: params.senderE164 } : {}),
    ...(params.senderIsOwner !== undefined ? { senderIsOwner: params.senderIsOwner } : {}),
    ...(params.currentChannelId ? { currentChannelId: params.currentChannelId } : {}),
    ...(params.toolsAllow ? { toolsAllow: params.toolsAllow } : {}),
    workspaceDir: options.cwd,
    authProfileId: options.authProfileId,
    authProfileIdSource: options.authProfileId
      ? params.preparedRuntimeAuth.plan.forwardedAuthProfileSource
      : undefined,
    thinkLevel: params.resolvedThinkLevel ?? "off",
    resolvedReasoningLevel: params.resolvedReasoningLevel,
    authStorage: params.preparedRuntimeAuth.authStorage,
    authProfileStore: params.preparedRuntimeAuth.authProfileStore,
    modelRegistry: params.preparedRuntimeAuth.modelRegistry,
    preparedModelRuntime: params.preparedModelRuntime,
    ...(params.preparedRuntimeAuth.resolvedApiKey
      ? { resolvedApiKey: params.preparedRuntimeAuth.resolvedApiKey }
      : {}),
    runId: options.runId,
    abortSignal: params.opts?.abortSignal,
    onAgentEvent: (event: { stream: string; data: Record<string, unknown> }) => {
      if (event.stream === "approval") {
        void params.opts?.onApprovalEvent?.(event.data as never);
      }
    },
    onBlockReply: params.opts?.onBlockReply,
    onPartialReply: params.opts?.onPartialReply,
    onToolResult: params.opts?.onToolResult,
    requireExplicitMessageTarget: true,
    hostCapabilities: params.hostCapabilities,
    sandbox: params.sandbox,
  };
  return sideParams as EmbeddedRunAttemptParamsV2;
}

async function createCodexSideToolBridge(input: {
  params: EmbeddedRunAttemptParamsV2;
  cwd: string;
  resolvedWorkspace: string;
  pluginConfig: ReturnType<typeof readCodexPluginConfig>;
  sessionAgentId: string;
  nativeToolSurfaceEnabled: boolean;
  nativeProviderWebSearchSupport: CodexNativeWebSearchSupport;
  sessionPermissionPolicy?: CodexEffectiveSessionPermissionPolicy;
  runAbortController: AbortController;
}): Promise<{ toolBridge: CodexDynamicToolBridge; webSearchPlan: CodexWebSearchPlan }> {
  const { params } = input;
  const sandboxSessionKey =
    params.sandboxSessionKey?.trim() ||
    params.sessionKey?.trim() ||
    params.sessionId ||
    input.sessionAgentId;
  const sandbox =
    params.sandbox !== undefined
      ? params.sandbox
      : await resolveSandboxContext({
          config: params.config,
          sessionKey: sandboxSessionKey,
          workspaceDir: input.cwd,
        });
  let webSearchAllowed = false;
  const tools = await buildDynamicTools({
    params,
    resolvedWorkspace: input.resolvedWorkspace,
    effectiveWorkspace: input.cwd,
    sandboxSessionKey,
    sandbox,
    nativeToolSurfaceEnabled: input.nativeToolSurfaceEnabled,
    nativeProviderWebSearchSupport: input.nativeProviderWebSearchSupport,
    sessionPermissionPolicy: input.sessionPermissionPolicy,
    runAbortController: input.runAbortController,
    sessionAgentId: input.sessionAgentId,
    policyAgentId: input.sessionAgentId,
    pluginConfig: input.pluginConfig,
    onYieldDetected: () => {},
    onWebSearchPolicyResolved: (allowed) => {
      webSearchAllowed = allowed;
    },
  });
  const requestedWebSearchPlan = resolveCodexWebSearchPlan({
    config: params.config,
    nativeToolSurfaceEnabled: input.nativeToolSurfaceEnabled,
    nativeProviderWebSearchSupport: input.nativeProviderWebSearchSupport,
    webSearchAllowed,
  });
  // Forks inherit dynamic declarations; BTW retains its native-only search policy.
  const webSearchPlan =
    requestedWebSearchPlan.kind === "managed"
      ? resolveCodexWebSearchPlan({ config: params.config, webSearchAllowed: false })
      : requestedWebSearchPlan;
  // Side threads do not own the compaction lifecycle that expires screenshot coordinates.
  const exposedTools = tools.filter(
    (tool) => tool.name !== "web_search" && tool.name !== "computer",
  );
  return {
    toolBridge: createCodexDynamicToolBridge({
      tools: exposedTools,
      signal: input.runAbortController.signal,
      loading: resolveCodexDynamicToolsLoading(input.pluginConfig),
      hookContext: {
        agentId: input.sessionAgentId,
        config: params.config,
        contextWindowTokens: params.model.contextWindow,
        sessionId: params.sessionId,
        sessionKey: params.sessionKey,
        runId: params.runId,
        currentChannelProvider: resolveCodexMessageToolProvider(params),
        ...buildAgentHookContextChannelFields(params),
      },
    }),
    webSearchPlan,
  };
}

function emptySideUserInputResponse(): JsonObject {
  return { answers: {} };
}

function isSideUserInputRequest(
  value: JsonValue | undefined,
  threadId: string,
  turnId: string,
): boolean {
  return isJsonObject(value) && value.threadId === threadId && value.turnId === turnId;
}

async function forkCodexSideThread(
  client: CodexAppServerClient,
  params: CodexThreadForkParams,
  options: { timeoutMs: number; signal?: AbortSignal },
): Promise<unknown> {
  try {
    return await client.request("thread/fork", params, options);
  } catch (error) {
    if (isMissingCodexParentThreadError(error)) {
      throw new Error(
        "Codex /btw needs an active Codex thread. Send a normal message first, then try /btw again.",
        { cause: error },
      );
    }
    throw error;
  }
}

function isMissingCodexParentThreadError(error: unknown): boolean {
  const message = formatErrorMessage(error);
  return (
    message.includes("no rollout found for thread id") ||
    message.includes("includeTurns is unavailable before first user message")
  );
}

function formatCodexErrorMessage(params: JsonObject, rateLimits: JsonValue | undefined): Error {
  const error = isJsonObject(params.error) ? params.error : undefined;
  const message =
    formatCodexUsageLimitErrorMessage({
      message: error ? readString(error, "message") : undefined,
      codexErrorInfo: error?.codexErrorInfo,
      rateLimits,
    }) ??
    (error ? (readString(error, "message") ?? readString(error, "error")) : undefined) ??
    readString(params, "message") ??
    "Codex /btw side thread failed.";
  return new Error(formatErrorMessage(message));
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
