// Codex plugin module implements run attempt behavior.
import fs from "node:fs/promises";
import path from "node:path";
import {
  assembleHarnessContextEngine,
  assertContextEngineHostSupport,
  bootstrapHarnessContextEngine,
  buildHarnessContextEngineRuntimeContext,
  buildHarnessContextEngineRuntimeContextFromUsage,
  CODEX_APP_SERVER_CONTEXT_ENGINE_HOST,
  clearActiveEmbeddedRun,
  embeddedAgentLog,
  emitAgentEvent as emitGlobalAgentEvent,
  finalizeHarnessContextEngineTurn,
  formatErrorMessage,
  getAgentHarnessHookRunner,
  getBeforeToolCallPolicyDiagnosticState,
  isActiveHarnessContextEngine,
  loadCodexBundleMcpThreadConfig,
  resolveAgentHarnessBeforePromptBuildResult,
  resolveContextEngineOwnerPluginId,
  resolveSandboxContext,
  resolveSessionAgentIds,
  resolveUserPath,
  awaitAgentEndSideEffects,
  runAgentEndSideEffects,
  runAgentHarnessLlmInputHook,
  runAgentHarnessLlmOutputHook,
  runHarnessContextEngineMaintenance,
  setActiveEmbeddedRun,
  supportsModelTools,
  runAgentCleanupStep,
  type EmbeddedRunAttemptParams,
  type EmbeddedRunAttemptResult,
  type NativeHookRelayEvent,
  type NativeHookRelayRegistrationHandle,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { resolveAgentDir } from "openclaw/plugin-sdk/agent-runtime";
import {
  createDiagnosticTraceContextFromActiveScope,
  emitTrustedDiagnosticEvent,
  freezeDiagnosticTraceContext,
  onInternalDiagnosticEvent,
  resolveDiagnosticModelContentCapturePolicy,
} from "openclaw/plugin-sdk/diagnostic-runtime";
import { loadExecApprovals } from "openclaw/plugin-sdk/exec-approvals-runtime";
import { parseAgentSessionKey } from "openclaw/plugin-sdk/routing";
import { pathExists } from "openclaw/plugin-sdk/security-runtime";
import { resolveCodexAppServerForOpenClawToolPolicy } from "./app-server-policy.js";
import { handleCodexAppServerApprovalRequest } from "./approval-bridge.js";
import {
  CODEX_APP_SERVER_INTERRUPT_TIMEOUT_MS,
  CODEX_APP_SERVER_UNSUBSCRIBE_TIMEOUT_MS,
  interruptCodexTurnBestEffort,
  retireCodexAppServerClientAfterTimedOutTurn,
  runCodexTurnStartWithNativeTurnRetry,
  runCodexTurnStartWithLease,
  unsubscribeCodexThreadBestEffort,
} from "./attempt-client-cleanup.js";
import {
  buildCodexOpenClawPromptContext,
  buildCodexSystemPromptReport,
  buildCodexWorkspaceBootstrapContext,
  getCodexWorkspaceMemoryToolNames,
  prependCodexOpenClawPromptContext,
  readContextEngineThreadBootstrapProjection,
  readMirroredSessionHistoryMessages,
  renderCodexSkillsCollaborationInstructions,
  resolveCodexDeliveryHintPreservedInputRange,
  resolveContextEngineBootstrapProjectionDecision,
} from "./attempt-context.js";
import {
  classifyCodexModelCallFailureKind,
  createCodexModelCallDiagnosticEmitter,
  utf8JsonByteLength,
} from "./attempt-diagnostics.js";
import {
  applyCodexTurnNotificationState,
  isTerminalCodexTurnNotificationForTurn,
  reportCodexExecutionNotification,
} from "./attempt-notification-state.js";
import { isTerminalTurnStatus } from "./attempt-notifications.js";
import {
  buildCodexAppServerPromptTimeoutOutcome,
  buildCodexTurnStartFailureResult,
  collectTerminalAssistantText,
  isInvalidCodexImagePayloadError,
  resolveCodexAppServerReplayBlockedReason,
} from "./attempt-results.js";
import { startCodexAttemptThread } from "./attempt-startup.js";
import { createCodexSteeringQueue, type CodexSteeringQueueOptions } from "./attempt-steering.js";
import {
  resolveCodexPostToolRawAssistantCompletionIdleTimeoutMs,
  resolveCodexStartupTimeoutMs,
  resolveCodexTurnAssistantCompletionIdleTimeoutMs,
  resolveCodexTurnCompletionIdleTimeoutMs,
  resolveCodexTurnTerminalIdleTimeoutMs,
  withCodexStartupTimeout,
} from "./attempt-timeouts.js";
import {
  createCodexAttemptTurnWatchController,
  type CodexAttemptTurnWatchTimeoutKind,
} from "./attempt-turn-watches.js";
import {
  resolveCodexAppServerAuthAccountCacheKey,
  resolveCodexAppServerFallbackApiKeyCacheKey,
  resolveCodexAppServerAuthProfileId,
  resolveCodexAppServerAuthProfileIdForAgent,
} from "./auth-bridge.js";
import { isCodexAppServerApprovalRequest, type CodexAppServerClient } from "./client.js";
import {
  isCodexAppServerApprovalPolicyAllowedByRequirements,
  isCodexSandboxExecServerEnabled,
  readCodexPluginConfig,
  resolveCodexComputerUseConfig,
  resolveCodexAppServerRuntime,
  resolveCodexModelBackedReviewerPolicyContext,
  resolveOpenClawExecPolicyForCodexAppServer,
  shouldAutoApproveCodexAppServerApprovals,
  withMcpElicitationsApprovalPolicy,
  type CodexAppServerRuntimeOptions,
  type OpenClawExecPolicyForCodexAppServer,
} from "./config.js";
import {
  type CodexProjectedContextRange,
  fitCodexProjectedContextForTurnStart,
  projectContextEngineAssemblyForCodex,
  resolveCodexContextEngineProjectionMaxChars,
  resolveCodexContextEngineProjectionReserveTokens,
} from "./context-engine-projection.js";
import {
  createCodexDynamicToolBuildStageTracker,
  filterCodexDynamicToolsForAllowlist,
  formatCodexDynamicToolBuildStageSummary,
  includeForcedCodexDynamicToolAllow,
  isCodexNativeExecutionBlockedByNodeExecHost,
  prepareDynamicToolCatalog,
  resolveCodexAppServerHookChannelId,
  resolveCodexMessageToolProvider,
  resolveOpenClawCodingToolsSessionKeys,
  resetOpenClawCodingToolsFactoryForTests,
  setOpenClawCodingToolsFactoryForTests,
  shouldEnableCodexAppServerNativeToolSurface,
  shouldForceMessageTool,
  shouldWarnCodexDynamicToolBuildStageSummary,
} from "./dynamic-tool-build.js";
import {
  emitDynamicToolErrorDiagnostic,
  emitDynamicToolStartedDiagnostic,
  emitDynamicToolTerminalDiagnostic,
} from "./dynamic-tool-diagnostics.js";
import {
  handleDynamicToolCallWithTimeout,
  hasPendingDynamicToolTerminalDiagnostic,
  isDynamicToolTerminalDiagnosticEvent,
  isMatchingDynamicToolTerminalDiagnostic,
  resolveDynamicToolCallTimeoutMs,
  resolveTerminalDynamicToolBatchAction,
  shouldBlockTerminalReleaseForNonTerminalDynamicToolResult,
  shouldReleaseTurnAfterTerminalDynamicTool,
  toCodexDynamicToolProgressResponse,
  toCodexDynamicToolProtocolResponse,
} from "./dynamic-tool-execution.js";
import {
  filterCodexDynamicTools,
  resolveCodexDynamicToolsLoadingForModel,
  resolveCodexDynamicToolsLoadingForRuntime,
} from "./dynamic-tool-profile.js";
import { createCodexDynamicToolBridge } from "./dynamic-tools.js";
import { handleCodexAppServerElicitationRequest } from "./elicitation-bridge.js";
import {
  CodexAppServerEventProjector,
  shouldEmitTranscriptToolProgress,
} from "./event-projector.js";
import {
  buildCodexNativeHookRelayDisabledConfig,
  buildCodexNativeHookRelayConfig,
  buildCodexNativeHookRelayId,
  clearPendingCodexNativeHookRelayUnregistersForTests,
  CODEX_NATIVE_HOOK_RELAY_TTL_GRACE_MS,
  createCodexNativeHookRelay,
  flushPendingCodexNativeHookRelayUnregistersForTests,
  resolveCodexNativeHookRelayEvents,
  resolveCodexNativeHookRelayTtlMs,
  resolveCodexNativeHookRelayUnregisterGraceMs,
  scheduleCodexNativeHookRelayUnregister,
} from "./native-hook-relay.js";
import {
  registerCodexNativeSubagentMonitor,
  type CodexNativeSubagentMonitorRegistration,
} from "./native-subagent-monitor.js";
import { isCodexAppServerProfilerEnabled } from "./profiler-flag.js";
import { joinCodexPromptSections } from "./prompt-sections.js";
import {
  assertCodexTurnStartResponse,
  readCodexDynamicToolCallParams,
} from "./protocol-validators.js";
import {
  flattenCodexDynamicToolFunctions,
  isJsonObject,
  type CodexSandboxPolicy,
  type CodexTurnEnvironmentParams,
  type CodexServerNotification,
  type CodexDynamicToolCallParams,
  type CodexDynamicToolCallResponse,
  type CodexTurnStartResponse,
  type JsonObject,
  type JsonValue,
} from "./protocol.js";
import { readCodexRateLimitsRevision, readRecentCodexRateLimits } from "./rate-limit-cache.js";
import { releaseCodexSandboxExecServerEnvironment } from "./sandbox-exec-server.js";
import {
  resolveCodexAppServerBindingModelProvider,
  sessionBindingIdentity,
  type CodexAppServerBindingIdentity,
  type CodexAppServerBindingStore,
  type CodexAppServerThreadBinding,
} from "./session-binding.js";
import {
  retainSharedCodexAppServerClient,
  type CodexAppServerClientLease,
  type CodexAppServerClientLeaseFactory,
} from "./shared-client.js";
import { estimateCodexAppServerProjectedTurnTokens } from "./startup-binding.js";
import {
  buildDeveloperInstructions,
  buildContextEngineBinding,
  buildTurnCollaborationMode,
  buildTurnStartParams,
  codexDynamicToolsFingerprint,
  resolveCodexAppServerModelProvider,
  type CodexAppServerThreadLifecycleBinding,
  type CodexContextEngineThreadBootstrapProjection,
} from "./thread-lifecycle.js";
import { readCodexNativeContextUsage } from "./thread-resume.js";
import {
  inferCodexDynamicToolMeta,
  resolveCodexToolProgressDetailMode,
  sanitizeCodexToolArguments,
  sanitizeCodexToolResponse,
} from "./tool-progress-normalization.js";
import {
  createCodexTrajectoryRecorder,
  normalizeCodexTrajectoryError,
  recordCodexTrajectoryCompletion,
  recordCodexTrajectoryContext,
} from "./trajectory.js";
import {
  buildCodexUserPromptMessage,
  createCodexAppServerUserMessagePersistenceNotifier,
  mirrorPromptAtTurnStartBestEffort,
  mirrorTranscriptBestEffort,
} from "./transcript-mirror.js";
import {
  CODEX_APP_SERVER_NATIVE_TURN_WAIT_TIMEOUT_MS,
  type CodexAppServerTurnRouter,
  type CodexAppServerServerRequest,
  type CodexThreadRouteReservation,
  type CodexThreadRouteScope,
} from "./turn-router.js";
import {
  formatCodexTurnStartUsageLimitError,
  markCodexAuthProfileBlockedFromRateLimits,
  refreshCodexUsageLimitPromptError,
} from "./usage-limit-error.js";
import { createCodexUserInputBridge } from "./user-input-bridge.js";
import { resolveCodexWebSearchPlan } from "./web-search.js";

const CODEX_NATIVE_HOOK_RELAY_RENEW_INTERVAL_MS = 60_000;
const ensuredCodexWorkspaceDirs = new Set<string>();

function resolveCodexSandboxAgentId(params: {
  sandboxSessionKey?: string;
  sessionAgentId: string;
}): string | undefined {
  const explicitSandboxKey = params.sandboxSessionKey?.trim();
  return explicitSandboxKey && parseAgentSessionKey(explicitSandboxKey)
    ? undefined
    : params.sessionAgentId;
}

async function ensureCodexWorkspaceDirOnce(workspaceDir: string): Promise<void> {
  const normalized = path.resolve(workspaceDir);
  if (ensuredCodexWorkspaceDirs.has(normalized)) {
    return;
  }
  // Workspace roots are process-stable. Their owner must restart the runtime
  // after pruning; request-time turns do not poll filesystem freshness.
  await fs.mkdir(normalized, { recursive: true });
  ensuredCodexWorkspaceDirs.add(normalized);
}

function emitCodexAppServerEvent(
  params: EmbeddedRunAttemptParams,
  event: Parameters<NonNullable<EmbeddedRunAttemptParams["onAgentEvent"]>>[0],
): void {
  try {
    emitGlobalAgentEvent({
      runId: params.runId,
      stream: event.stream,
      data: event.data,
      ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
    });
  } catch (error) {
    embeddedAgentLog.debug("codex app-server global agent event emit failed", { error });
  }
  try {
    const maybePromise = params.onAgentEvent?.(event);
    void Promise.resolve(maybePromise).catch((error: unknown) => {
      embeddedAgentLog.debug("codex app-server agent event handler rejected", { error });
    });
  } catch (error) {
    // Event consumers are observational; they must not abort or strand the
    // canonical app-server turn lifecycle.
    embeddedAgentLog.debug("codex app-server agent event handler threw", { error });
  }
}

function toTranscriptToolResult(response: CodexDynamicToolCallResponse): Record<string, unknown> {
  const sanitized = sanitizeCodexToolResponse(response);
  const contentItems = Array.isArray(sanitized.contentItems) ? sanitized.contentItems : [];
  const result: Record<string, unknown> = {
    ...sanitized,
    // Progress events are UI/transcript-facing; map only sanitized content so
    // event redaction cannot be bypassed by raw dynamic tool output.
    content: contentItems.map(toTranscriptToolResultContentItem),
  };
  delete result.contentItems;
  delete result.success;
  return result;
}

function toTranscriptToolResultContentItem(item: unknown): Record<string, unknown> {
  if (!item || typeof item !== "object") {
    return { type: "text", text: "" };
  }
  const record = item as Record<string, unknown>;
  if (record.type === "inputText") {
    return { type: "text", text: typeof record.text === "string" ? record.text : "" };
  }
  if (record.type === "inputImage") {
    return typeof record.imageUrl === "string"
      ? { type: "image", url: record.imageUrl }
      : { type: "text", text: formatUnsupportedCodexDynamicToolOutput(record.type) };
  }
  return { type: "text", text: formatUnsupportedCodexDynamicToolOutput(record.type) };
}

function formatUnsupportedCodexDynamicToolOutput(type: unknown): string {
  const rawType = typeof type === "string" ? type.replace(/\s+/g, " ").trim() : "";
  const label = rawType ? rawType.slice(0, 80) : "unknown";
  const suffix = rawType.length > 80 ? "..." : "";
  return `[Unsupported Codex dynamic tool output: ${label}${suffix}]`;
}

type CodexAgentEndHookParams = Parameters<typeof runAgentEndSideEffects>[0];

function shouldAwaitCodexAgentEndHook(params: EmbeddedRunAttemptParams): boolean {
  return !params.messageChannel && !params.messageProvider;
}

async function runCodexAgentEndHook(
  params: EmbeddedRunAttemptParams,
  hookParams: CodexAgentEndHookParams,
): Promise<void> {
  const sideEffectParams = {
    ...hookParams,
    ctx: { ...hookParams.ctx, config: params.config },
  };
  if (shouldAwaitCodexAgentEndHook(params)) {
    await awaitAgentEndSideEffects(sideEffectParams);
    return;
  }
  runAgentEndSideEffects(sideEffectParams);
}

export async function runCodexAppServerAttempt(
  params: EmbeddedRunAttemptParams,
  options: {
    bindingStore: CodexAppServerBindingStore;
    pluginConfig?: unknown;
    startupTimeoutFloorMs?: number;
    nativeHookRelay?: {
      enabled?: boolean;
      events?: readonly NativeHookRelayEvent[];
      ttlMs?: number;
      gatewayTimeoutMs?: number;
      hookTimeoutSec?: number;
    };
    turnCompletionIdleTimeoutMs?: number;
    turnAssistantCompletionIdleTimeoutMs?: number;
    postToolRawAssistantCompletionIdleTimeoutMs?: number;
    turnTerminalIdleTimeoutMs?: number;
    clientLeaseFactory?: CodexAppServerClientLeaseFactory;
  },
): Promise<EmbeddedRunAttemptResult> {
  const attemptStartedAt = Date.now();
  const profilerEnabled = isCodexAppServerProfilerEnabled(params.config);
  const codexModelCallTrace = freezeDiagnosticTraceContext(
    createDiagnosticTraceContextFromActiveScope(),
  );
  const codexModelContentCapture = resolveDiagnosticModelContentCapturePolicy(params.config);
  const codexModelCallId = `${params.runId}:codex-model:1`;
  // Startup phase timings are profiler-gated because this function runs before
  // every Codex turn; normal production should not do timing bookkeeping here.
  const preDynamicStartupStages = createCodexDynamicToolBuildStageTracker({
    enabled: profilerEnabled,
  });
  const pluginConfig = readCodexPluginConfig(options.pluginConfig);
  const computerUseConfig = resolveCodexComputerUseConfig({ pluginConfig });
  const { sessionAgentId } = resolveSessionAgentIds({
    sessionKey: params.sessionKey,
    config: params.config,
    agentId: params.agentId,
  });
  const beforeToolCallPolicy = getBeforeToolCallPolicyDiagnosticState();
  preDynamicStartupStages.mark("config");
  const resolvedWorkspace = resolveUserPath(params.workspaceDir);
  await ensureCodexWorkspaceDirOnce(resolvedWorkspace);
  preDynamicStartupStages.mark("workspace");
  const sandboxSessionKey =
    params.sandboxSessionKey?.trim() || params.sessionKey?.trim() || params.sessionId;
  const contextSessionKey = params.sessionKey?.trim() || sandboxSessionKey;
  const sandboxAgentId = resolveCodexSandboxAgentId({
    sandboxSessionKey: params.sandboxSessionKey,
    sessionAgentId,
  });
  const sandbox = await resolveSandboxContext({
    config: params.config,
    ...(sandboxAgentId ? { agentId: sandboxAgentId } : {}),
    sessionKey: sandboxSessionKey,
    workspaceDir: resolvedWorkspace,
  });
  preDynamicStartupStages.mark("sandbox");
  const execPolicy = resolveOpenClawExecPolicyForCodexAppServer({
    execOverrides: params.execOverrides,
    approvals: loadExecApprovals(),
    config: params.config,
    agentId: sessionAgentId,
  });
  const agentDir = params.agentDir ?? resolveAgentDir(params.config ?? {}, sessionAgentId);
  const bindingIdentity: CodexAppServerBindingIdentity = sessionBindingIdentity({
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    agentId: params.agentId,
    config: params.config,
  });
  const bindingStore = options.bindingStore;
  preDynamicStartupStages.mark("session-agent");
  const activeContextEngine = isActiveHarnessContextEngine(params.contextEngine)
    ? params.contextEngine
    : undefined;
  const isInactiveThreadBootstrapBinding = (binding: CodexAppServerThreadBinding | undefined) =>
    !activeContextEngine && binding?.contextEngine?.projection?.mode === "thread_bootstrap";
  const startupBinding = await bindingStore.read(bindingIdentity);
  preDynamicStartupStages.mark("read-binding");
  const startupAuthProfileCandidate =
    params.runtimePlan?.auth.forwardedAuthProfileId ??
    params.authProfileId ??
    startupBinding?.authProfileId;
  const startupAuthProfileId = params.authProfileStore
    ? resolveCodexAppServerAuthProfileId({
        authProfileId: startupAuthProfileCandidate,
        store: params.authProfileStore,
        config: params.config,
      })
    : resolveCodexAppServerAuthProfileIdForAgent({
        authProfileId: startupAuthProfileCandidate,
        agentDir,
        config: params.config,
      });
  const startupRequestModelProvider = resolveCodexAppServerModelProvider({
    provider: params.provider,
    authProfileId: startupAuthProfileId,
    authProfileStore: params.authProfileStore,
    agentDir,
    config: params.config,
  });
  // Native OpenAI is the only provider intentionally omitted from a stored
  // binding. Reuse that fact on resume so Codex does not cold-reload an idle
  // thread merely because speculative reviewer overrides changed.
  const startupBindingModelProvider = startupBinding
    ? resolveCodexAppServerBindingModelProvider({
        modelProvider: startupBinding.modelProvider,
        authProfileId: startupAuthProfileId,
        authProfileStore: params.authProfileStore,
        agentDir,
        config: params.config,
      })
    : undefined;
  const reviewerPolicyContext = resolveCodexModelBackedReviewerPolicyContext({
    provider: startupRequestModelProvider,
    model: params.modelId,
    bindingModelProvider: startupBindingModelProvider,
    bindingModel: startupBinding?.model,
  });
  preDynamicStartupStages.mark("auth-profile");
  const resolveAppServerForReviewerContext = (
    reviewerContext: ReturnType<typeof resolveCodexModelBackedReviewerPolicyContext>,
  ) => {
    const { appServer: configured } = resolveCodexAppServerRuntime({
      pluginConfig,
      execPolicy,
      modelProvider: reviewerContext.modelProvider,
      model: reviewerContext.model,
      config: params.config,
      agentDir,
      openClawSandboxActive: sandbox?.enabled === true,
    });
    return {
      configured,
      resolved: resolveCodexAppServerForOpenClawToolPolicy({
        appServer: configured,
        pluginConfig,
        env: process.env,
        shouldPromote:
          beforeToolCallPolicy.hasBeforeToolCallHook ||
          beforeToolCallPolicy.trustedToolPolicies.length > 0,
        execPolicy,
        canUseUntrustedApprovalPolicy:
          configured.start.transport !== "stdio" ||
          isCodexAppServerApprovalPolicyAllowedByRequirements("untrusted"),
      }),
    };
  };
  const { configured: configuredAppServer, resolved: appServer } =
    resolveAppServerForReviewerContext(reviewerPolicyContext);
  const effectiveWorkspace = sandbox?.enabled
    ? sandbox.workspaceAccess === "rw"
      ? resolvedWorkspace
      : sandbox.workspaceDir
    : resolvedWorkspace;
  const requestedCwd = params.cwd ? resolveUserPath(params.cwd) : undefined;
  if (sandbox?.enabled && requestedCwd && requestedCwd !== resolvedWorkspace) {
    throw new Error(
      "cwd override is not supported for sandboxed Codex app-server runs; omit cwd or use the agent workspace as cwd",
    );
  }
  const effectiveCwd = sandbox?.enabled ? effectiveWorkspace : (requestedCwd ?? effectiveWorkspace);
  await ensureCodexWorkspaceDirOnce(effectiveWorkspace);
  preDynamicStartupStages.mark("effective-workspace");
  if (configuredAppServer.approvalPolicy === "never" && appServer.approvalPolicy === "untrusted") {
    embeddedAgentLog.info("codex app-server approval policy promoted for OpenClaw tool policy", {
      from: "never",
      to: "untrusted",
      beforeToolCallHook: beforeToolCallPolicy.hasBeforeToolCallHook,
      trustedToolPolicies: beforeToolCallPolicy.trustedToolPolicies,
    });
  }
  preDynamicStartupStages.mark("app-server-policy");
  let pluginAppServer: CodexAppServerRuntimeOptions = appServer;
  const nativeHookRelayEvents = resolveCodexNativeHookRelayEvents({
    configuredEvents: options.nativeHookRelay?.events,
  });
  preDynamicStartupStages.mark("native-hook-relay");

  const runAbortController = new AbortController();
  const abortFromUpstream = () => {
    runAbortController.abort(params.abortSignal?.reason ?? "upstream_abort");
  };
  if (params.abortSignal?.aborted) {
    abortFromUpstream();
  } else {
    params.abortSignal?.addEventListener("abort", abortFromUpstream, { once: true });
  }

  const runtimeParams = {
    ...params,
    agentDir,
    sessionKey: contextSessionKey,
    ...(startupAuthProfileId ? { authProfileId: startupAuthProfileId } : {}),
  };
  const activeSessionId = params.sessionId;
  const activeSessionFile = params.sessionFile;
  const buildActiveRunAttemptParams = (): EmbeddedRunAttemptParams => ({
    ...runtimeParams,
    sessionId: activeSessionId,
    sessionFile: activeSessionFile,
  });
  const startupAuthAccountCacheKey = await resolveCodexAppServerAuthAccountCacheKey({
    authProfileId: startupAuthProfileId,
    authProfileStore: params.authProfileStore,
    agentDir,
    config: params.config,
  });
  const startupEnvApiKeyCacheKey = startupAuthProfileId
    ? undefined
    : resolveCodexAppServerFallbackApiKeyCacheKey({
        startOptions: appServer.start,
      });
  preDynamicStartupStages.mark("auth-cache");
  const bundleMcpThreadConfig = await loadCodexBundleMcpThreadConfig({
    workspaceDir: effectiveWorkspace,
    cfg: params.config,
    toolsEnabled: supportsModelTools(params.model),
    disableTools: params.disableTools,
    toolsAllow: params.toolsAllow,
  });
  preDynamicStartupStages.mark("bundle-mcp");
  const sandboxExecServerEnabled = isCodexSandboxExecServerEnabled(pluginConfig);
  const nativeToolSurfaceEnabled = shouldEnableCodexAppServerNativeToolSurface(params, sandbox, {
    agentId: sessionAgentId,
    runtimeSessionKey: sandboxSessionKey,
    sandboxExecServerEnabled,
  });
  preDynamicStartupStages.mark("native-tool-surface");
  const nativeProviderWebSearchSupport =
    resolveCodexWebSearchPlan({
      config: params.config,
      disableTools: params.disableTools,
      nativeToolSurfaceEnabled,
    }).kind === "native-hosted"
      ? await resolveCodexProviderWebSearchSupport({
          clientFactory: attemptClientFactory,
          appServer,
          authProfileId: startupAuthProfileId,
          agentDir,
          config: params.config,
          modelProviderOverride: resolveCodexAppServerThreadModelSelection({
            provider: params.provider,
            model: params.modelId,
            binding: startupBinding,
            authProfileId: startupAuthProfileId,
            authProfileStore: params.authProfileStore,
            agentDir,
            config: params.config,
          }).modelProvider,
          signal: runAbortController.signal,
        })
      : "unsupported";
  preDynamicStartupStages.mark("provider-capabilities");
  for (const diagnostic of bundleMcpThreadConfig.diagnostics) {
    embeddedAgentLog.warn(`bundle-mcp: ${diagnostic.pluginId}: ${diagnostic.message}`);
  }
  if (activeContextEngine) {
    assertContextEngineHostSupport({
      contextEngine: activeContextEngine,
      operation: "agent-run",
      host: CODEX_APP_SERVER_CONTEXT_ENGINE_HOST,
    });
  }
  const hookChannelId = resolveCodexAppServerHookChannelId(params, sandboxSessionKey);
  preDynamicStartupStages.mark("context-engine-support");
  const preDynamicSummary = preDynamicStartupStages.snapshot();
  if (shouldWarnCodexDynamicToolBuildStageSummary(preDynamicSummary)) {
    embeddedAgentLog.warn(
      `codex app-server pre-dynamic startup timings runId=${params.runId} sessionId=${params.sessionId} totalMs=${preDynamicSummary.totalMs} stages=${formatCodexDynamicToolBuildStageSummary(preDynamicSummary)}`,
      {
        runId: params.runId,
        sessionId: params.sessionId,
        totalMs: preDynamicSummary.totalMs,
        stages: preDynamicSummary.stages,
        hasStartupBinding: Boolean(startupBinding?.threadId),
        startupAuthProfileId: startupAuthProfileId ?? null,
        bundleMcpDiagnosticCount: bundleMcpThreadConfig.diagnostics.length,
        nativeToolSurfaceEnabled,
      },
    );
  }
  let yieldDetected = false;
  const { tools, registeredTools } = await prepareDynamicToolCatalog({
    params,
    resolvedWorkspace,
    effectiveWorkspace,
    effectiveCwd,
    sandboxSessionKey,
    sandbox,
    nativeToolSurfaceEnabled,
    nativeProviderWebSearchSupport,
    runAbortController,
    sessionAgentId,
    pluginConfig,
    profilerEnabled,
    onYieldDetected: () => {
      yieldDetected = true;
    },
    onCodexAppServerEvent: (event) => emitCodexAppServerEvent(params, event),
    onPersistentWebSearchPolicyResolved: (allowed) => {
      persistentWebSearchAllowed = allowed;
    },
    onWebSearchPolicyResolved: (allowed) => {
      webSearchAllowed = allowed;
    },
  });
  const toolBridge = createCodexDynamicToolBridge({
    tools,
    registeredTools,
    signal: runAbortController.signal,
    loading: resolveCodexDynamicToolsLoadingForRuntime(pluginConfig, params.modelId, {
      connectionClass: appServer.connectionClass,
    }),
    directToolNames: resolveCodexDynamicToolDirectNames(params),
    hookContext: {
      agentId: sessionAgentId,
      config: params.config,
      sessionId: params.sessionId,
      sessionKey: sandboxSessionKey,
      runId: params.runId,
      channelId: hookChannelId,
      currentChannelProvider: resolveCodexMessageToolProvider(params),
      currentChannelId: params.currentChannelId,
      currentMessagingTarget: params.currentMessagingTarget,
      currentThreadId: params.currentThreadTs,
      replyToMode: params.replyToMode,
      hasRepliedRef: params.hasRepliedRef,
      onToolOutcome: onCodexToolOutcome,
      allocateToolOutcomeOrdinal: allocateCodexToolOutcomeOrdinal,
    },
  });
  const hadSessionFile = await pathExists(activeSessionFile);
  let historyMessages = (await readMirroredSessionHistoryMessages(activeSessionFile)) ?? [];
  const hookContextWindowFields = {
    ...(params.contextWindowInfo?.tokens
      ? { contextTokenBudget: params.contextWindowInfo.tokens }
      : params.contextTokenBudget
        ? { contextTokenBudget: params.contextTokenBudget }
        : {}),
    ...(params.contextWindowInfo?.source
      ? { contextWindowSource: params.contextWindowInfo.source }
      : {}),
    ...(params.contextWindowInfo?.referenceTokens
      ? { contextWindowReferenceTokens: params.contextWindowInfo.referenceTokens }
      : {}),
  };
  const hookContext = {
    runId: params.runId,
    agentId: sessionAgentId,
    sessionKey: sandboxSessionKey,
    sessionId: params.sessionId,
    workspaceDir: params.workspaceDir,
    messageProvider: params.messageProvider ?? undefined,
    trigger: params.trigger,
    channelId: hookChannelId,
    ...hookContextWindowFields,
  };
  const hookRunner = getAgentHarnessHookRunner();
  const activeContextEnginePluginId = activeContextEngine
    ? resolveContextEngineOwnerPluginId(activeContextEngine)
    : undefined;
  const buildActiveContextEngineRuntimeContext = () =>
    buildHarnessContextEngineRuntimeContext({
      attempt: buildActiveRunAttemptParams(),
      workspaceDir: effectiveWorkspace,
      cwd: effectiveCwd,
      agentDir,
      activeAgentId: sessionAgentId,
      contextEnginePluginId: activeContextEnginePluginId,
      tokenBudget: params.contextTokenBudget,
    });
  if (activeContextEngine) {
    await bootstrapHarnessContextEngine({
      hadSessionFile,
      contextEngine: activeContextEngine,
      sessionId: activeSessionId,
      sessionKey: contextSessionKey,
      sessionFile: activeSessionFile,
      runtimeContext: buildActiveContextEngineRuntimeContext(),
      contextEngineHostSupport: CODEX_APP_SERVER_CONTEXT_ENGINE_HOST,
      providerId: params.provider,
      requestedModelId: params.requestedModelId,
      modelId: params.modelId,
      fallbackReason: params.fallbackReason,
      degradedReason: params.degradedReason,
      runMaintenance: runHarnessContextEngineMaintenance,
      config: params.config,
      warn: (message) => embeddedAgentLog.warn(message),
    });
    historyMessages =
      (await readMirroredSessionHistoryMessages(activeSessionFile)) ?? historyMessages;
  }
  const memoryToolNames = getCodexWorkspaceMemoryToolNames(toolBridge.availableSpecs);
  const workspaceBootstrapContext = await buildCodexWorkspaceBootstrapContext({
    params,
    resolvedWorkspace,
    effectiveWorkspace,
    sessionKey: contextSessionKey,
    sessionAgentId,
    memoryToolNames,
  });
  const baseDeveloperInstructions = joinCodexPromptSections(
    buildDeveloperInstructions(params, {
      dynamicTools: toolBridge.availableSpecs,
    }),
    workspaceBootstrapContext.developerInstructions,
  );
  const openClawPromptContext = buildCodexOpenClawPromptContext({
    params,
    workspacePromptContext: workspaceBootstrapContext.promptContext,
  });
  const skillsCollaborationInstructions = renderCodexSkillsCollaborationInstructions({
    attempt: params,
    skillsPrompt: params.skillsSnapshot?.prompt,
  });
  let promptText = params.prompt;
  let promptContextRange: CodexProjectedContextRange | undefined;
  let developerInstructions = baseDeveloperInstructions;
  let prePromptMessageCount = historyMessages.length;
  const codexContextProjectionMaxChars = resolveCodexContextEngineProjectionMaxChars({
    contextTokenBudget: params.contextTokenBudget,
    reserveTokens: resolveCodexContextEngineProjectionReserveTokens({
      config: params.config,
    }),
  });
  let contextEngineProjection: CodexContextEngineThreadBootstrapProjection | undefined;
  let activeContextEngineProjectedPromptText: string | undefined;
  let activeContextEngineProjectionApplied = false;
  let precomputedStaleBindingContinuityProjectionApplied = false;
  let inactiveThreadBootstrapBindingForcedFreshStart = false;
  const applyFreshThreadContinuityProjection = () => {
    const projection = projectContextEngineAssemblyForCodex({
      assembledMessages: historyMessages,
      originalHistoryMessages: historyMessages,
      prompt: params.prompt,
      maxRenderedContextChars: codexContextProjectionMaxChars,
    });
    promptText = projection.promptText;
    promptContextRange = projection.promptContextRange;
    prePromptMessageCount = projection.prePromptMessageCount;
  };
  const applyActiveContextEngineProjection = async (
    decisionStartupBinding: CodexAppServerThreadBinding | undefined,
  ) => {
    if (!activeContextEngine) {
      return;
    }
    const assembled = await assembleHarnessContextEngine({
      contextEngine: activeContextEngine,
      sessionId: activeSessionId,
      sessionKey: contextSessionKey,
      messages: historyMessages,
      tokenBudget: params.contextTokenBudget,
      availableTools: new Set(
        flattenCodexDynamicToolFunctions(toolBridge.availableSpecs)
          .map((tool) => tool.name)
          .filter(isNonEmptyString),
      ),
      citationsMode: params.config?.memory?.citations,
      modelId: params.modelId,
      contextEngineHostSupport: CODEX_APP_SERVER_CONTEXT_ENGINE_HOST,
      providerId: params.provider,
      requestedModelId: params.requestedModelId,
      fallbackReason: params.fallbackReason,
      degradedReason: params.degradedReason,
      prompt: params.prompt,
    });
    if (!assembled) {
      throw new Error("context engine assemble returned no result");
    }
    contextEngineProjection = readContextEngineThreadBootstrapProjection(
      assembled.contextProjection,
    );
    const projection = projectContextEngineAssemblyForCodex({
      assembledMessages: assembled.messages,
      originalHistoryMessages: historyMessages,
      prompt: params.prompt,
      systemPromptAddition: assembled.systemPromptAddition,
      maxRenderedContextChars: codexContextProjectionMaxChars,
      toolPayloadMode: contextEngineProjection ? "preserve" : "elide",
    });
    const projectionDecision = contextEngineProjection
      ? resolveContextEngineBootstrapProjectionDecision({
          startupBinding: decisionStartupBinding,
          expectedBinding: buildContextEngineBinding(
            buildActiveRunAttemptParams(),
            contextEngineProjection,
          ),
          projection: contextEngineProjection,
          dynamicToolsFingerprint: codexDynamicToolsFingerprint(toolBridge.specs),
        })
      : { project: true, reason: "per-turn-projection" };
    embeddedAgentLog.info("codex app-server context-engine projection decision", {
      sessionId: params.sessionId,
      sessionKey: contextSessionKey,
      engineId: activeContextEngine.info.id,
      mode: contextEngineProjection?.mode ?? assembled.contextProjection?.mode ?? "per_turn",
      epoch: contextEngineProjection?.epoch,
      fingerprint: contextEngineProjection?.fingerprint,
      previousThreadId: decisionStartupBinding?.threadId,
      previousEpoch: decisionStartupBinding?.contextEngine?.projection?.epoch,
      previousFingerprint: decisionStartupBinding?.contextEngine?.projection?.fingerprint,
      projected: projectionDecision.project,
      reason: projectionDecision.reason,
      assembledMessages: assembled.messages.length,
      originalHistoryMessages: historyMessages.length,
      projectedPromptChars: projection.promptText.length,
      developerInstructionAdditionChars: projection.developerInstructionAddition?.length ?? 0,
    });
    activeContextEngineProjectedPromptText = projection.promptText;
    activeContextEngineProjectionApplied = projectionDecision.project;
    promptText = activeContextEngineProjectionApplied ? projection.promptText : params.prompt;
    developerInstructions = joinCodexPromptSections(
      baseDeveloperInstructions,
      projection.developerInstructionAddition,
    );
    prePromptMessageCount = projection.prePromptMessageCount;
  };
  if (activeContextEngine) {
    try {
      await applyActiveContextEngineProjection(
        !nativeToolSurfaceEnabled ? undefined : startupBinding,
      );
    } catch (assembleErr) {
      embeddedAgentLog.warn("context engine assemble failed; using Codex baseline prompt", {
        error: formatErrorMessage(assembleErr),
      });
    }
  }
  // Codex app-server threads own conversation continuity. The mirrored
  // OpenClaw transcript is persistence/search state. Context-engine output is
  // rendered into the prompt/developer instructions, not parallel history.
  const codexModelInputHistoryMessages: typeof historyMessages = [];
  const buildPromptFromCurrentInputs = () =>
    resolveAgentHarnessBeforePromptBuildResult({
      prompt: prependCurrentInboundContext(promptText, params.currentInboundContext),
      developerInstructions,
      messages: codexModelInputHistoryMessages,
      ctx: hookContext,
      ...("beforeAgentStartResult" in params
        ? { beforeAgentStartResult: params.beforeAgentStartResult }
        : {}),
    });
  const resolveShiftedPromptInputRange = (
    prompt: string,
    promptInputRange: { start: number; end: number } | undefined,
    turnPromptText: string,
  ): CodexProjectedContextRange | undefined => {
    if (
      !promptInputRange ||
      promptInputRange.start < 0 ||
      promptInputRange.end < promptInputRange.start ||
      promptInputRange.end > prompt.length ||
      !turnPromptText.endsWith(prompt)
    ) {
      return undefined;
    }
    const turnPromptOffset = turnPromptText.length - prompt.length;
    return {
      start: turnPromptOffset + promptInputRange.start,
      end: turnPromptOffset + promptInputRange.end,
    };
  };
  const resolveShiftedPromptContextRange = (
    prompt: string,
    promptInputRange: { start: number; end: number } | undefined,
    turnPromptText: string,
  ):
    | {
        contextRange: CodexProjectedContextRange;
        requestRange: CodexProjectedContextRange;
      }
    | undefined => {
    // promptInputRange ends before hook appendContext. Measure from the
    // immutable projected prompt instead of the hook-expanded prompt so that
    // the suffix remains available for bounded fitting as newer context.
    const promptTextInputOffset = promptInputRange
      ? promptInputRange.end - promptText.length
      : undefined;
    if (
      !promptContextRange ||
      !promptInputRange ||
      promptTextInputOffset === undefined ||
      promptInputRange.start < 0 ||
      promptInputRange.end < promptInputRange.start ||
      promptInputRange.end > prompt.length ||
      promptTextInputOffset < promptInputRange.start ||
      prompt.slice(promptTextInputOffset, promptInputRange.end) !== promptText ||
      !turnPromptText.endsWith(prompt)
    ) {
      return undefined;
    }
    // A hook can append the full projected prompt as newer transient context.
    // Fit that suffix so truncation retains its latest context rather than the
    // earlier input span. The exact input range still covers prepend-only hooks.
    const promptTextOffset = prompt.endsWith(promptText)
      ? prompt.length - promptText.length
      : promptTextInputOffset;
    if (promptTextOffset < 0) {
      return undefined;
    }
    const turnPromptOffset = turnPromptText.length - prompt.length + promptTextOffset;
    const contextRange = {
      start: turnPromptOffset + promptContextRange.start,
      end: turnPromptOffset + promptContextRange.end,
    };
    return {
      contextRange,
      requestRange: {
        start: contextRange.end,
        end: turnPromptOffset + promptText.length,
      },
    };
  };
  let promptBuild = await buildPromptFromCurrentInputs();
  const decorateCodexTurnPromptText = (promptBuildResult: {
    prompt: string;
    promptInputRange?: { start: number; end: number };
  }) => {
    const turnPromptText = prependCodexOpenClawPromptContext(
      promptBuildResult.prompt,
      openClawPromptContext,
      {
        preservePromptWithoutContext:
          params.bootstrapContextMode === "lightweight" &&
          params.bootstrapContextRunKind === "cron",
      },
    );
    const projectedRanges = resolveShiftedPromptContextRange(
      promptBuildResult.prompt,
      promptBuildResult.promptInputRange,
      turnPromptText,
    );
    const preservedRange =
      resolveShiftedPromptInputRange(
        promptBuildResult.prompt,
        promptBuildResult.promptInputRange,
        turnPromptText,
      ) ??
      resolveCodexDeliveryHintPreservedInputRange({
        prompt: promptBuildResult.prompt,
        promptInputRange: promptBuildResult.promptInputRange,
        decoratedPrompt: turnPromptText,
      });
    return fitCodexProjectedContextForTurnStart({
      promptText: turnPromptText,
      contextRange: projectedRanges?.contextRange,
      requestRange: projectedRanges?.requestRange,
      preservedRange,
    });
  };
  let codexTurnPromptText = decorateCodexTurnPromptText(promptBuild);
  const buildCodexTurnCollaborationDeveloperInstructions = () =>
    buildTurnCollaborationMode(params, {
      turnScopedDeveloperInstructions: workspaceBootstrapContext.turnScopedDeveloperInstructions,
      skillsCollaborationInstructions,
      memoryCollaborationInstructions: workspaceBootstrapContext.memoryCollaborationInstructions,
      heartbeatCollaborationInstructions:
        workspaceBootstrapContext.heartbeatCollaborationInstructions,
    }).settings.developer_instructions ?? undefined;
  const buildRenderedCodexDeveloperInstructions = () =>
    joinCodexPromptSections(
      promptBuild.developerInstructions,
      buildCodexTurnCollaborationDeveloperInstructions(),
    );
  const rebuildCodexPromptBuildFromCurrentProjection = async () => {
    promptBuild = await buildPromptFromCurrentInputs();
    codexTurnPromptText = decorateCodexTurnPromptText(promptBuild);
  };
  const rebuildCodexTurnPromptTextFromCurrentProjection = async () => {
    const nextPromptBuild = await buildPromptFromCurrentInputs();
    // Native Codex thread instructions are fixed once thread/start or
    // thread/resume completes; recovery continuity after that is turn input.
    promptBuild = {
      ...promptBuild,
      prompt: nextPromptBuild.prompt,
      promptInputRange: nextPromptBuild.promptInputRange,
    };
    codexTurnPromptText = decorateCodexTurnPromptText(nextPromptBuild);
  };
  const applyActiveContextEngineProjectionToFreshThread = (
    action: CodexAppServerThreadLifecycleBinding["lifecycle"]["action"],
  ) => {
    if (
      action !== "started" ||
      activeContextEngineProjectionApplied ||
      activeContextEngineProjectedPromptText === undefined
    ) {
      return false;
    }
    promptText = activeContextEngineProjectedPromptText;
    activeContextEngineProjectionApplied = true;
    return true;
  };
  const selectNewerVisibleHistoryAfterBinding = (binding: CodexAppServerThreadBinding) => {
    const historyCoveredThrough = Date.parse(binding.historyCoveredThrough ?? "");
    const cutoff = Number.isFinite(historyCoveredThrough) ? historyCoveredThrough : 0;
    return historyMessages.filter((message) => {
      if (message.role !== "user" && message.role !== "assistant") {
        return false;
      }
      const record = message as unknown as Record<string, unknown>;
      const idempotencyKey = record.idempotencyKey;
      if (typeof idempotencyKey === "string" && idempotencyKey.startsWith("codex-app-server:")) {
        return false;
      }
      const meta = record["__openclaw"];
      const mirrorIdentity =
        meta && typeof meta === "object" && !Array.isArray(meta)
          ? (meta as Record<string, unknown>).mirrorIdentity
          : undefined;
      if (typeof mirrorIdentity === "string" && mirrorIdentity.startsWith("codex-app-server:")) {
        return false;
      }
      const timestamp =
        typeof message.timestamp === "number"
          ? message.timestamp
          : typeof message.timestamp === "string"
            ? Date.parse(message.timestamp)
            : Number.NaN;
      return Number.isFinite(timestamp) && timestamp > cutoff;
    });
  };
  const applyResumeStaleBindingContinuityProjection = (binding: CodexAppServerThreadBinding) => {
    const newerVisibleMessages = selectNewerVisibleHistoryAfterBinding(binding);
    if (newerVisibleMessages.length === 0) {
      return false;
    }
    const projection = projectContextEngineAssemblyForCodex({
      assembledMessages: newerVisibleMessages,
      originalHistoryMessages: historyMessages,
      prompt: params.prompt,
      maxRenderedContextChars: codexContextProjectionMaxChars,
    });
    promptText = projection.promptText;
    promptContextRange = projection.promptContextRange;
    prePromptMessageCount = projection.prePromptMessageCount;
    return true;
  };
  const precomputeNoContextEngineStaleBindingProjection = (
    binding: CodexAppServerThreadBinding | undefined,
  ) => {
    precomputedStaleBindingContinuityProjectionApplied = false;
    if (activeContextEngine || !binding?.threadId) {
      return false;
    }
    if (isInactiveThreadBootstrapBinding(binding)) {
      inactiveThreadBootstrapBindingForcedFreshStart = true;
      return false;
    }
    const projected = applyResumeStaleBindingContinuityProjection(binding);
    precomputedStaleBindingContinuityProjectionApplied = projected;
    return projected;
  };
  const applyNoContextEngineContinuityProjection = (
    action: "started" | "resumed",
    binding?: CodexAppServerThreadBinding,
  ) => {
    if (activeContextEngine || !historyMessages.some((message) => message.role === "user")) {
      return false;
    }
    if (action === "resumed" && precomputedStaleBindingContinuityProjectionApplied) {
      return true;
    }
    if (action === "started" && inactiveThreadBootstrapBindingForcedFreshStart) {
      // A retired thread-bootstrap context engine already forced Codex onto a
      // clean native thread; without that engine active, mirrored history would
      // re-inject stale bootstrap context as a new user turn.
      return false;
    }
    if (action === "resumed" && binding) {
      return applyResumeStaleBindingContinuityProjection(binding);
    }
    if (action === "started") {
      applyFreshThreadContinuityProjection();
      return true;
    }
    return false;
  };
  if (precomputeNoContextEngineStaleBindingProjection(startupBinding)) {
    await rebuildCodexPromptBuildFromCurrentProjection();
  }
  const buildStartupTokenGuard = () => ({
    contextWindowTokens: params.contextWindowInfo?.tokens ?? params.contextTokenBudget,
    projectedTurnTokens: estimateCodexAppServerProjectedTurnTokens({
      prompt: codexTurnPromptText,
      developerInstructions: buildRenderedCodexDeveloperInstructions(),
    }),
  });
  const systemPromptReport = buildCodexSystemPromptReport({
    attempt: params,
    sessionKey: contextSessionKey,
    workspaceDir: effectiveWorkspace,
    developerInstructions: buildRenderedCodexDeveloperInstructions(),
    workspaceBootstrapContext,
    skillsPrompt: skillsCollaborationInstructions ? (params.skillsSnapshot?.prompt ?? "") : "",
    tools: toolBridge.availableSpecs,
  });
  const trajectoryRecorder = createCodexTrajectoryRecorder({
    attempt: params,
    cwd: effectiveCwd,
    developerInstructions: buildRenderedCodexDeveloperInstructions(),
    prompt: codexTurnPromptText,
    tools: toolBridge.availableSpecs,
  });
  let client: CodexAppServerClient;
  let thread: CodexAppServerThreadLifecycleBinding;
  let turnRouter: CodexAppServerTurnRouter;
  let turnRoute: CodexThreadRouteReservation | undefined;
  let routeActivated = false;
  let detachRouteAbort: () => void = () => undefined;
  let nativeSubagentMonitor: CodexNativeSubagentMonitorRegistration | undefined;
  let ownedClient: CodexAppServerClient | undefined;
  let subscribedThreadId: string | undefined;
  let trajectoryEndRecorded = false;
  const recordTrajectorySessionEnd = (data: Record<string, unknown>) => {
    trajectoryRecorder?.recordEvent("session.ended", data);
    trajectoryEndRecorded = true;
  };
  let nativeHookRelay: NativeHookRelayRegistrationHandle | undefined;
  let sharedClientLease: CodexAppServerClientLease | undefined;
  const releaseSharedClientLeaseOnce = () => {
    const lease = sharedClientLease;
    if (!lease) {
      return;
    }
    sharedClientLease = undefined;
    lease.release();
  };
  const abandonSharedClientLeaseOnce = async () => {
    const lease = sharedClientLease;
    if (!lease) {
      return;
    }
    sharedClientLease = undefined;
    await lease.abandon();
  };
  const retireSharedCodexClientForOneShotCleanup = async () => {
    if (params.cleanupBundleMcpOnRunEnd !== true) {
      return;
    }
    if (sharedCodexClientRetiredForOneShotCleanup) {
      return;
    }
    sharedCodexClientRetiredForOneShotCleanup = true;
    const retired = retireSharedCodexAppServerClientIfCurrent(client);
    embeddedAgentLog.info("codex app-server one-shot cleanup retired shared client", {
      runId: params.runId,
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
      activeLeases: retired?.activeLeases ?? null,
      closed: retired?.closed ?? false,
      matchedSharedClient: Boolean(retired),
    });
    if (retired?.closed) {
      await client.closeAndWait({ exitTimeoutMs: 2_000, forceKillDelayMs: 250 });
    }
  };
  const releaseSharedClientLeaseAndRetireOneShotClient = async () => {
    releaseSharedClientLeaseOnce();
    await retireSharedCodexClientForOneShotCleanup();
  };
  let sandboxExecEnvironmentAcquired = false;
  const releaseSandboxExecEnvironment = async () => {
    if (sandboxExecEnvironmentAcquired) {
      sandboxExecEnvironmentAcquired = false;
      await releaseCodexSandboxExecServerEnvironment(sandbox);
    }
  };
  const unsubscribeThread = async (targetClient: CodexAppServerClient, threadId: string) => {
    if (subscribedThreadId !== threadId) {
      return;
    }
    subscribedThreadId = undefined;
    const unsubscribed = await unsubscribeCodexThreadBestEffort(targetClient, {
      threadId,
      timeoutMs: CODEX_APP_SERVER_UNSUBSCRIBE_TIMEOUT_MS,
    });
    if (!unsubscribed) {
      await abandonSharedClientLeaseOnce();
    }
  };
  const unsubscribeCurrentThread = async (targetClient: CodexAppServerClient) => {
    if (subscribedThreadId) {
      await unsubscribeThread(targetClient, subscribedThreadId);
    }
  };
  const unregisterNativeMonitor = () => {
    const registration = nativeSubagentMonitor;
    nativeSubagentMonitor = undefined;
    registration?.unregister();
  };
  const releaseCurrentRoute = () => {
    detachRouteAbort();
    detachRouteAbort = () => undefined;
    turnRoute?.release();
    turnRoute = undefined;
    routeActivated = false;
    unregisterNativeMonitor();
  };
  const releaseAcquiredStartupResources = async () => {
    releaseCurrentRoute();
    nativeHookRelay?.unregister();
    if (ownedClient) {
      await unsubscribeCurrentThread(ownedClient);
    }
    await releaseSandboxExecEnvironment();
    releaseSharedClientLeaseOnce();
  };
  const registerNativeMonitor = (targetClient: CodexAppServerClient, parentThreadId: string) => {
    unregisterNativeMonitor();
    const registration = registerCodexNativeSubagentMonitor({
      client: targetClient,
      parentThreadId,
      requesterSessionKey: params.sessionKey,
      taskRuntimeScope: params.agentHarnessTaskRuntimeScope,
      agentId: sessionAgentId,
      retainClient: () => retainSharedCodexAppServerClient(targetClient),
    });
    nativeSubagentMonitor = registration;
    return registration;
  };
  let codexEnvironmentSelection: CodexTurnEnvironmentParams[] | undefined;
  let codexExecutionCwd = effectiveCwd;
  let codexSandboxPolicy: CodexSandboxPolicy | undefined;
  let restartContextEngineCodexThread:
    | (() => Promise<CodexAppServerThreadLifecycleBinding>)
    | undefined;
  let mcpElicitationDelegationRequired = false;
  const applyActiveThreadPolicy = (activeThread: CodexAppServerThreadLifecycleBinding) => {
    const reviewerContext = resolveCodexModelBackedReviewerPolicyContext({
      provider: activeThread.lifecycle.activeModelProvider ?? activeThread.modelProvider,
      model: activeThread.model,
    });
    const { resolved: activeAppServer } = resolveAppServerForReviewerContext(reviewerContext);
    pluginAppServer = mcpElicitationDelegationRequired
      ? {
          ...activeAppServer,
          approvalPolicy: withMcpElicitationsApprovalPolicy(activeAppServer.approvalPolicy),
        }
      : activeAppServer;
  };
  const startupTimeoutMs = resolveCodexStartupTimeoutMs({
    timeoutMs: params.timeoutMs,
    timeoutFloorMs: options.startupTimeoutFloorMs,
  });
  const buildNativeHookRelayFinalConfigPatch = (
    decision: { action: "resume"; binding: CodexAppServerThreadBinding } | { action: "start" },
  ) => {
    nativeHookRelay?.unregister();
    nativeHookRelay = createCodexNativeHookRelay({
      options: options.nativeHookRelay,
      generation:
        decision.action === "resume" ? decision.binding.nativeHookRelayGeneration : undefined,
      generationMismatchGraceMs:
        decision.action === "resume" && !decision.binding.nativeHookRelayGeneration
          ? CODEX_NATIVE_HOOK_RELAY_TTL_GRACE_MS
          : undefined,
      events: nativeHookRelayEvents,
      agentId: sessionAgentId,
      sessionId: params.sessionId,
      sessionKey: sandboxSessionKey,
      config: params.config,
      runId: params.runId,
      channelId: hookChannelId,
      attemptTimeoutMs: params.timeoutMs,
      startupTimeoutMs,
      turnStartTimeoutMs: params.timeoutMs,
      signal: runAbortController.signal,
    });
    return {
      configPatch: nativeHookRelay
        ? buildCodexNativeHookRelayConfig({
            relay: nativeHookRelay,
            events: nativeHookRelayEvents,
            hookTimeoutSec: options.nativeHookRelay?.hookTimeoutSec,
          })
        : options.nativeHookRelay?.enabled === false
          ? buildCodexNativeHookRelayDisabledConfig()
          : undefined,
      nativeHookRelayGeneration: nativeHookRelay?.generation,
    };
  };
  try {
    emitCodexAppServerEvent(params, {
      stream: "codex_app_server.lifecycle",
      data: { phase: "startup" },
    });
    const startupResult = await startCodexAttemptThread({
      bindingStore,
      ...(options.clientLeaseFactory ? { clientLeaseFactory: options.clientLeaseFactory } : {}),
      appServer,
      pluginConfig,
      computerUseConfig,
      startupAuthProfileId,
      startupAuthAccountCacheKey,
      startupEnvApiKeyCacheKey,
      agentDir,
      config: params.config,
      buildAttemptParams: buildActiveRunAttemptParams,
      sessionAgentId,
      effectiveWorkspace,
      effectiveCwd,
      dynamicTools: toolBridge.specs,
      persistentWebSearchAllowed,
      webSearchAllowed,
      developerInstructions: promptBuild.developerInstructions,
      buildFinalConfigPatch: buildNativeHookRelayFinalConfigPatch,
      bundleMcpThreadConfig,
      nativeToolSurfaceEnabled,
      nativeProviderWebSearchSupport,
      sandboxExecServerEnabled,
      sandbox,
      contextEngineProjection,
      expectedResumeThreadId: startupBinding?.threadId,
      startupTokenGuard: buildStartupTokenGuard(),
      startupTimeoutMs,
      signal: runAbortController.signal,
      onStartupTimeout: () => {
        runAbortController.abort("codex_startup_timeout");
      },
      onThreadReserved: (targetClient, threadId) => {
        const registration = registerNativeMonitor(targetClient, threadId);
        return () => {
          if (nativeSubagentMonitor === registration) {
            nativeSubagentMonitor = undefined;
          }
          registration.unregister();
        };
      },
    });
    client = startupResult.clientLease.client;
    ownedClient = client;
    sharedClientLease = startupResult.clientLease;
    sandboxExecEnvironmentAcquired = Boolean(startupResult.sandboxEnvironment);
    thread = startupResult.thread;
    subscribedThreadId = thread.threadId;
    turnRouter = startupResult.turnRouter;
    turnRoute = startupResult.turnRoute;
    mcpElicitationDelegationRequired = startupResult.mcpElicitationDelegationRequired;
    codexEnvironmentSelection = startupResult.environmentSelection;
    codexExecutionCwd = startupResult.executionCwd;
    codexSandboxPolicy = startupResult.sandboxPolicy;
    restartContextEngineCodexThread = startupResult.restartContextEngineCodexThread;
    // Publish every acquired resource before policy resolution. A provider
    // mismatch must still release the exact lease, sandbox, route, and subscription.
    applyActiveThreadPolicy(thread);
    emitCodexAppServerEvent(params, {
      stream: "codex_app_server.lifecycle",
      data: { phase: "thread_ready", threadId: thread.threadId },
    });
  } catch (error) {
    await releaseAcquiredStartupResources();
    params.abortSignal?.removeEventListener("abort", abortFromUpstream);
    throw error;
  }
  try {
    const promptProjectionChanged =
      applyActiveContextEngineProjectionToFreshThread(thread.lifecycle.action) ||
      applyNoContextEngineContinuityProjection(thread.lifecycle.action, thread);
    if (promptProjectionChanged) {
      await raceCodexSetupWithAbort(
        rebuildCodexTurnPromptTextFromCurrentProjection(),
        AbortSignal.any([runAbortController.signal, turnRoute.signal]),
      );
    }
  } catch (error) {
    await releaseAcquiredStartupResources();
    params.abortSignal?.removeEventListener("abort", abortFromUpstream);
    throw error;
  }
  trajectoryRecorder?.recordEvent("session.started", {
    sessionFile: params.sessionFile,
    threadId: thread.threadId,
    authProfileId: startupAuthProfileId,
    workspaceDir: effectiveWorkspace,
    toolCount: flattenCodexDynamicToolFunctions(toolBridge.specs).length,
  });
  recordCodexTrajectoryContext(trajectoryRecorder, {
    attempt: params,
    cwd: effectiveCwd,
    developerInstructions: buildRenderedCodexDeveloperInstructions(),
    prompt: codexTurnPromptText,
    tools: toolBridge.availableSpecs,
  });
  let latestStartupErrorNotification: CodexServerNotification | undefined;
  let latestNativeContextUsage = thread.nativeContextUsage;
  // Codex may omit/null the model-scoped window after compaction. Reset the
  // per-context token count without discarding the last authoritative window.
  let latestModelContextWindow = thread.modelContextWindow;
  let completed = false;
  let terminalTurnNotificationQueued = false;
  let timedOut = false;
  let turnCompletionIdleTimedOut = false;
  let turnWatchTimeoutKind: CodexAttemptTurnWatchTimeoutKind | undefined;
  let turnWatchTimeoutIdleMs: number | undefined;
  let turnWatchTimeoutMs: number | undefined;
  let turnWatchTimeoutLastActivityReason: string | undefined;
  let turnWatchTimeoutDetails: Record<string, unknown> | undefined;
  let turnCompletionIdleTimeoutMessage: string | undefined;
  let clientClosedPromptError: string | undefined;
  let clientClosedAbort = false;
  let shouldDelayNativeHookRelayUnregister = false;
  let lifecycleStarted = false;
  let lifecycleTerminalEmitted = false;
  let resolveCompletion: (() => void) | undefined;
  const completion = new Promise<void>((resolve) => {
    resolveCompletion = resolve;
  });
  const turnCompletionIdleTimeoutMs = resolveCodexTurnCompletionIdleTimeoutMs(
    options.turnCompletionIdleTimeoutMs ?? appServer.turnCompletionIdleTimeoutMs,
  );
  const turnAssistantCompletionIdleTimeoutMs = resolveCodexTurnAssistantCompletionIdleTimeoutMs(
    options.turnAssistantCompletionIdleTimeoutMs,
  );
  const postToolRawAssistantCompletionIdleTimeoutMs =
    resolveCodexPostToolRawAssistantCompletionIdleTimeoutMs(
      options.postToolRawAssistantCompletionIdleTimeoutMs ??
        appServer.postToolRawAssistantCompletionIdleTimeoutMs,
      turnAssistantCompletionIdleTimeoutMs,
    );
  const turnTerminalIdleTimeoutMs = resolveCodexTurnTerminalIdleTimeoutMs(
    options.turnTerminalIdleTimeoutMs,
  );
  const turnAttemptIdleTimeoutMs = Math.max(100, Math.floor(params.timeoutMs));
  let nativeHookRelayLastRenewedAt = 0;
  let activeAppServerTurnRequests = 0;
  const pendingOpenClawDynamicToolCompletionIds = new Set<string>();
  const activeTurnItemIds = new Set<string>();
  let turnCrossedToolHandoff = false;
  let pendingTerminalDynamicToolRelease:
    | {
        call: CodexDynamicToolCallParams;
        response: CodexDynamicToolCallResponse;
        durationMs: number;
      }
    | undefined;
  let terminalDynamicToolReleaseCheckScheduled = false;
  let currentTurnHadNonTerminalDynamicToolResult = false;
  const turnIdRef: { current?: string } = {};
  const projectorRef: { current?: CodexAppServerEventProjector } = {};
  const userInputBridgeRef: {
    current?: ReturnType<typeof createCodexUserInputBridge>;
  } = {};
  const steeringQueueRef: {
    current?: ReturnType<typeof createCodexSteeringQueue>;
  } = {};

  const renewNativeHookRelayForTurnProgress = () => {
    if (!nativeHookRelay || options.nativeHookRelay?.ttlMs !== undefined) {
      return;
    }
    const now = Date.now();
    const renewsRecently =
      now - nativeHookRelayLastRenewedAt < CODEX_NATIVE_HOOK_RELAY_RENEW_INTERVAL_MS;
    const expiresSoon = now >= nativeHookRelay.expiresAtMs - CODEX_NATIVE_HOOK_RELAY_TTL_GRACE_MS;
    if (renewsRecently && !expiresSoon) {
      return;
    }
    nativeHookRelayLastRenewedAt = now;
    nativeHookRelay.renew(
      resolveCodexNativeHookRelayTtlMs({
        explicitTtlMs: undefined,
        operationBudgetMs: turnAttemptIdleTimeoutMs + startupTimeoutMs + params.timeoutMs,
      }),
    );
  };

  const turnWatches = createCodexAttemptTurnWatchController({
    getThreadId: () => thread.threadId,
    signal: runAbortController.signal,
    getTurnId: () => turnIdRef.current,
    isCompleted: () => completed,
    isTerminalTurnNotificationQueued: () => terminalTurnNotificationQueued,
    getActiveAppServerTurnRequests: () => activeAppServerTurnRequests,
    getActiveTurnItemCount: () => activeTurnItemIds.size,
    turnCompletionIdleTimeoutMs,
    turnAssistantCompletionIdleTimeoutMs,
    turnAttemptIdleTimeoutMs,
    turnTerminalIdleTimeoutMs,
    interruptTimeoutMs: CODEX_APP_SERVER_INTERRUPT_TIMEOUT_MS,
    onInterruptTurn: (input) => interruptCodexTurnBestEffort(client, input),
    onTimeout: (timeout) => {
      timedOut = true;
      turnCompletionIdleTimedOut = true;
      turnWatchTimeoutKind = timeout.kind;
      turnWatchTimeoutIdleMs = timeout.idleMs;
      turnWatchTimeoutMs = timeout.timeoutMs;
      turnWatchTimeoutLastActivityReason = timeout.lastActivityReason;
      turnWatchTimeoutDetails = timeout.details;
      turnCompletionIdleTimeoutMessage =
        "codex app-server turn idle timed out waiting for turn/completed";
    },
    onMarkTimedOut: () => projectorRef.current?.markTimedOut(),
    onAbort: (reason) => runAbortController.abort(reason),
    onCompleted: () => {
      completed = true;
    },
    onResolveCompletion: () => resolveCompletion?.(),
    onRecordEvent: (name, fields) => trajectoryRecorder?.recordEvent(name, fields),
    onAttemptProgress: (reason) => {
      renewNativeHookRelayForTurnProgress();
      params.onRunProgress?.({
        reason,
        provider: params.provider,
        model: params.modelId,
        backend: "codex-app-server",
      });
    },
    onProgressDiagnostic: (reason) => {
      emitTrustedDiagnosticEvent({
        type: "run.progress",
        runId: params.runId,
        sessionId: params.sessionId,
        sessionKey: params.sessionKey,
        reason: `codex_app_server:${reason}`,
      });
    },
  });

  const releaseTurnAfterTerminalDynamicTool = (paramsValue: {
    call: CodexDynamicToolCallParams;
    response: CodexDynamicToolCallResponse;
    durationMs: number;
  }) => {
    if (
      !shouldReleaseTurnAfterTerminalDynamicTool({
        completed,
        aborted: runAbortController.signal.aborted,
        responseSuccess: paramsValue.response.success,
        currentTurnHadNonTerminalDynamicToolResult,
        activeAppServerTurnRequests,
        activeTurnItemIdsCount: activeTurnItemIds.size,
        pendingOpenClawDynamicToolCompletionIdsCount: pendingOpenClawDynamicToolCompletionIds.size,
      })
    ) {
      return;
    }
    pendingTerminalDynamicToolRelease = undefined;
    trajectoryRecorder?.recordEvent("turn.dynamic_tool_terminal_release", {
      threadId: paramsValue.call.threadId,
      turnId: paramsValue.call.turnId,
      toolCallId: paramsValue.call.callId,
      name: paramsValue.call.tool,
      durationMs: paramsValue.durationMs,
    });
    embeddedAgentLog.info("codex app-server turn released after terminal dynamic tool result", {
      threadId: paramsValue.call.threadId,
      turnId: paramsValue.call.turnId,
      toolCallId: paramsValue.call.callId,
      tool: paramsValue.call.tool,
      durationMs: paramsValue.durationMs,
    });
    interruptCodexTurnBestEffort(client, {
      threadId: paramsValue.call.threadId,
      turnId: paramsValue.call.turnId,
      timeoutMs: CODEX_APP_SERVER_INTERRUPT_TIMEOUT_MS,
    });
    completed = true;
    turnWatches.clearCompletionIdleTimer();
    turnWatches.clearAssistantCompletionIdleTimer();
    turnWatches.clearTerminalIdleTimer();
    resolveCompletion?.();
  };

  const scheduleTerminalDynamicToolReleaseCheck = () => {
    if (
      terminalDynamicToolReleaseCheckScheduled ||
      (!pendingTerminalDynamicToolRelease && !currentTurnHadNonTerminalDynamicToolResult)
    ) {
      return;
    }
    // Let the JSON-RPC tool-call response flush before interrupting the turn.
    terminalDynamicToolReleaseCheckScheduled = true;
    const immediate = setImmediate(() => {
      terminalDynamicToolReleaseCheckScheduled = false;
      const action = resolveTerminalDynamicToolBatchAction({
        activeAppServerTurnRequests,
        activeTurnItemIdsCount: activeTurnItemIds.size,
        pendingOpenClawDynamicToolCompletionIdsCount: pendingOpenClawDynamicToolCompletionIds.size,
        currentTurnHadNonTerminalDynamicToolResult,
        hasPendingTerminalDynamicToolRelease: pendingTerminalDynamicToolRelease !== undefined,
      });
      if (action === "release-pending-terminal" && pendingTerminalDynamicToolRelease) {
        releaseTurnAfterTerminalDynamicTool(pendingTerminalDynamicToolRelease);
      } else if (action === "clear-nonterminal-batch") {
        pendingTerminalDynamicToolRelease = undefined;
        currentTurnHadNonTerminalDynamicToolResult = false;
      }
    });
    immediate.unref?.();
  };

  const scheduleTurnReleaseAfterTerminalDynamicTool = (paramsLocal: {
    call: CodexDynamicToolCallParams;
    response: CodexDynamicToolCallResponse;
    durationMs: number;
  }) => {
    pendingTerminalDynamicToolRelease = paramsLocal;
    scheduleTerminalDynamicToolReleaseCheck();
  };

  const emitLifecycleStart = () => {
    emitCodexAppServerEvent(params, {
      stream: "lifecycle",
      data: { phase: "start", startedAt: attemptStartedAt },
    });
    lifecycleStarted = true;
  };

  const emitLifecycleTerminal = (data: Record<string, unknown> & { phase: "end" | "error" }) => {
    if (!lifecycleStarted || lifecycleTerminalEmitted) {
      return;
    }
    emitCodexAppServerEvent(params, {
      stream: "lifecycle",
      data: {
        startedAt: attemptStartedAt,
        endedAt: Date.now(),
        ...data,
        ...((params.deferTerminalLifecycle ?? params.deferTerminalLifecycleEnd)
          ? { phase: "finishing" }
          : {}),
      },
    });
    lifecycleTerminalEmitted = true;
  };

  const executionPhaseKeys = new Set<string>();
  const emitExecutionPhaseOnce = (
    key: string,
    info: Parameters<NonNullable<EmbeddedRunAttemptParams["onExecutionPhase"]>>[0],
  ) => {
    if (executionPhaseKeys.has(key)) {
      return;
    }
    executionPhaseKeys.add(key);
    params.onExecutionPhase?.({
      provider: params.provider,
      model: params.modelId,
      backend: "codex-app-server",
      ...info,
    });
  };
  const reportExecutionNotification = (notification: CodexServerNotification) => {
    reportCodexExecutionNotification({
      notification,
      emitExecutionPhaseOnce,
    });
  };

  const isTerminalTurnNotificationForTurn = (
    notification: CodexServerNotification,
    notificationTurnId: string,
  ): boolean =>
    isTerminalCodexTurnNotificationForTurn({
      notification,
      threadId: thread.threadId,
      turnId: notificationTurnId,
      currentPromptTexts: [codexTurnPromptText],
    });

  const handleNotification = async (notification: CodexServerNotification) => {
    const projector = projectorRef.current;
    const turnId = turnIdRef.current;
    const userInputBridge = userInputBridgeRef.current;
    const steeringQueue = steeringQueueRef.current;
    userInputBridge?.handleNotification(notification);
    if (!projector || !turnId) {
      return;
    }
    const notificationState = applyCodexTurnNotificationState({
      notification,
      threadId: thread.threadId,
      turnId,
      currentPromptTexts: [codexTurnPromptText],
      turnWatches,
      activeTurnItemIds,
      activeAppServerTurnRequests,
      pendingOpenClawDynamicToolCompletionIds,
      turnCrossedToolHandoff,
      postToolRawAssistantCompletionIdleTimeoutMs,
      onScheduleTerminalDynamicToolReleaseCheck: scheduleTerminalDynamicToolReleaseCheck,
      onReportExecutionNotification: reportExecutionNotification,
    });
    turnCrossedToolHandoff = notificationState.turnCrossedToolHandoff;
    // Determine terminal-turn status before invoking the projector so a throw
    // inside projector.handleNotification still releases the session lane.
    // See openclaw/openclaw#67996.
    if (notificationState.isTurnTerminal) {
      terminalTurnNotificationQueued = true;
    }
    try {
      await waitForCodexNotificationDispatchTurn();
      await projector.handleNotification(notification);
    } catch (error) {
      embeddedAgentLog.debug("codex app-server projector notification threw", {
        method: notification.method,
        error,
      });
    } finally {
      if (notificationState.isTurnTerminal) {
        if (notificationState.isTurnAbortMarker) {
          projector.markAborted();
        }
        if (!timedOut && !runAbortController.signal.aborted) {
          await steeringQueue?.flushPending();
        }
        completed = true;
        turnWatches.clearCompletionIdleTimer();
        turnWatches.clearAssistantCompletionIdleTimer();
        turnWatches.clearTerminalIdleTimer();
        resolveCompletion?.();
      }
    }
  };
  const enqueueNotification = async (
    notification: CodexServerNotification,
    scope: CodexThreadRouteScope,
  ): Promise<void> => {
    const projector = projectorRef.current;
    const turnId = turnIdRef.current;
    const userInputBridge = userInputBridgeRef.current;
    if (notification.method === "thread/tokenUsage/updated") {
      const usage = readCodexNativeContextUsage(notification);
      if (usage) {
        if (usage.modelContextWindow !== undefined) {
          latestModelContextWindow = usage.modelContextWindow;
        }
        latestNativeContextUsage = {
          currentTokens: usage.currentTokens,
        };
      }
    }
    const nativeCompactionPhase = readNativeContextCompactionPhase(notification);
    if (nativeCompactionPhase) {
      if (nativeCompactionPhase === "started") {
        latestNativeContextUsage = undefined;
      }
      try {
        await bindingStore.mutate(bindingIdentity, {
          kind: "invalidate-native-context",
          threadId: thread.threadId,
          invalidateContextEngineProjection: true,
        });
      } catch (error) {
        embeddedAgentLog.warn("failed to persist codex app-server compaction state", {
          threadId: thread.threadId,
          error,
        });
      }
    }
    embeddedAgentLog.trace("codex app-server raw notification received", {
      method: notification.method,
      ...scope,
    });
    if (!projector || !turnId) {
      userInputBridge?.handleNotification(notification);
      if (notification.method === "error") {
        latestStartupErrorNotification = notification;
      }
      return;
    }
    await handleNotification(notification);
  };

  const noteNotificationReceived = (
    notification: CodexServerNotification,
    _scope: CodexThreadRouteScope,
    receivedAtMs: number,
  ) => {
    const turnId = turnIdRef.current;
    if (!projectorRef.current || !turnId) {
      return;
    }
    if (isTerminalTurnNotificationForTurn(notification, turnId)) {
      terminalTurnNotificationQueued = true;
    }
    // Wire-receive time matters: queued projection must not trigger a false
    // idle timeout while an accepted notification waits behind earlier work.
    turnWatches.noteNotificationReceived(notification.method, { receivedAtMs });
  };

  const handleServerRequest = async (
    request: CodexAppServerServerRequest,
    scope: CodexThreadRouteScope,
  ) => {
    const turnId = turnIdRef.current;
    const userInputBridge = userInputBridgeRef.current;
    const projector = projectorRef.current;
    let armCompletionWatchOnResponse = false;
    let requestCountsAsTurnActivity = false;
    const markCurrentTurnRequestProgress = () => {
      activeAppServerTurnRequests += 1;
      turnWatches.clearCompletionIdleTimer();
      turnWatches.disarmAssistantCompletionIdleWatch();
      requestCountsAsTurnActivity = true;
      turnWatches.touchActivity(`request:${request.method}:start`, {
        attemptProgress: true,
      });
    };
    try {
      if (!turnId) {
        return undefined;
      }
      if (request.method === "mcpServer/elicitation/request") {
        if (!scope.turnId || scope.turnId === turnId) {
          armCompletionWatchOnResponse = true;
          markCurrentTurnRequestProgress();
        }
        return await handleCodexAppServerElicitationRequest({
          requestParams: request.params,
          paramsForRun: params,
          threadId: thread.threadId,
          turnId,
          pluginAppPolicyContext: thread.pluginAppPolicyContext,
          ...(computerUseConfig.enabled
            ? { computerUseMcpServerName: computerUseConfig.mcpServerName }
            : {}),
          signal: runAbortController.signal,
        });
      }
      if (request.method === "item/tool/requestUserInput") {
        if (scope.turnId === turnId) {
          armCompletionWatchOnResponse = true;
          markCurrentTurnRequestProgress();
        }
        return userInputBridge?.handleRequest({
          id: request.id,
          params: request.params,
        });
      }
      if (request.method !== "item/tool/call") {
        if (isCodexAppServerApprovalRequest(request.method)) {
          if (scope.turnId === turnId) {
            armCompletionWatchOnResponse = true;
            markCurrentTurnRequestProgress();
          }
          return handleApprovalRequest({
            method: request.method,
            params: request.params,
            paramsForRun: params,
            threadId: thread.threadId,
            turnId,
            nativeHookRelay,
            execPolicy,
            execReviewerAgentId: sessionAgentId,
            internalExecAutoReview: pluginAppServer.approvalsReviewer === "user",
            autoApprove: shouldAutoApproveCodexAppServerApprovals(pluginAppServer),
            signal: runAbortController.signal,
          });
        }
        return undefined;
      }
      const call = readCodexDynamicToolCallParams(request.params);
      if (!call || call.threadId !== thread.threadId || call.turnId !== turnId) {
        return undefined;
      }
      const toolCallOrdinal = allocateCodexToolOutcomeOrdinal?.(call.callId);
      armCompletionWatchOnResponse = true;
      markCurrentTurnRequestProgress();
      turnCrossedToolHandoff = true;
      pendingOpenClawDynamicToolCompletionIds.add(call.callId);
      trajectoryRecorder?.recordEvent("tool.call", {
        threadId: call.threadId,
        turnId: call.turnId,
        toolCallId: call.callId,
        name: call.tool,
        arguments: call.arguments,
      });
      projector?.recordDynamicToolCall({
        callId: call.callId,
        tool: call.tool,
        arguments: call.arguments,
      });
      emitExecutionPhaseOnce(`tool:${call.callId}`, {
        phase: "tool_execution_started",
        tool: call.tool,
        toolCallId: call.callId,
      });
      emitDynamicToolStartedDiagnostic({
        call,
        runId: params.runId,
        sessionId: params.sessionId,
        sessionKey: params.sessionKey,
      });
      const toolProgressDetailMode = resolveCodexToolProgressDetailMode(params.toolProgressDetail);
      const toolMeta = inferCodexDynamicToolMeta(call, toolProgressDetailMode);
      const toolArgs = sanitizeCodexToolArguments(call.arguments);
      const shouldEmitDynamicToolProgress = shouldEmitTranscriptToolProgress(call.tool, toolArgs);
      if (shouldEmitDynamicToolProgress) {
        emitCodexAppServerEvent(params, {
          stream: "tool",
          data: {
            phase: "start",
            name: call.tool,
            toolCallId: call.callId,
            ...(toolMeta ? { meta: toolMeta } : {}),
            ...(toolArgs ? { args: toolArgs } : {}),
          },
        });
      }
      const dynamicToolTimeoutMs = resolveDynamicToolCallTimeoutMs({
        call,
        config: params.config,
      });
      const toolStartedAt = Date.now();
      let terminalDiagnosticObserved = false;
      const unsubscribeToolDiagnosticObserver = onInternalDiagnosticEvent((event) => {
        if (isDynamicToolTerminalDiagnosticEvent(event)) {
          if (
            isMatchingDynamicToolTerminalDiagnostic({
              event,
              call,
              runId: params.runId,
              sessionId: params.sessionId,
              sessionKey: params.sessionKey,
            })
          ) {
            terminalDiagnosticObserved = true;
          }
        }
      });
      try {
        const response = await handleDynamicToolCallWithTimeout({
          call,
          toolBridge,
          signal: runAbortController.signal,
          timeoutMs: dynamicToolTimeoutMs,
          toolCallOrdinal,
          onAgentToolResult: params.onAgentToolResult,
          onFallbackSelected: () => {
            if (toolCallOrdinal !== undefined) {
              suppressedDynamicToolOutcomeOrdinals.add(toolCallOrdinal);
            }
          },
          onTimeout: () => {
            trajectoryRecorder?.recordEvent("tool.timeout", {
              threadId: call.threadId,
              turnId: call.turnId,
              toolCallId: call.callId,
              name: call.tool,
              timeoutMs: dynamicToolTimeoutMs,
            });
          },
        });
        const protocolResponse = toCodexDynamicToolProtocolResponse(response);
        if (!protocolResponse.success && toolCallOrdinal !== undefined) {
          // The underlying tool may ignore cancellation and finish after the
          // timeout response. Its late presentation must not replace this failure.
          suppressedDynamicToolOutcomeOrdinals.add(toolCallOrdinal);
          params.onToolOutcome?.({
            toolName: call.tool,
            argsHash: "",
            resultHash: "",
            toolCallOrdinal,
            terminalPresentation: undefined,
            presentationOnly: true,
          });
        }
        const toolDurationMs = Math.max(0, Date.now() - toolStartedAt);
        trajectoryRecorder?.recordEvent("tool.result", {
          threadId: call.threadId,
          turnId: call.turnId,
          toolCallId: call.callId,
          name: call.tool,
          success: protocolResponse.success,
          contentItems: protocolResponse.contentItems,
        });
        projector?.recordDynamicToolResult({
          callId: call.callId,
          tool: call.tool,
          asyncStarted: response.asyncStarted === true,
          success: protocolResponse.success,
          terminalType:
            response.diagnosticTerminalType ?? (protocolResponse.success ? "completed" : "error"),
          sideEffectEvidence: response.sideEffectEvidence === true,
          contentItems: protocolResponse.contentItems,
        });
        if (shouldEmitDynamicToolProgress) {
          const progressResponse = toCodexDynamicToolProgressResponse(response, protocolResponse);
          emitCodexAppServerEvent(params, {
            stream: "tool",
            data: {
              phase: "result",
              name: call.tool,
              toolCallId: call.callId,
              ...(toolMeta ? { meta: toolMeta } : {}),
              isError: !protocolResponse.success,
              result: toTranscriptToolResult(progressResponse),
            },
          });
        }
        if (
          !terminalDiagnosticObserved &&
          !hasPendingDynamicToolTerminalDiagnostic({
            call,
            runId: params.runId,
            sessionId: params.sessionId,
            sessionKey: params.sessionKey,
          })
        ) {
          emitDynamicToolTerminalDiagnostic({
            response,
            call,
            runId: params.runId,
            sessionId: params.sessionId,
            sessionKey: params.sessionKey,
            durationMs: toolDurationMs,
          });
        }
        pendingOpenClawDynamicToolCompletionIds.delete(call.callId);
        if (response.terminate === true) {
          scheduleTurnReleaseAfterTerminalDynamicTool({
            call,
            response,
            durationMs: toolDurationMs,
          });
        } else if (!shouldBlockTerminalReleaseForNonTerminalDynamicToolResult(response)) {
          scheduleTerminalDynamicToolReleaseCheck();
        } else {
          currentTurnHadNonTerminalDynamicToolResult = true;
          pendingTerminalDynamicToolRelease = undefined;
        }
        return protocolResponse as JsonValue;
      } catch (error) {
        pendingOpenClawDynamicToolCompletionIds.delete(call.callId);
        if (
          !terminalDiagnosticObserved &&
          !hasPendingDynamicToolTerminalDiagnostic({
            call,
            runId: params.runId,
            sessionId: params.sessionId,
            sessionKey: params.sessionKey,
          })
        ) {
          emitDynamicToolErrorDiagnostic({
            call,
            runId: params.runId,
            sessionId: params.sessionId,
            sessionKey: params.sessionKey,
            durationMs: Math.max(0, Date.now() - toolStartedAt),
          });
        }
        throw error;
      } finally {
        toolOutcomeOrdinals.delete(call.callId);
        unsubscribeToolDiagnosticObserver();
      }
    } finally {
      if (requestCountsAsTurnActivity) {
        activeAppServerTurnRequests = Math.max(0, activeAppServerTurnRequests - 1);
        const postToolContinuationTimeoutMs =
          request.method === "item/tool/call" && turnCrossedToolHandoff
            ? postToolRawAssistantCompletionIdleTimeoutMs
            : undefined;
        turnWatches.touchActivity(`request:${request.method}:response`, {
          arm: armCompletionWatchOnResponse,
          attemptProgress: true,
          ...(postToolContinuationTimeoutMs !== undefined
            ? { attemptTimeoutMs: postToolContinuationTimeoutMs }
            : {}),
        });
        if (armCompletionWatchOnResponse && postToolContinuationTimeoutMs !== undefined) {
          turnWatches.armCompletionIdleWatch({ timeoutMs: postToolContinuationTimeoutMs });
        }
        scheduleTerminalDynamicToolReleaseCheck();
      } else {
        turnWatches.scheduleProgressWatches();
      }
    }
  };

  const attachRouteAbort = (route: CodexThreadRouteReservation) => {
    const onAbort = () => {
      if (completed || terminalTurnNotificationQueued || runAbortController.signal.aborted) {
        return;
      }
      const reason = route.signal.reason;
      const reasonText = formatErrorMessage(reason);
      const closedClient = reasonText.includes("turn router closed");
      clientClosedPromptError = closedClient
        ? "codex app-server client closed before turn completed"
        : `codex app-server turn route closed before turn completed: ${reasonText}`;
      clientClosedAbort = closedClient;
      const activeTurnId = turnIdRef.current;
      if (activeTurnId) {
        trajectoryRecorder?.recordEvent("turn.client_closed", {
          threadId: thread.threadId,
          turnId: activeTurnId,
        });
      }
      embeddedAgentLog.warn(clientClosedPromptError, {
        threadId: thread.threadId,
        turnId: activeTurnId,
      });
      runAbortController.abort(closedClient ? "client_closed" : "turn_route_closed");
      completed = true;
      turnWatches.clearAllTimers();
      resolveCompletion?.();
    };
    route.signal.addEventListener("abort", onAbort, { once: true });
    if (route.signal.aborted) {
      onAbort();
    }
    return () => route.signal.removeEventListener("abort", onAbort);
  };
  const ensureCurrentThreadRoute = async (): Promise<CodexThreadRouteReservation> => {
    if (turnRoute?.threadId !== thread.threadId) {
      releaseCurrentRoute();
      turnRoute = turnRouter.reserveThread({
        threadId: thread.threadId,
        releaseOn: runAbortController.signal,
      });
    }
    if (!turnRoute) {
      throw new Error("codex app-server turn route was not reserved");
    }
    if (!routeActivated) {
      nativeSubagentMonitor ??= registerNativeMonitor(client, thread.threadId);
      detachRouteAbort = attachRouteAbort(turnRoute);
      await turnRoute.activate({
        onNotificationReceived: noteNotificationReceived,
        onNotification: enqueueNotification,
        onRequest: handleServerRequest,
      });
      routeActivated = true;
    }
    return turnRoute;
  };
  try {
    await ensureCurrentThreadRoute();
  } catch (error) {
    await releaseAcquiredStartupResources();
    params.abortSignal?.removeEventListener("abort", abortFromUpstream);
    throw error;
  }

  const buildLlmInputEvent = () => ({
    runId: params.runId,
    sessionId: params.sessionId,
    provider: params.provider,
    model: params.modelId,
    systemPrompt: buildRenderedCodexDeveloperInstructions(),
    prompt: codexTurnPromptText,
    historyMessages: codexModelInputHistoryMessages,
    imagesCount: params.images?.length ?? 0,
    tools,
  });
  const buildCodexModelInputMessages = () => [
    ...codexModelInputHistoryMessages,
    buildCodexUserPromptMessage({ ...params, prompt: codexTurnPromptText }),
  ];
  const codexModelCallBaseFields = {
    runId: params.runId,
    callId: codexModelCallId,
    ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
    sessionId: params.sessionId,
    provider: params.provider,
    model: params.modelId,
    api: params.model.api,
    transport: appServer.start.transport,
    ...hookContextWindowFields,
    trace: codexModelCallTrace,
  };
  const codexModelCallDiagnostics = createCodexModelCallDiagnosticEmitter({
    baseFields: codexModelCallBaseFields,
    capture: codexModelContentCapture,
    tools,
    buildInputMessages: buildCodexModelInputMessages,
    buildSystemPrompt: buildRenderedCodexDeveloperInstructions,
    onErrorDiagnostic: (error) => {
      embeddedAgentLog.debug("codex app-server model call diagnostic ended with error", {
        error: formatErrorMessage(error),
      });
    },
  });

  let turn: CodexTurnStartResponse | undefined;
  const commitAcceptedContextEngineProjection = async () => {
    if (
      !activeContextEngineProjectionApplied ||
      !contextEngineProjection ||
      thread.lifecycle.transient
    ) {
      return;
    }
    const contextEngine = buildContextEngineBinding(
      buildActiveRunAttemptParams(),
      contextEngineProjection,
    );
    if (!contextEngine) {
      return;
    }
    const committed = await bindingStore.mutate(bindingIdentity, {
      kind: "patch",
      threadId: thread.threadId,
      patch: { contextEngine },
    });
    if (!committed) {
      throw new Error(
        `Codex thread binding changed before context projection commit: ${thread.threadId}`,
      );
    }
    thread = { ...thread, contextEngine };
  };
  const throwIfTurnStartAcceptedAfterAbort = () => {
    if (!runAbortController.signal.aborted) {
      return;
    }
    const reason = runAbortController.signal.reason;
    if (reason instanceof Error) {
      throw reason;
    }
    const error = new Error(
      typeof reason === "string" && reason.length > 0
        ? reason
        : "codex app-server turn start aborted before acceptance",
    );
    error.name = "AbortError";
    throw error;
  };
  let rateLimitsRevisionBeforeLastTurnStart: number | undefined;
  const invalidateThreadNativeContextUsage = async (): Promise<void> => {
    // A usage snapshot is authoritative only between terminal turns. Absence
    // deliberately skips the startup fuse until a later turn reports fresh usage.
    if (!thread.lifecycle.transient) {
      const invalidatedUsage = await bindingStore.mutate(bindingIdentity, {
        kind: "patch",
        threadId: thread.threadId,
        patch: {
          nativeContextUsage: undefined,
        },
      });
      if (!invalidatedUsage) {
        throw new Error(
          `Codex thread binding changed before native usage invalidation: ${thread.threadId}`,
        );
      }
    }
    latestNativeContextUsage = undefined;
    thread = {
      ...thread,
      nativeContextUsage: undefined,
    };
  };
  const startCodexTurn = async (): Promise<CodexTurnStartResponse> => {
    const activeTurnRoute = await ensureCurrentThreadRoute();
    const clientLease = sharedClientLease;
    if (!clientLease) {
      throw new Error("Codex app-server turn started without a client lease");
    }
    let acceptedTurnId: string | undefined;
    const turnStartParams = buildTurnStartParams(params, {
      threadId: thread.threadId,
      cwd: codexExecutionCwd,
      appServer: pluginAppServer,
      promptText: codexTurnPromptText,
      sandboxPolicy: codexSandboxPolicy,
      environmentSelection: codexEnvironmentSelection,
      model: thread.model,
      modelProvider: thread.modelProvider,
      turnScopedDeveloperInstructions: workspaceBootstrapContext.turnScopedDeveloperInstructions,
      skillsCollaborationInstructions,
      memoryCollaborationInstructions: workspaceBootstrapContext.memoryCollaborationInstructions,
      heartbeatCollaborationInstructions:
        workspaceBootstrapContext.heartbeatCollaborationInstructions,
    });
    await invalidateThreadNativeContextUsage();
    codexModelCallDiagnostics.setRequestPayloadBytes(utf8JsonByteLength(turnStartParams));
    // Before this point, requests from a resumed native turn flow through and
    // fail closed. Arm only when Codex may issue requests for our new turn.
    // Keep turn/start diagnostics scoped to this attempt. Resumed native work
    // can emit unrelated errors before the new turn is armed.
    latestStartupErrorNotification = undefined;
    rateLimitsRevisionBeforeLastTurnStart = readCodexRateLimitsRevision(client);
    activeTurnRoute.armTurn();
    try {
      const startedTurn = await runCodexTurnStartWithLease(clientLease, async () =>
        assertCodexTurnStartResponse(
          await client.request("turn/start", turnStartParams, {
            timeoutMs: params.timeoutMs,
            signal: runAbortController.signal,
          }),
        ),
      );
      acceptedTurnId = startedTurn.turn.id;
      turnIdRef.current = acceptedTurnId;
      throwIfTurnStartAcceptedAfterAbort();
      // Prefer a duplicate projection after a crash over recording context that
      // turn/start never accepted. This is the commit point for the marker.
      await commitAcceptedContextEngineProjection();
      emitExecutionPhaseOnce("turn_accepted", { phase: "turn_accepted" });
      emitCodexAppServerEvent(params, {
        stream: "codex_app_server.lifecycle",
        data: {
          phase: "turn_accepted",
          threadId: thread.threadId,
          turnId: acceptedTurnId,
        },
      });
      userInputBridgeRef.current = createCodexUserInputBridge({
        paramsForRun: params,
        threadId: thread.threadId,
        turnId: acceptedTurnId,
        signal: runAbortController.signal,
      });
      trajectoryRecorder?.recordEvent("prompt.submitted", {
        threadId: thread.threadId,
        turnId: acceptedTurnId,
        prompt: codexTurnPromptText,
        imagesCount: params.images?.length ?? 0,
      });
      projectorRef.current = new CodexAppServerEventProjector(
        params,
        thread.threadId,
        acceptedTurnId,
        {
          nativePostToolUseRelayEnabled:
            nativeHookRelay?.allowedEvents.includes("post_tool_use") === true &&
            nativeHookRelay.shouldRelayEvent("post_tool_use"),
          readRecentRateLimits: () => readRecentCodexRateLimits(client),
          trajectoryRecorder,
        },
      );
      turnWatches.armTerminalIdleWatch();
      turnWatches.touchActivity("turn:start", { arm: true });
      turnWatches.armAttemptIdleWatch();
      turnWatches.touchActivity("turn:start", { attemptProgress: true });
      // Codex can request tools before turn/start returns. Publish the full turn
      // context first, then release those requests from the router.
      try {
        await activeTurnRoute.bindTurn(acceptedTurnId);
      } catch (error) {
        if (!terminalTurnNotificationQueued) {
          throw error;
        }
        await activeTurnRoute.drain();
        if (!completed) {
          turnWatches.clearAllTimers();
          throw error;
        }
      }
      return startedTurn;
    } catch (error) {
      userInputBridgeRef.current?.cancelPending();
      userInputBridgeRef.current = undefined;
      projectorRef.current = undefined;
      turnIdRef.current = undefined;
      if (acceptedTurnId) {
        try {
          // Codex answers turn/interrupt only after TurnAborted. Keep the route
          // and lease until that terminal state is confirmed; otherwise retire
          // the process so an active turn can never return to the shared pool.
          await client.request(
            "turn/interrupt",
            { threadId: thread.threadId, turnId: acceptedTurnId },
            { timeoutMs: CODEX_APP_SERVER_INTERRUPT_TIMEOUT_MS },
          );
        } catch (interruptError) {
          embeddedAgentLog.warn(
            "codex app-server accepted turn interruption was not confirmed; retiring client",
            {
              threadId: thread.threadId,
              turnId: acceptedTurnId,
              error: interruptError,
            },
          );
          subscribedThreadId = undefined;
          try {
            await abandonSharedClientLeaseOnce();
          } catch (abandonError) {
            embeddedAgentLog.warn(
              "codex app-server client retirement failed after unconfirmed interruption",
              {
                threadId: thread.threadId,
                turnId: acceptedTurnId,
                error: abandonError,
              },
            );
          }
        }
        // An accepted turn owns every buffered request. Drop its route only
        // after termination is confirmed or the physical client is retired.
        releaseCurrentRoute();
      } else {
        await activeTurnRoute.cancelTurn();
      }
      throw error;
    }
  };
  const waitForActiveNativeTurnCompletion = async (): Promise<boolean> => {
    const route = turnRoute;
    if (!route) {
      return false;
    }
    return await route.waitForTurnCompletion({
      timeoutMs: Math.min(appServer.requestTimeoutMs, CODEX_APP_SERVER_NATIVE_TURN_WAIT_TIMEOUT_MS),
      signal: runAbortController.signal,
    });
  };
  const resumedWithActiveNativeTurn =
    thread.lifecycle.action === "resumed" && thread.lifecycle.hasActiveTurn === true;
  if (resumedWithActiveNativeTurn) {
    // A resumed Codex thread can already be running a native compact/review turn.
    // Starting an OpenClaw turn before that native turn completes can wedge the
    // accepted turn behind a completion event we intentionally ignore.
    embeddedAgentLog.info(
      "codex app-server resumed thread has active native turn; waiting before turn/start",
      { threadId: thread.threadId },
    );
    emitCodexAppServerEvent(params, {
      stream: "codex_app_server.lifecycle",
      data: {
        phase: "turn_start_waiting_for_native_turn",
        threadId: thread.threadId,
      },
    });
    await invalidateThreadNativeContextUsage();
    const nativeTurnCompleted = await waitForActiveNativeTurnCompletion();
    if (nativeTurnCompleted) {
      await turnRoute?.drain();
    }
    if (!nativeTurnCompleted && !runAbortController.signal.aborted) {
      embeddedAgentLog.warn(
        "codex app-server active native turn did not complete before turn/start wait timed out",
        { threadId: thread.threadId },
      );
    }
  }
  try {
    codexModelCallDiagnostics.emitStarted();
    runAgentHarnessLlmInputHook({
      event: buildLlmInputEvent(),
      ctx: hookContext,
      hookRunner,
    });
    emitCodexAppServerEvent(params, {
      stream: "codex_app_server.lifecycle",
      data: { phase: "turn_starting", threadId: thread.threadId },
    });
    turn = await runCodexTurnStartWithNativeTurnRetry({
      startTurn: startCodexTurn,
      waitForActiveTurnCompletion: waitForActiveNativeTurnCompletion,
      afterActiveTurnCompletion: async () => await turnRoute?.drain(),
      onRetry: () => {
        embeddedAgentLog.info(
          "codex app-server turn/start raced active native work; waiting before one retry",
          { threadId: thread.threadId },
        );
      },
    });
  } catch (error) {
    let turnStartError = error;
    if (
      turn === undefined &&
      shouldUseFreshCodexThreadAfterContextEngineOverflow({
        error: turnStartError,
        contextEngineActive: Boolean(activeContextEngine),
        thread,
      }) &&
      restartContextEngineCodexThread
    ) {
      // Do not try to pre-compact or summarize through OpenClaw here. Codex owns
      // automatic compaction; OpenClaw may only discard a stale projection thread
      // and let Codex start cleanly.
      embeddedAgentLog.warn(
        "codex app-server context-engine turn overflowed on resume; retrying with fresh thread",
        {
          threadId: thread.threadId,
          error: formatErrorMessage(turnStartError),
        },
      );
      try {
        const clearedBinding = await bindingStore.mutate(bindingIdentity, {
          kind: "clear",
          threadId: thread.threadId,
        });
        if (!clearedBinding) {
          embeddedAgentLog.warn(
            "codex app-server preserved newer context-engine binding after resume overflow; skipping fresh retry",
            {
              threadId: thread.threadId,
              error: formatErrorMessage(turnStartError),
            },
          );
        } else {
          const replacedThreadId = thread.threadId;
          releaseCurrentRoute();
          await unsubscribeThread(client, replacedThreadId);
          const previousModel = thread.model;
          const restartedThread = await restartContextEngineCodexThread();
          thread = restartedThread;
          subscribedThreadId = restartedThread.threadId;
          // The fresh subscription is cleanup-owned before policy resolution,
          // which may reject the authoritative provider returned by Codex.
          applyActiveThreadPolicy(thread);
          latestNativeContextUsage = thread.nativeContextUsage;
          const restartedModelContextWindow = thread.modelContextWindow;
          latestModelContextWindow =
            thread.model === previousModel
              ? (restartedModelContextWindow ?? latestModelContextWindow)
              : restartedModelContextWindow;
          if (applyActiveContextEngineProjectionToFreshThread(thread.lifecycle.action)) {
            await rebuildCodexTurnPromptTextFromCurrentProjection();
          }
          emitCodexAppServerEvent(params, {
            stream: "codex_app_server.lifecycle",
            data: { phase: "thread_ready_retry", threadId: thread.threadId },
          });
          try {
            turn = await startCodexTurn();
          } catch (retryError) {
            turnStartError = retryError;
          }
        }
      } catch (retrySetupError) {
        turnStartError = retrySetupError;
      }
    }
    if (turn === undefined) {
      const usageLimitError = await formatCodexTurnStartUsageLimitError({
        client,
        error: turnStartError,
        errorNotification: latestStartupErrorNotification,
        rateLimitsRevisionBeforeTurnStart: rateLimitsRevisionBeforeLastTurnStart,
        timeoutMs: appServer.requestTimeoutMs,
        signal: runAbortController.signal,
      });
      const turnStartErrorMessage = usageLimitError?.message ?? formatErrorMessage(turnStartError);
      if (isInvalidCodexImagePayloadError(turnStartErrorMessage)) {
        await clearCodexBindingAfterInvalidImagePayload(bindingStore, bindingIdentity, {
          phase: "turn_start",
          threadId: thread.threadId,
          error: turnStartErrorMessage,
        });
      }
      emitCodexAppServerEvent(params, {
        stream: "codex_app_server.lifecycle",
        data: { phase: "turn_start_failed", error: turnStartErrorMessage },
      });
      recordTrajectorySessionEnd({
        status: "error",
        threadId: thread.threadId,
        timedOut,
        aborted: runAbortController.signal.aborted,
        promptError: turnStartErrorMessage,
      });
      runAgentHarnessLlmOutputHook({
        event: {
          runId: params.runId,
          sessionId: params.sessionId,
          provider: params.provider,
          model: params.modelId,
          ...hookContextWindowFields,
          resolvedRef:
            params.runtimePlan?.observability.resolvedRef ?? `${params.provider}/${params.modelId}`,
          ...(params.runtimePlan?.observability.harnessId
            ? { harnessId: params.runtimePlan.observability.harnessId }
            : {}),
          assistantTexts: [],
        },
        ctx: hookContext,
        hookRunner,
      });
      const turnStartFailureKind = classifyCodexModelCallFailureKind({
        error: turnStartError,
        timedOut,
        turnCompletionIdleTimedOut,
        runAborted: runAbortController.signal.aborted,
        abortReason: runAbortController.signal.reason,
        clientClosedAbort,
        formatError: formatErrorMessage,
      });
      codexModelCallDiagnostics.emitError(
        turnStartErrorMessage,
        turnStartFailureKind ? { failureKind: turnStartFailureKind } : {},
      );
      const turnStartFailureMessages = [
        ...historyMessages,
        buildCodexUserPromptMessage({ ...params, prompt: codexTurnPromptText }),
      ];
      await runCodexAgentEndHook(params, {
        event: {
          messages: turnStartFailureMessages,
          success: false,
          error: turnStartErrorMessage,
          durationMs: Date.now() - attemptStartedAt,
        },
        ctx: hookContext,
        hookRunner,
      });
      if (!timedOut) {
        await unsubscribeCurrentThread(client);
      }
      releaseCurrentRoute();
      nativeHookRelay?.unregister();
      await releaseSandboxExecEnvironment();
      await runAgentCleanupStep({
        runId: params.runId,
        sessionId: params.sessionId,
        step: "codex-trajectory-flush-startup-failure",
        log: embeddedAgentLog,
        cleanup: async () => {
          await trajectoryRecorder?.flush();
        },
      });
      params.abortSignal?.removeEventListener("abort", abortFromUpstream);
      await releaseSharedClientLeaseAndRetireOneShotClient();
      if (usageLimitError) {
        await markCodexAuthProfileBlockedFromRateLimits({
          params,
          authProfileId: startupAuthProfileId,
          rateLimits: usageLimitError.rateLimitsForProfile,
        });
        return {
          ...buildCodexTurnStartFailureResult({
            params,
            message: usageLimitError.message,
            messagesSnapshot: turnStartFailureMessages,
            systemPromptReport,
          }),
        };
      }
      throw turnStartError;
    }
  }
  const activeTurnId = turn.turn.id;
  if (isTerminalTurnStatus(turn.turn.status)) {
    terminalTurnNotificationQueued = true;
  }
  emitLifecycleStart();
  const activeProjector = projectorRef.current;
  if (!activeProjector) {
    throw new Error("codex app-server projector was not initialized");
  }
  if (!completed && isTerminalTurnStatus(turn.turn.status)) {
    await enqueueNotification(
      {
        method: "turn/completed",
        params: {
          threadId: thread.threadId,
          turnId: activeTurnId,
          turn: turn.turn as unknown as JsonObject,
        },
      },
      { threadId: thread.threadId, turnId: activeTurnId },
    );
  }

  const activeSteeringQueue = createCodexSteeringQueue({
    client,
    threadId: thread.threadId,
    turnId: activeTurnId,
    answerPendingUserInput: (text) =>
      userInputBridgeRef.current?.handleQueuedMessage(text) ?? false,
    signal: runAbortController.signal,
  });
  steeringQueueRef.current = activeSteeringQueue;
  const handle = {
    kind: "embedded" as const,
    queueMessage: async (text: string, optionsLocal?: CodexSteeringQueueOptions) =>
      activeSteeringQueue.queue(text, optionsLocal),
    isStreaming: () => !completed && !runAbortController.signal.aborted,
    isCompacting: () => projectorRef.current?.isCompacting() ?? false,
    sourceReplyDeliveryMode: params.sourceReplyDeliveryMode,
    cancel: () => runAbortController.abort("cancelled"),
    abort: () => runAbortController.abort("aborted"),
  };
  setActiveEmbeddedRun(params.sessionId, handle, params.sessionKey);
  const notifyUserMessagePersisted = createCodexAppServerUserMessagePersistenceNotifier(params);
  void mirrorPromptAtTurnStartBestEffort({
    params,
    agentId: sessionAgentId,
    notifyUserMessagePersisted,
    sessionKey: sandboxSessionKey,
    cwd: effectiveCwd,
    threadId: thread.threadId,
    turnId: activeTurnId,
  });

  const abortListener = () => {
    const shouldRetireClient = timedOut;
    if (shouldRetireClient) {
      void (async () => {
        // Timed-out native turns cannot be safely resumed on the same thread.
        try {
          await bindingStore.mutate(bindingIdentity, {
            kind: "clear",
            threadId: thread.threadId,
          });
        } catch (error) {
          // Store cleanup must not prevent retiring a client with ambiguous turn state.
          embeddedAgentLog.warn("failed to clear timed-out codex app-server binding", {
            threadId: thread.threadId,
            error,
          });
        }
        await retireCodexAppServerClientAfterTimedOutTurn(client, {
          threadId: thread.threadId,
          turnId: activeTurnId,
          reason: String(runAbortController.signal.reason ?? "timeout"),
          abandonClientLease: abandonSharedClientLeaseOnce,
        });
      })()
        .catch((error: unknown) => {
          embeddedAgentLog.warn("codex app-server timed-out turn retirement failed", {
            threadId: thread.threadId,
            turnId: activeTurnId,
            error,
          });
        })
        .finally(() => {
          resolveCompletion?.();
        });
      return;
    }
    interruptCodexTurnBestEffort(client, {
      threadId: thread.threadId,
      turnId: activeTurnId,
    });
    resolveCompletion?.();
  };
  runAbortController.signal.addEventListener("abort", abortListener, { once: true });
  if (runAbortController.signal.aborted) {
    abortListener();
  }

  try {
    await completion;
    // Timeout completion can win while a received notification is still being
    // projected, for example while persisting raw image-generation media. Wait
    // for already-queued projection work so the final result includes artifacts
    // from the notification that triggered the idle watchdog.
    await turnRoute?.drain();
    const result = activeProjector.buildResult(toolBridge.telemetry, { yieldDetected });
    const finalAborted =
      result.aborted || (runAbortController.signal.aborted && !clientClosedAbort);
    const canUseCompletedAssistantTextAfterClientClose =
      activeProjector.hasCompletedTerminalAssistantText() &&
      activeAppServerTurnRequests === 0 &&
      activeTurnItemIds.size === 0 &&
      pendingOpenClawDynamicToolCompletionIds.size === 0;
    const clientClosedPromptErrorForFinal =
      clientClosedPromptError && canUseCompletedAssistantTextAfterClientClose
        ? undefined
        : clientClosedPromptError;
    let finalPromptError =
      clientClosedPromptErrorForFinal ??
      (turnCompletionIdleTimedOut
        ? turnCompletionIdleTimeoutMessage
        : timedOut
          ? "codex app-server attempt timed out"
          : result.promptError);
    const finalPromptErrorMessage =
      typeof finalPromptError === "string"
        ? finalPromptError
        : finalPromptError
          ? formatErrorMessage(finalPromptError)
          : undefined;
    if (isInvalidCodexImagePayloadError(finalPromptErrorMessage)) {
      await clearCodexBindingAfterInvalidImagePayload(bindingStore, bindingIdentity, {
        phase: "turn_completed",
        threadId: thread.threadId,
        turnId: activeTurnId,
        error: finalPromptErrorMessage,
      });
    }
    if (
      shouldUseFreshCodexThreadAfterContextEngineOverflow({
        error: finalPromptError,
        contextEngineActive: Boolean(activeContextEngine),
        thread,
      })
    ) {
      embeddedAgentLog.warn(
        "codex app-server context-engine turn overflowed after resume; clearing thread binding for recovery",
        {
          threadId: thread.threadId,
          turnId: activeTurnId,
          error: finalPromptErrorMessage,
        },
      );
      await bindingStore.mutate(bindingIdentity, {
        kind: "clear",
        threadId: thread.threadId,
      });
    }
    const refreshedUsageLimitPromptError = await refreshCodexUsageLimitPromptError({
      client,
      message: finalPromptErrorMessage,
      timeoutMs: appServer.requestTimeoutMs,
      signal: runAbortController.signal,
    });
    if (refreshedUsageLimitPromptError) {
      finalPromptError = refreshedUsageLimitPromptError;
    }
    const finalPromptErrorSource =
      timedOut || clientClosedPromptErrorForFinal ? "prompt" : result.promptErrorSource;
    const codexAppServerFailureKind = clientClosedPromptErrorForFinal
      ? "client_closed_before_turn_completed"
      : turnCompletionIdleTimedOut
        ? "turn_completion_idle_timeout"
        : undefined;
    const codexAppServerReplayBlockedReason = codexAppServerFailureKind
      ? resolveCodexAppServerReplayBlockedReason(result)
      : undefined;
    const promptTimeoutOutcome = buildCodexAppServerPromptTimeoutOutcome({
      result,
      turnCompletionIdleTimedOut,
      turnWatchTimeoutKind,
    });
    const codexAppServerFailureDiagnostics =
      codexAppServerFailureKind === "turn_completion_idle_timeout" &&
      turnWatchTimeoutKind === "completion"
        ? buildCodexAppServerTimeoutDiagnostics({
            idleMs: turnWatchTimeoutIdleMs,
            timeoutMs: turnWatchTimeoutMs,
            lastActivityReason: turnWatchTimeoutLastActivityReason,
            details: turnWatchTimeoutDetails,
          })
        : undefined;
    const modelCallFailureKind =
      classifyCodexModelCallFailureKind({
        error: finalPromptError,
        timedOut,
        turnCompletionIdleTimedOut,
        runAborted: runAbortController.signal.aborted,
        abortReason: runAbortController.signal.reason,
        clientClosedAbort,
        formatError: formatErrorMessage,
      }) ?? (finalAborted ? "aborted" : undefined);
    if (modelCallFailureKind) {
      codexModelCallDiagnostics.emitError(
        finalPromptError ?? "codex app-server attempt interrupted",
        {
          failureKind: modelCallFailureKind,
        },
      );
    } else if (finalPromptError) {
      codexModelCallDiagnostics.emitError(finalPromptError);
    } else {
      codexModelCallDiagnostics.emitCompleted(result);
    }
    recordCodexTrajectoryCompletion(trajectoryRecorder, {
      attempt: params,
      result,
      threadId: thread.threadId,
      turnId: activeTurnId,
      timedOut,
      yieldDetected,
    });
    recordTrajectorySessionEnd({
      status: finalPromptError ? "error" : finalAborted || timedOut ? "interrupted" : "success",
      threadId: thread.threadId,
      turnId: activeTurnId,
      timedOut,
      yieldDetected,
      promptError: normalizeCodexTrajectoryError(finalPromptError),
    });
    await mirrorTranscriptBestEffort({
      params,
      agentId: sessionAgentId,
      notifyUserMessagePersisted,
      result,
      sessionKey: contextSessionKey,
      cwd: effectiveCwd,
      threadId: thread.threadId,
      turnId: activeTurnId,
    });
    const terminalAssistantText = collectTerminalAssistantText(result);
    if (terminalAssistantText && !finalAborted && !finalPromptError) {
      emitCodexAppServerEvent(params, {
        stream: "assistant",
        data: { text: terminalAssistantText },
      });
    }
    if (finalPromptError) {
      emitLifecycleTerminal({
        phase: "error",
        error: formatErrorMessage(finalPromptError),
      });
    } else {
      emitLifecycleTerminal({
        phase: "end",
        ...(finalAborted ? { aborted: true } : {}),
      });
    }
    if (activeContextEngine) {
      const activeContextEnginePluginIdLocal =
        resolveContextEngineOwnerPluginId(activeContextEngine);
      const finalMessages =
        (await readMirroredSessionHistoryMessages(activeSessionFile)) ??
        historyMessages.concat(result.messagesSnapshot);
      await finalizeHarnessContextEngineTurn({
        contextEngine: activeContextEngine,
        promptError: Boolean(finalPromptError),
        aborted: finalAborted,
        yieldAborted: Boolean(result.yieldDetected),
        sessionIdUsed: activeSessionId,
        sessionKey: contextSessionKey,
        sessionFile: activeSessionFile,
        messagesSnapshot: finalMessages,
        prePromptMessageCount,
        tokenBudget: params.contextTokenBudget,
        runtimeContext: buildHarnessContextEngineRuntimeContextFromUsage({
          attempt: buildActiveRunAttemptParams(),
          workspaceDir: effectiveWorkspace,
          cwd: effectiveCwd,
          agentDir,
          activeAgentId: sessionAgentId,
          contextEnginePluginId: activeContextEnginePluginIdLocal,
          tokenBudget: params.contextTokenBudget,
          lastCallUsage: result.attemptUsage,
          promptCache: result.promptCache,
        }),
        contextEngineHostSupport: CODEX_APP_SERVER_CONTEXT_ENGINE_HOST,
        providerId: params.provider,
        requestedModelId: params.requestedModelId,
        modelId: params.modelId,
        fallbackReason: params.fallbackReason,
        degradedReason: params.degradedReason,
        runMaintenance: runHarnessContextEngineMaintenance,
        config: params.config,
        warn: (message) => embeddedAgentLog.warn(message),
        isHeartbeat: params.bootstrapContextRunKind === "heartbeat",
      });
    }
    runAgentHarnessLlmOutputHook({
      event: {
        runId: params.runId,
        sessionId: params.sessionId,
        provider: params.provider,
        model: params.modelId,
        ...hookContextWindowFields,
        resolvedRef:
          params.runtimePlan?.observability.resolvedRef ?? `${params.provider}/${params.modelId}`,
        ...(params.runtimePlan?.observability.harnessId
          ? { harnessId: params.runtimePlan.observability.harnessId }
          : {}),
        assistantTexts: result.assistantTexts,
        ...(result.lastAssistant ? { lastAssistant: result.lastAssistant } : {}),
        ...(result.attemptUsage ? { usage: result.attemptUsage } : {}),
      },
      ctx: hookContext,
      hookRunner,
    });
    await runCodexAgentEndHook(params, {
      event: {
        messages: result.messagesSnapshot,
        success: !finalAborted && !finalPromptError,
        ...(finalPromptError ? { error: formatErrorMessage(finalPromptError) } : {}),
        durationMs: Date.now() - attemptStartedAt,
      },
      ctx: hookContext,
      hookRunner,
    });
    const completedTurnStatus = activeProjector.getCompletedTurnStatus();
    shouldDelayNativeHookRelayUnregister =
      completedTurnStatus === "completed" &&
      !timedOut &&
      !runAbortController.signal.aborted &&
      !finalAborted &&
      !finalPromptError;
    if (!thread.lifecycle.transient && completedTurnStatus !== undefined) {
      await patchCodexAppServerBindingAfterTurn({
        bindingIdentity,
        bindingStore,
        threadId: thread.threadId,
        coverHistory: shouldDelayNativeHookRelayUnregister,
        nativeContextUsage: latestNativeContextUsage,
        modelContextWindow: latestModelContextWindow,
      });
    }
    return {
      ...result,
      timedOut,
      aborted: finalAborted,
      promptError: finalPromptError,
      promptErrorSource: finalPromptErrorSource,
      ...(codexAppServerFailureKind
        ? {
            codexAppServerFailure: {
              kind: codexAppServerFailureKind,
              ...(codexAppServerFailureKind === "turn_completion_idle_timeout" &&
              turnWatchTimeoutKind
                ? { turnWatchTimeoutKind }
                : {}),
              transport: appServer.start.transport,
              threadId: thread.threadId,
              turnId: activeTurnId,
              replaySafe: codexAppServerReplayBlockedReason === undefined,
              ...(codexAppServerReplayBlockedReason
                ? { replayBlockedReason: codexAppServerReplayBlockedReason }
                : {}),
              ...(codexAppServerFailureDiagnostics
                ? { diagnostics: codexAppServerFailureDiagnostics }
                : {}),
            },
          }
        : {}),
      ...(promptTimeoutOutcome ? { promptTimeoutOutcome } : {}),
      systemPromptReport,
    };
  } finally {
    codexModelCallDiagnostics.emitError(
      "codex app-server run completed without model-call terminal event",
    );
    emitLifecycleTerminal({
      phase: "error",
      error: "codex app-server run completed without lifecycle terminal event",
    });
    if (trajectoryRecorder && !trajectoryEndRecorded) {
      trajectoryRecorder.recordEvent("session.ended", {
        status:
          timedOut || (runAbortController.signal.aborted && !clientClosedAbort)
            ? "interrupted"
            : "cleanup",
        threadId: thread.threadId,
        turnId: activeTurnId,
        timedOut,
        aborted: runAbortController.signal.aborted && !clientClosedAbort,
      });
    }
    await runAgentCleanupStep({
      runId: params.runId,
      sessionId: params.sessionId,
      step: "codex-trajectory-flush",
      log: embeddedAgentLog,
      cleanup: async () => {
        await trajectoryRecorder?.flush();
      },
    });
    if (!timedOut && !runAbortController.signal.aborted) {
      await steeringQueueRef.current?.flushPending();
    }
    if (!timedOut) {
      await unsubscribeCurrentThread(client);
    }
    userInputBridgeRef.current?.cancelPending();
    turnWatches.clearAllTimers();
    releaseCurrentRoute();
    releaseSharedClientLeaseOnce();
    if (nativeHookRelay) {
      if (shouldDelayNativeHookRelayUnregister) {
        // Codex hook subprocesses can outlive a completed app-server turn by a
        // few seconds. Keep the relay available briefly so late
        // nativeHook.invoke RPCs can still reach before_tool_call enforcement.
        scheduleCodexNativeHookRelayUnregister({
          relay: nativeHookRelay,
          hookTimeoutSec: options.nativeHookRelay?.hookTimeoutSec,
        });
      } else {
        nativeHookRelay.unregister();
      }
    }
    await releaseSandboxExecEnvironment();
    runAbortController.signal.removeEventListener("abort", abortListener);
    params.abortSignal?.removeEventListener("abort", abortFromUpstream);
    steeringQueueRef.current?.cancel();
    clearActiveEmbeddedRun(params.sessionId, handle, params.sessionKey);
  }
}

async function clearCodexBindingAfterInvalidImagePayload(
  bindingStore: CodexAppServerBindingStore,
  bindingIdentity: CodexAppServerBindingIdentity,
  fields: { phase: string; threadId?: string; turnId?: string; error?: string },
): Promise<void> {
  const currentBinding = await bindingStore.read(bindingIdentity);
  const expectedThreadId = fields.threadId ?? currentBinding?.threadId;
  if (!expectedThreadId) {
    return;
  }
  if (currentBinding && currentBinding.threadId !== expectedThreadId) {
    embeddedAgentLog.warn(
      "codex app-server image payload error detected for unbound thread; preserving thread binding",
      { ...fields, boundThreadId: currentBinding.threadId },
    );
    return;
  }
  embeddedAgentLog.warn(
    "codex app-server image payload error detected; clearing thread binding",
    fields,
  );
  await bindingStore.mutate(bindingIdentity, { kind: "clear", threadId: expectedThreadId });
}

async function patchCodexAppServerBindingAfterTurn(params: {
  bindingIdentity: CodexAppServerBindingIdentity;
  bindingStore: CodexAppServerBindingStore;
  threadId: string;
  coverHistory: boolean;
  nativeContextUsage?: CodexAppServerThreadBinding["nativeContextUsage"];
  modelContextWindow?: number;
}): Promise<void> {
  await params.bindingStore.mutate(params.bindingIdentity, {
    kind: "patch",
    threadId: params.threadId,
    patch: {
      ...(params.coverHistory ? { historyCoveredThrough: new Date().toISOString() } : {}),
      nativeContextUsage: params.nativeContextUsage,
      ...(params.nativeContextUsage && params.modelContextWindow !== undefined
        ? { modelContextWindow: params.modelContextWindow }
        : {}),
    },
  });
}

function readNativeContextCompactionPhase(
  notification: CodexServerNotification,
): "started" | "completed" | undefined {
  const phase =
    notification.method === "item/started"
      ? "started"
      : notification.method === "item/completed"
        ? "completed"
        : undefined;
  if (!phase) {
    return undefined;
  }
  const params = isJsonObject(notification.params) ? notification.params : undefined;
  const item = params && isJsonObject(params.item) ? params.item : undefined;
  return item?.type === "contextCompaction" ? phase : undefined;
}

async function raceCodexSetupWithAbort<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    throw signal.reason instanceof Error
      ? signal.reason
      : new Error(String(signal.reason ?? "codex app-server setup aborted"));
  }
  let onAbort!: () => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () =>
      reject(
        signal.reason instanceof Error
          ? signal.reason
          : new Error(String(signal.reason ?? "codex app-server setup aborted")),
      );
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([work, aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function shouldUseFreshCodexThreadAfterContextEngineOverflow(params: {
  error: unknown;
  contextEngineActive: boolean;
  thread: CodexAppServerThreadLifecycleBinding;
}): boolean {
  if (!params.contextEngineActive || params.thread.lifecycle.action !== "resumed") {
    return false;
  }
  return isCodexContextWindowError(params.error);
}

function isCodexContextWindowError(error: unknown): boolean {
  const message = formatErrorMessage(error);
  return (
    /ran out of room in the model'?s context window/iu.test(message) ||
    /context window/iu.test(message) ||
    /context length/iu.test(message) ||
    /maximum context/iu.test(message) ||
    /too many tokens/iu.test(message)
  );
}

function prependCurrentInboundContext(
  prompt: string,
  context: EmbeddedRunAttemptParams["currentInboundContext"],
): string {
  const text = context?.text.trim();
  return text ? [text, prompt].filter(Boolean).join("\n\n") : prompt;
}

function waitForCodexNotificationDispatchTurn(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}

function buildCodexAppServerTimeoutDiagnostics(params: {
  idleMs?: number;
  timeoutMs?: number;
  lastActivityReason?: string;
  details?: Record<string, unknown>;
}): NonNullable<EmbeddedRunAttemptResult["codexAppServerFailure"]>["diagnostics"] {
  const readString = (key: string) => {
    const value = params.details?.[key];
    return typeof value === "string" && value.trim() ? value : undefined;
  };
  const readNumber = (key: string) => {
    const value = params.details?.[key];
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
  };
  const readBoolean = (key: string) => {
    const value = params.details?.[key];
    return typeof value === "boolean" ? value : undefined;
  };
  return {
    ...(params.idleMs !== undefined ? { idleMs: params.idleMs } : {}),
    ...(params.timeoutMs !== undefined ? { timeoutMs: params.timeoutMs } : {}),
    ...(params.lastActivityReason ? { lastActivityReason: params.lastActivityReason } : {}),
    ...(readString("lastNotificationMethod")
      ? { lastNotificationMethod: readString("lastNotificationMethod") }
      : {}),
    ...(readString("lastNotificationItemId")
      ? { lastNotificationItemId: readString("lastNotificationItemId") }
      : {}),
    ...(readString("lastNotificationItemType")
      ? { lastNotificationItemType: readString("lastNotificationItemType") }
      : {}),
    ...(readString("lastNotificationItemRole")
      ? { lastNotificationItemRole: readString("lastNotificationItemRole") }
      : {}),
    ...(readString("lastAssistantTextPreview")
      ? { lastAssistantTextPreview: readString("lastAssistantTextPreview") }
      : {}),
    ...(readNumber("activeAppServerTurnRequests") !== undefined
      ? { activeAppServerTurnRequests: readNumber("activeAppServerTurnRequests") }
      : {}),
    ...(readNumber("activeTurnItemCount") !== undefined
      ? { activeTurnItemCount: readNumber("activeTurnItemCount") }
      : {}),
    ...(readBoolean("terminalTurnNotificationQueued") !== undefined
      ? { terminalTurnNotificationQueued: readBoolean("terminalTurnNotificationQueued") }
      : {}),
    ...(readBoolean("completionIdleWatchArmed") !== undefined
      ? { completionIdleWatchArmed: readBoolean("completionIdleWatchArmed") }
      : {}),
    ...(readBoolean("assistantCompletionIdleWatchArmed") !== undefined
      ? { assistantCompletionIdleWatchArmed: readBoolean("assistantCompletionIdleWatchArmed") }
      : {}),
    ...(readBoolean("terminalIdleWatchArmed") !== undefined
      ? { terminalIdleWatchArmed: readBoolean("terminalIdleWatchArmed") }
      : {}),
  };
}

function handleApprovalRequest(params: {
  method: string;
  params: JsonValue | undefined;
  paramsForRun: EmbeddedRunAttemptParams;
  threadId: string;
  turnId: string;
  nativeHookRelay?: NativeHookRelayRegistrationHandle;
  execPolicy?: Pick<OpenClawExecPolicyForCodexAppServer, "mode">;
  execReviewerAgentId?: string;
  internalExecAutoReview?: boolean;
  autoApprove?: boolean;
  signal?: AbortSignal;
}): Promise<JsonValue | undefined> {
  return handleCodexAppServerApprovalRequest({
    method: params.method,
    requestParams: params.params,
    paramsForRun: params.paramsForRun,
    threadId: params.threadId,
    turnId: params.turnId,
    nativeHookRelay: params.nativeHookRelay,
    execPolicy: params.execPolicy,
    execReviewerAgentId: params.execReviewerAgentId,
    internalExecAutoReview: params.internalExecAutoReview,
    autoApprove: params.autoApprove,
    signal: params.signal,
  });
}

function resolveCodexDynamicToolDirectNames(params: EmbeddedRunAttemptParams): string[] {
  if (params.sourceReplyDeliveryMode !== "message_tool_only") {
    return [];
  }
  return ["message"];
}

export const testing = {
  buildCodexNativeHookRelayId,
  buildDeveloperInstructions,
  filterCodexDynamicTools,
  prepareDynamicToolCatalog,
  filterCodexDynamicToolsForAllowlist,
  includeForcedCodexDynamicToolAllow,
  resolveCodexDynamicToolsLoadingForModel,
  resolveCodexAppServerHookChannelId,
  buildCodexAppServerPromptTimeoutOutcome,
  resolveOpenClawCodingToolsSessionKeys,
  shouldEnableCodexAppServerNativeToolSurface,
  shouldForceMessageTool,
  resolveCodexDynamicToolDirectNames,
  hasPendingDynamicToolTerminalDiagnostic,
  toTranscriptToolResultForTests: toTranscriptToolResult,
  withCodexStartupTimeout,
  setOpenClawCodingToolsFactoryForTests,
  resetOpenClawCodingToolsFactoryForTests,
  resetEnsuredCodexWorkspaceDirsForTests(): void {
    ensuredCodexWorkspaceDirs.clear();
  },
  flushPendingCodexNativeHookRelayUnregistersForTests,
  clearPendingCodexNativeHookRelayUnregistersForTests,
  resolveCodexNativeHookRelayUnregisterGraceMs,
  resolveCodexSandboxAgentId,
} as const;
export { testing as __testing };
