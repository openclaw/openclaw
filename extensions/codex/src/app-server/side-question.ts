import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  buildAgentHookContextChannelFields,
  embeddedAgentLog,
  formatErrorMessage,
  resolveSandboxContext,
  type AgentHarnessSideQuestionParamsV2,
  type AgentHarnessSideQuestionResult,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { resolveAgentWorkspaceDir } from "openclaw/plugin-sdk/agent-runtime";
import { resolveSessionAgentIdsStrict } from "openclaw/plugin-sdk/agent-scope-runtime";
import {
  loadCodexBundleMcpApprovalConfig,
  resolveCodexMcpToolOverridesForAgent,
} from "openclaw/plugin-sdk/codex-mcp-projection";
import { loadExecApprovalsReadOnlyAsync } from "openclaw/plugin-sdk/exec-approvals-runtime";
import type { registerNativeHookRelayForBundledRuntime } from "openclaw/plugin-sdk/native-hook-relay-runtime";
import { readStringField as readString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { resolveCodexAppServerForModelProvider } from "./app-server-policy.js";
import { handleCodexAppServerApprovalRequest } from "./approval-bridge.js";
import { retireUnsafeCodexTurnClientBestEffort } from "./attempt-client-cleanup.js";
import { resolveCodexAppServerPreparedAuthHandoff } from "./auth-bridge.js";
import {
  assertCodexSessionRuntimeOwnership,
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
} from "./config.js";
import {
  buildDynamicTools,
  resolveCodexExternalSandboxPolicyForOpenClawSandbox,
  resolveCodexMessageToolProvider,
  resolveCodexSandboxEnvironmentSelection,
  shouldEnableCodexAppServerNativeToolSurface,
  shouldRequireCodexSandboxExecServerEnvironment,
} from "./dynamic-tool-build.js";
import { createCodexDynamicToolDiagnostics } from "./dynamic-tool-diagnostics.js";
import {
  handleDynamicToolCallWithTimeout,
  resolveDynamicToolCallTimeoutMs,
  toCodexDynamicToolProtocolResponse,
} from "./dynamic-tool-execution.js";
import { resolveCodexDynamicToolsLoading } from "./dynamic-tool-profile.js";
import { createCodexDynamicToolBridge } from "./dynamic-tools.js";
import { routeCodexAppServerElicitationRequest } from "./elicitation-bridge.js";
import { createCodexElicitationResponse } from "./elicitation-response.js";
import { CodexEphemeralTurn } from "./ephemeral-turn.js";
import { CodexNativeToolLifecycleProjector } from "./event-projector-native-tool-lifecycle.js";
import { prepareCodexNativeExecutionPolicyForRun } from "./native-execution-policy.js";
import { createCodexNativePreToolUseFailureBuffer } from "./native-pre-tool-use-failures.js";
import {
  mergeCodexThreadConfigs,
  refreshCodexPluginAppApprovalPolicy,
} from "./plugin-thread-config.js";
import {
  assertCodexThreadForkResponse,
  assertCodexTurnStartResponse,
  readCodexDynamicToolCallParams,
} from "./protocol-validators.js";
import { isJsonObject, type JsonObject, type JsonValue } from "./protocol.js";
import { resolveCodexProviderWebSearchSupportForClient } from "./provider-capabilities.js";
import { readRecentCodexRateLimits } from "./rate-limit-cache.js";
import { formatCodexUsageLimitErrorMessage } from "./rate-limits.js";
import {
  readCodexSupportedReasoningEfforts,
  resolveCodexAppServerReasoningEffort,
} from "./reasoning-effort.js";
import { runCodexCleanupStep } from "./run-attempt-lifecycle.js";
import type { CodexRunAttemptOptions } from "./run-attempt-types.js";
import {
  ensureCodexSandboxExecServerEnvironment,
  releaseCodexSandboxExecServerEnvironment,
  type CodexSandboxExecEnvironment,
} from "./sandbox-exec-server.js";
import { resolveCodexNativeExecutionBlock } from "./sandbox-guard.js";
import { sessionBindingIdentity, resolveCodexSessionBinding } from "./session-binding.js";
import {
  applyCodexSessionPermissionPolicy,
  CODEX_SESSION_PERMISSION_EXEC_MODES,
  resolveCodexEffectiveSessionPermissionPolicy,
  resolveCodexSessionPermissionCwd,
} from "./session-permission-policy.js";
import {
  releaseCodexAppServerClientLease,
  withCodexAppServerClientRequestScope,
  type CodexAppServerClientLease,
  type CodexAppServerClientOptions,
} from "./shared-client.js";
import { cleanupCodexSideQuestion } from "./side-question-cleanup.js";
import {
  acquireCodexSideQuestionClient,
  CodexSideQuestionFork,
  DENIED_DYNAMIC_TOOL_RESPONSE,
  forkCodexSideThread,
  prepareCodexSideQuestionRelay,
  registerCodexSideQuestionRelay,
  resolveCodexSideQuestionRelayEvents,
} from "./side-question-fork.js";
import { SIDE_DEVELOPER_INSTRUCTIONS } from "./side-question-instructions.js";
import {
  applySideQuestionModelSelection,
  buildSideRunAttemptParams,
  resolveSideQuestionNativeModelSelection,
} from "./side-question-run-params.js";
import {
  CODEX_NATIVE_PERSONALITY_NONE,
  resolveCodexAppServerThreadModelSelection,
} from "./thread-model-selection.js";
import { isSameCodexAppServerThreadOwner } from "./thread-ownership.js";
import {
  assertCodexSupervisionThreadLineage,
  CodexThreadPolicyHandoffError,
  refreshCodexThreadPolicy,
} from "./thread-policy.js";
import { buildCodexRuntimeThreadConfig } from "./thread-requests.js";
import { resolveCodexToolAbortTerminalReason } from "./tool-abort-terminal-reason.js";
import { buildCodexTemporalAdditionalContext } from "./turn-params.js";
import type { CodexAppServerServerRequest, CodexThreadRouteScope } from "./turn-router.js";
import { buildCodexUserInput } from "./user-input.js";
import { resolveCodexWebSearchPlan, type CodexNativeWebSearchSupport } from "./web-search.js";

const SIDE_QUESTION_COMPLETION_TIMEOUT_MS = 600_000;

class CodexSideQuestionTimeoutError extends Error {
  override name = "TimeoutError";
}
export async function runCodexAppServerSideQuestion(
  params: AgentHarnessSideQuestionParamsV2,
  options: Pick<
    CodexRunAttemptOptions,
    "bindingStore" | "runtime" | "pluginConfig" | "runtimeModelId" | "nativeHookRelay"
  >,
): Promise<AgentHarnessSideQuestionResult> {
  const bindingIdentity = sessionBindingIdentity({
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    agentId: params.agentId,
    config: params.cfg,
  });
  const denyToolCalls = params.toolCalls === "deny";
  if (denyToolCalls && (!options.nativeHookRelay || options.nativeHookRelay.enabled === false)) {
    throw new Error("Session fork tool denial requires the Codex native hook relay to be enabled.");
  }
  const { binding, authority, release } = await resolveCodexSessionBinding({
    bindingStore: options.bindingStore,
    identity: bindingIdentity,
    config: params.cfg,
    storePath: params.storePath,
    assertCurrent: params.hostCapabilities.assertActive,
    signal: params.opts?.abortSignal,
    assertBinding: params.expectedSessionRuntimeOwnership
      ? (currentBinding) =>
          assertCodexSessionRuntimeOwnership(currentBinding, params.expectedSessionRuntimeOwnership)
      : undefined,
  });
  using _ = { [Symbol.dispose]: release };
  const assertCurrent = authority.assertCurrent;
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
    approvals:
      params.sessionEntry.permissionMode === "full"
        ? undefined
        : await loadExecApprovalsReadOnlyAsync(),
    config: params.cfg,
    agentId: sessionAgentId,
  });
  const usesSupervisionConnection = binding.connectionScope === "supervision";
  const nativeModelSelection = resolveSideQuestionNativeModelSelection(binding);
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
  const reviewerContext = {
    ...resolveCodexModelBackedReviewerPolicyContext({
      provider: nativeModelSelection ? "codex" : params.provider,
      model: nativeModelSelection?.model ?? params.model,
      bindingModelProvider: binding.modelProvider,
      bindingModel: binding.model,
      nativeAuthProfile: usesSupervisionConnection || preparedNativeAuthProfile,
    }),
    config: params.cfg,
    env: process.env,
    agentDir: params.agentDir,
  };
  const connection = await resolveCodexBindingAppServerConnection({
    binding,
    authProfileId,
    pluginConfig,
    execPolicy,
    assertCurrent,
    modelProvider: reviewerContext.modelProvider,
    model: reviewerContext.model,
    config: params.cfg,
    agentDir: params.agentDir,
  });
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
  const modelSelection =
    nativeModelSelection ??
    (await resolveCodexAppServerThreadModelSelection({
      homeScope: appServer.start.homeScope,
      provider: params.provider,
      model: params.model,
      requestModel: options.runtimeModelId ?? params.model,
      binding,
      inheritBindingAuthProfile: false,
      authProfileId,
      authProfileStore: preparedRuntimeAuth.authProfileStore,
      agentDir: params.agentDir,
      config: params.cfg,
    }));

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
  const effectiveParams = applySideQuestionModelSelection(params, nativeModelSelection);
  const sideRunParams = buildSideRunAttemptParams(effectiveParams, {
    cwd,
    authProfileId,
    runId,
    timeoutMs: appServer.requestTimeoutMs,
    permissionPolicy: sessionPermissionPolicy,
  });
  const sandboxExecServerEnabled = isCodexSandboxExecServerEnabled(pluginConfig, params.sandbox);
  const nativeExecutionPolicy = await prepareCodexNativeExecutionPolicyForRun(sideRunParams, {
    agentId: sideRunParams.agentId,
    sandbox: params.sandbox,
  });
  const assertNativeCurrent = () => {
    assertCurrent();
    nativeExecutionPolicy.source?.();
  };
  try {
    assertCurrent();
    const nativeToolSurfaceEnabled = shouldEnableCodexAppServerNativeToolSurface(
      sideRunParams,
      params.sandbox ?? undefined,
      { agentId: sideRunParams.agentId, sandboxExecServerEnabled, nativeExecutionPolicy },
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
      executionPolicy: nativeExecutionPolicy.policy,
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
      assertCurrent: assertNativeCurrent,
      assertCurrentAsync: nativeExecutionPolicy.assertCurrent,
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
    const { client, parentLease } = await acquireCodexSideQuestionClient(
      denyToolCalls,
      binding.clientId,
      clientOptions,
    );
    const clientLease: CodexAppServerClientLease = { client };
    let collector: CodexEphemeralTurn | undefined;
    const runAbortController = new AbortController();
    let nativeToolLifecycleProjector: CodexNativeToolLifecycleProjector | undefined;
    let nativeToolRunWasAbortedBeforeCleanup: boolean | undefined;
    const nativePreToolUseFailures = createCodexNativePreToolUseFailureBuffer({
      agentId: sessionAgentId,
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
      runId: sideRunParams.runId,
      signal: runAbortController.signal,
    });
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
    const ownedToolSandboxes = new Set<
      NonNullable<Awaited<ReturnType<typeof resolveSandboxContext>>>
    >();
    let nativeHookRelay: ReturnType<typeof registerNativeHookRelayForBundledRuntime> | undefined;
    const activeDynamicToolCalls = new Set<Promise<unknown>>();
    let primaryFailure: { error: unknown } | undefined;
    let fork: CodexSideQuestionFork | undefined;
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

    async function createCodexSideToolBridge(
      nativeProviderWebSearchSupport: CodexNativeWebSearchSupport,
    ) {
      const resolvedWorkspace = effectiveParams.workspaceDir ?? cwd;
      const sandboxSessionKey =
        sideRunParams.sandboxSessionKey?.trim() ||
        sideRunParams.sessionKey?.trim() ||
        sideRunParams.sessionId ||
        sessionAgentId;
      const sandbox =
        sideRunParams.sandbox !== undefined
          ? sideRunParams.sandbox
          : await resolveSandboxContext({
              config: sideRunParams.config,
              sessionKey: sandboxSessionKey,
              workspaceDir: cwd,
            });
      if (sideRunParams.sandbox === undefined && sandbox) {
        ownedToolSandboxes.add(sandbox);
      }
      let webSearchAllowed = false;
      const tools = await buildDynamicTools({
        params: sideRunParams,
        resolvedWorkspace,
        effectiveWorkspace: cwd,
        sandboxSessionKey,
        sandbox,
        nativeToolSurfaceEnabled,
        nativeExecutionPolicy,
        nativeProviderWebSearchSupport,
        sessionPermissionPolicy,
        runAbortController,
        sessionAgentId,
        policyAgentId: sessionAgentId,
        pluginConfig,
        onYieldDetected: () => {},
        onWebSearchPolicyResolved: (allowed) => {
          webSearchAllowed = allowed;
        },
      });
      const requestedWebSearchPlan = resolveCodexWebSearchPlan({
        config: sideRunParams.config,
        nativeToolSurfaceEnabled,
        nativeProviderWebSearchSupport,
        webSearchAllowed,
      });
      // Forks inherit dynamic declarations; BTW retains its native-only search policy.
      const webSearchPlan =
        !denyToolCalls && requestedWebSearchPlan.kind === "managed"
          ? resolveCodexWebSearchPlan({ config: sideRunParams.config, webSearchAllowed: false })
          : requestedWebSearchPlan;
      // Side threads do not own the compaction lifecycle that expires screenshot coordinates.
      const exposedTools = denyToolCalls
        ? tools
        : tools.filter((tool) => tool.name !== "web_search" && tool.name !== "computer");
      return {
        toolBridge: createCodexDynamicToolBridge({
          assertCurrentAsync: nativeExecutionPolicy.assertCurrent,
          tools: exposedTools,
          signal: runAbortController.signal,
          loading: resolveCodexDynamicToolsLoading(pluginConfig),
          hookContext: {
            agentId: sessionAgentId,
            config: sideRunParams.config,
            contextWindowTokens: sideRunParams.model.contextWindow,
            sessionId: sideRunParams.sessionId,
            sessionKey: sideRunParams.sessionKey,
            runId: sideRunParams.runId,
            currentChannelProvider: resolveCodexMessageToolProvider(sideRunParams),
            ...buildAgentHookContextChannelFields(sideRunParams),
          },
        }),
        webSearchPlan,
      };
    }

    try {
      fork = denyToolCalls ? new CodexSideQuestionFork(client, binding.threadId) : undefined;
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
      const { toolBridge, webSearchPlan } = await createCodexSideToolBridge(
        nativeProviderWebSearchSupport,
      );
      const handleServerRequest = async (
        request: CodexAppServerServerRequest,
        _scope: CodexThreadRouteScope,
        requestSignal: AbortSignal,
        setExecutionTimeoutMs?: (timeoutMs: number | null) => void,
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
          return isJsonObject(request.params) &&
            request.params.threadId === childThreadId &&
            request.params.turnId === turnId
            ? { answers: {} }
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
        if (denyToolCalls) {
          return DENIED_DYNAMIC_TOOL_RESPONSE;
        }
        const timeoutMs = resolveDynamicToolCallTimeoutMs({
          call,
          config: params.cfg,
          toolBridge,
          parentTimeoutMs: SIDE_QUESTION_COMPLETION_TIMEOUT_MS,
        });
        setExecutionTimeoutMs?.(timeoutMs);
        const toolStartedAt = Date.now();
        const diagnostics = createCodexDynamicToolDiagnostics({
          call,
          agentId: sessionAgentId,
          runId: sideRunParams.runId,
          sessionId: params.sessionId,
          sessionKey: params.sessionKey,
        });
        diagnostics.started();
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
          diagnostics.terminal(response, Math.max(0, Date.now() - toolStartedAt));
          return toCodexDynamicToolProtocolResponse(response) as JsonValue;
        } catch (error) {
          diagnostics.error(
            Math.max(0, Date.now() - toolStartedAt),
            signal.aborted ? resolveCodexToolAbortTerminalReason(signal) : "failed",
          );
          throw error;
        } finally {
          activeDynamicToolCalls.delete(toolCall);
        }
      };

      const serviceTier = binding.serviceTier ?? appServer.serviceTier;
      const nativeHookRelayEvents = await resolveCodexSideQuestionRelayEvents({
        denyToolCalls,
        client,
        signal: runAbortController.signal,
        appServer,
        options: options.nativeHookRelay,
        assertCurrent,
      });
      nativeHookRelay = registerCodexSideQuestionRelay(
        {
          denyToolCalls,
          appServer,
          options: options.nativeHookRelay,
          completionTimeoutMs: SIDE_QUESTION_COMPLETION_TIMEOUT_MS,
          sideParams: params,
          agentId: sessionAgentId,
        },
        {
          autoApproveMcpTools,
          projectedMcpServers,
          runId: sideRunParams.runId,
          allowedEvents: nativeHookRelayEvents,
          signal: runAbortController.signal,
          runBeforeToolCall: sideRunParams.hostCapabilities.runBeforeToolCall,
          assertActive: assertNativeCurrent,
          assertActiveAsync: nativeExecutionPolicy.assertCurrent,
          onPreToolUseFailure: (failure) => {
            if (!nativePreToolUseFailures.active && nativeToolLifecycleProjector) {
              nativeToolLifecycleProjector.recordPreToolUseFailure(
                failure,
                nativeToolRunWasAbortedBeforeCleanup,
              );
            } else {
              nativePreToolUseFailures.record(failure);
            }
          },
        },
      );
      const nativeHookRelayConfig = await prepareCodexSideQuestionRelay({
        relay: nativeHookRelay,
        events: nativeHookRelayEvents,
        options: options.nativeHookRelay,
        assertCurrent,
      });
      const runtimeThreadConfig = buildCodexRuntimeThreadConfig(webSearchPlan.threadConfig, {
        nativeCodeModeEnabled: nativeToolSurfaceEnabled,
        nativeCodeModeOnlyEnabled: appServer.codeModeOnly,
      });
      const sideThreadId = await withCodexAppServerClientRequestScope({
        lease: clientLease,
        options: clientOptions,
        signal: runAbortController.signal,
        run: async (forkClient, requestOptions) =>
          options.bindingStore.withLease(
            bindingIdentity,
            async () => {
              const assertCurrentBinding = () => {
                assertNativeCurrent();
                runAbortController.signal.throwIfAborted();
              };
              assertCurrentBinding();
              // The lease pins this snapshot; later native effects still require live authority.
              const current = options.bindingStore.read(bindingIdentity);
              if (
                !(denyToolCalls
                  ? isSameCodexAppServerThreadOwner(current, binding)
                  : isDeepStrictEqual(current, binding))
              ) {
                throw new Error("Codex side-question binding changed before fork");
              }
              const currentRequestOptions = (): ReturnType<typeof requestOptions> => ({
                ...requestOptions(),
                withCurrent: (write) => nativeExecutionPolicy.admit(write, authority.withCurrent),
                assertCurrent: assertCurrentBinding,
              });
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
              if (!denyToolCalls) {
                await ensureSandboxEnvironment(forkClient);
              }
              assertCurrentBinding();
              const executionCwd = sandboxEnvironment?.cwd ?? cwd;
              let pluginAppsConfigPatch: JsonObject | undefined;
              if (!denyToolCalls && binding.pluginAppPolicyContext) {
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
                  fork
                    ? fork.threadParams(nativeHookRelayConfig)
                    : {
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
                        excludeTurns: true,
                        threadSource: "user",
                      },
                  currentRequestOptions(),
                ),
              );
              if (!response.thread.id.trim() || response.thread.id === binding.threadId) {
                await retireUnsafeCodexTurnClientBestEffort(
                  forkClient,
                  "unsafe side child identity",
                );
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
              await fork?.registerChild(
                forkClient,
                childThreadId,
                sideRunParams.hostCapabilities,
                runAbortController,
                assertCurrent,
                assertCurrentBinding,
              );
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
                  nativeModelSelection &&
                  (response.model !== nativeModelSelection.model ||
                    response.modelProvider !== nativeModelSelection.modelProvider)
                ) {
                  throw new Error(
                    "Codex side thread did not preserve its native model and provider",
                  );
                }
                if (!denyToolCalls) {
                  await refreshCodexThreadPolicy({
                    client: forkClient,
                    threadId: childThreadId,
                    developerInstructions: SIDE_DEVELOPER_INSTRUCTIONS,
                    ...currentRequestOptions(),
                  });
                }
              } catch (error) {
                policyWriteUncertain =
                  error instanceof CodexThreadPolicyHandoffError && error.outcome === "unknown";
                // A child already exists: selection recovery cannot repeat this callback.
                throw error instanceof CodexThreadPolicyHandoffError
                  ? error
                  : new CodexThreadPolicyHandoffError("not-written", error);
              }
              return response.thread.id;
            },
            { assertCurrent, authority },
          ),
      });

      const effort = usesSupervisionConnection
        ? undefined
        : resolveCodexAppServerReasoningEffort({
            thinkLevel: params.resolvedThinkLevel ?? "off",
            modelId: modelSelection.model,
            supportedReasoningEfforts: readCodexSupportedReasoningEfforts(
              effectiveParams.runtimeModel?.compat,
            ),
          });
      const turnResponse = assertCodexTurnStartResponse(
        await client
          .request(
            "turn/start",
            fork
              ? fork.turnParams(sideThreadId, params)
              : {
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
                  ...(usesSupervisionConnection
                    ? {}
                    : { personality: CODEX_NATIVE_PERSONALITY_NONE }),
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
              assertCurrent: assertNativeCurrent,
              withCurrent: (write) => nativeExecutionPolicy.admit(write, authority.withCurrent),
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
      fork?.bindTurn(turnId, params, modelSelection.model);
      nativeToolLifecycleProjector = new CodexNativeToolLifecycleProjector(
        { ...sideRunParams, agentId: sessionAgentId },
        sideThreadId,
        turnId,
        {
          runAbortSignal: runAbortController.signal,
        },
      );
      for (const failure of nativePreToolUseFailures.pending) {
        nativeToolLifecycleProjector.recordPreToolUseFailure(failure);
      }
      nativePreToolUseFailures.pending.length = 0;
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
      return await authority.withCurrent(() => ({ text: result.text, usage: result.usage }));
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
          () => fork?.releaseInferenceContext(),
          () => fork?.unregisterModel(),
          () => nativeToolLifecycleProjector?.finalizeActive(nativeToolRunWasAbortedBeforeCleanup),
          () =>
            nativePreToolUseFailures.activateFallback(
              nativeToolRunWasAbortedBeforeCleanup === true,
            ),
          nativePreToolUseFailures.flush,
          releaseSandboxEnvironment,
          () => {
            for (const sandbox of ownedToolSandboxes) {
              sandbox[Symbol.dispose]?.();
            }
            ownedToolSandboxes.clear();
          },
          () =>
            parentLease ? parentLease.release() : releaseCodexAppServerClientLease(clientLease),
          () => nativeHookRelay?.unregister(),
          () =>
            runCodexCleanupStep(sideRunParams, "codex-side-native-hook-relay-release", async () => {
              await nativeHookRelay?.drain();
            }),
        ],
      });
    }
  } finally {
    nativeExecutionPolicy.release();
  }
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
