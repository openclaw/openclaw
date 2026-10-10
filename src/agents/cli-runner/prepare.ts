import {
  ensureSystemPromptCacheBoundary,
  splitSystemPromptRelocatableBoundary,
} from "@openclaw/ai/internal/shared";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import {
  buildHarnessVisibleReplyGuidance,
  messageToolOwnsVisibleReply,
} from "../../auto-reply/source-reply-delivery-mode.js";
import { getRuntimeConfig } from "../../config/config.js";
import { canonicalizeMainSessionAlias } from "../../config/sessions/main-session.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  assertContextEngineHostSupport,
  buildGenericCliContextEngineHostSupport,
} from "../../context-engine/host-compat.js";
import { ensureContextEnginesInitialized } from "../../context-engine/init.js";
import { resolveContextEngine } from "../../context-engine/registry.js";
import {
  activateMcpLoopbackClientGrantCapture,
  bindMcpLoopbackClientGrantAdmission,
  deactivateMcpLoopbackClientGrantCapture,
  mintMcpLoopbackClientGrant,
  revokeMcpLoopbackClientGrant,
  transferMcpLoopbackClientGrant,
} from "../../gateway/mcp-grant-store.js";
import { ensureMcpLoopbackServer } from "../../gateway/mcp-http.js";
import {
  createMcpLoopbackServerConfig,
  getActiveMcpLoopbackRuntime,
} from "../../gateway/mcp-http.loopback-runtime.js";
import {
  resolveMcpLoopbackPolicyTools,
  resolveMcpLoopbackScopedTools,
} from "../../gateway/mcp-http.runtime.js";
import { claimHeartbeatContextForUserRun } from "../../infra/heartbeat-outcome-store.js";
import { buildSystemAgentToolsMcpServerConfig } from "../../mcp/openclaw-tools-serve-config.js";
import { CliBackendAuthProfilePreparationError } from "../../plugins/cli-backend-errors.js";
import type {
  CliBackendPreparedExecution,
  CliBackendPromptContext,
} from "../../plugins/cli-backend.types.js";
import { buildAgentHookContextChannelFields } from "../../plugins/hook-agent-context.js";
import { getGlobalHookRunner } from "../../plugins/hook-runner-global.js";
import {
  LEGACY_IMPLICIT_AGENT_ID,
  isSubagentSessionKey,
  normalizeAgentId,
  parseAgentSessionKey,
} from "../../routing/session-key.js";
import { captureAsyncWorkTracker } from "../../shared/async-work-scope.js";
import { resolveUserPath } from "../../utils.js";
import { normalizeMessageChannel } from "../../utils/message-channel.js";
import {
  readRunOperatorAuthority,
  resolveAdmittedRunActiveAssertion,
} from "../admitted-run-context.js";
import { hasAgentRosterProperty, resolveAgentWorkspaceDir } from "../agent-scope-config.js";
import { resolveAgentDir, resolveSessionAgentIds } from "../agent-scope.js";
import { hasUsableOAuthCredential } from "../auth-profiles/credential-state.js";
import { externalCliDiscoveryForProviderAuth } from "../auth-profiles/external-cli-discovery.js";
import { buildOAuthRefreshFailureLoginCommand } from "../auth-profiles/oauth-refresh-failure.js";
import { resolveApiKeyForProfile } from "../auth-profiles/oauth.js";
import { resolveAuthProfileOrder } from "../auth-profiles/order.js";
import { isSetupCredentialAccessible } from "../auth-profiles/setup-access.js";
import { loadAuthProfileStoreForRuntime } from "../auth-profiles/store-runtime.js";
import { resolveRuntimeAuthProfileAgentDir } from "../auth-profiles/store.js";
import type { AuthProfileStore } from "../auth-profiles/types.js";
import {
  buildBootstrapBudgetState,
  buildBootstrapInjectionStats,
  buildBootstrapPromptWarningNotice,
  buildBootstrapTruncationReportMeta,
} from "../bootstrap-budget.js";
import {
  makeBootstrapWarn as makeBootstrapWarnImpl,
  resolveBootstrapContextForRun as resolveBootstrapContextForRunImpl,
} from "../bootstrap-files.js";
import { isHeartbeatLifecycleRunKind } from "../bootstrap-mode.js";
import { isPrimaryBootstrapRun, resolveWorkspaceBootstrapRouting } from "../bootstrap-routing.js";
import {
  CLI_AUTH_EPOCH_VERSION,
  resolveCliAuthBindingFingerprint,
  resolveCliAuthEpoch,
} from "../cli-auth-epoch.js";
import { resolveCliBackendConfig } from "../cli-backends.js";
import { hashCliSessionText, resolveCliSessionReuse } from "../cli-session.js";
import {
  claudeCliSessionTranscriptHasContent,
  claudeCliSessionTranscriptHasOrphanedToolUse,
} from "../command/attempt-execution.helpers.js";
import { resolveContextWindowInfo } from "../context-window-guard.js";
import { resolveContextTokensForModel } from "../context.js";
import { DEFAULT_CONTEXT_TOKENS } from "../defaults.js";
import { waitForDeferredTurnMaintenanceForSession } from "../embedded-agent-runner/context-engine-maintenance.js";
import {
  resolvePromptBuildHookResult,
  type ResolvedPromptBuildHookResult,
} from "../embedded-agent-runner/run/attempt-prompt-helpers.js";
import {
  applyEmbeddedAttemptToolsAllow,
  mergeForcedEmbeddedAttemptToolsAllow,
} from "../embedded-agent-runner/run/attempt-tool-construction-plan.js";
import { remapSkillReferencePaths } from "../embedded-agent-runner/sandbox-skills.js";
import { beginContextEngineLogicalTurn } from "../harness/context-engine-turn-begin.js";
import type { ResolvedProviderAuth } from "../model-auth-runtime-shared.js";
import { loadManifestModelCatalog, overlayConfiguredModelCatalog } from "../model-catalog.js";
import { resolveModelContextWindowProfile } from "../model-context-window.js";
import { recordAdmittedModelRoutingDecision } from "../model-routing-decision.js";
import { applyPluginTextReplacements } from "../plugin-text-transforms.js";
import { collectRuntimeChannelCapabilities } from "../runtime-capabilities.js";
import { buildSystemPromptReport } from "../system-prompt-report.js";
import { appendModelIdentitySystemPrompt, buildModelIdentityPromptLine } from "../system-prompt.js";
import { normalizeToolPolicyName } from "../tool-policy.js";
import { assertNativeCronCreatorCapabilities } from "../tools/cron-tool-creator-cap.js";
import { redactRunIdentifier, resolveRunWorkspaceDir } from "../workspace-run.js";
import {
  DEFAULT_BOOTSTRAP_FILENAME,
  isWorkspaceBootstrapPending as isWorkspaceBootstrapPendingImpl,
} from "../workspace.js";
import { CliAuthProfilePreparationError } from "./auth-profile-preparation-error.js";
import { canTransportSystemPrompt, resolveCliBootstrapPromptHash } from "./bootstrap-transport.js";
import {
  applyClaudeManagedMcpTimeout,
  CLAUDE_MANAGED_MCP_TIMEOUT_MS,
} from "./bundle-mcp-claude.js";
import { prepareCliBundleMcpConfig, resolveCliNativeWebSearchEnabled } from "./bundle-mcp.js";
import { prepareClaudeCliSkillsPlugin } from "./claude-skills-plugin.js";
import { runCliCleanup, sequenceCliCleanups } from "./cleanup.js";
import { resolveBundledCliBackendAuthPolicy } from "./cli-backend-auth-policy.js";
import { getCliLiveSessionGeneration } from "./cli-live-session-registry.js";
import { resolveCliSessionId } from "./cli-run-recovery.js";
import {
  createCliRunCurrentAssertion,
  resolveCliExecutionTarget,
  retainCliPluginExecutionConsumer,
  unsupportedIsolatedCompletionError,
} from "./execution-target.js";
import { isClaudeCliBackendId, normalizeCliModel } from "./helpers.js";
import { prepareCliHistoryBoundary } from "./history-boundary.js";
import { cliBackendLog } from "./log.js";
import { buildCliMcpGrantContext } from "./mcp-grant-context.js";
import { resolveCliCatalogCapabilities } from "./model-capabilities.js";
import { detectNodeClaudePlacement, resolveClaudeCliContextModelId } from "./prepare-claude.js";
import * as mcp from "./prepare-mcp.js";
import { runWithCliPreparationSource } from "./prepare-source.js";
import { resolveCliRuntimeToolPolicy } from "./prepare-tool-policy.js";
import {
  composeCliPromptContext,
  createCliCurrentPromptRenderer,
  prepareCliSystemPrompt,
  prepareCliTurnPromptContext,
} from "./prompt-context.js";
import { admitCliRunParams, prepareCliRunModelAuthority } from "./run-admission.js";
import {
  buildCliSessionHistoryPrompt,
  hasCliSessionTranscript,
  loadCliSessionHistoryMessages,
  loadCliSessionPromptContext,
  resolveAutoCliSessionReseedHistoryChars,
} from "./session-history.js";
import { resolveCliSkillsPrompt } from "./skills-prompt.js";
import {
  captureCliRunToolAuthority,
  finalizeCliSessionEventSourcePolicy,
} from "./tool-authority.js";
import {
  captureCliRunStartTime,
  type CliReusableSession,
  type CliSecretInput,
  type PreparedCliRunContext,
  type RunCliAgentParams,
} from "./types.js";

type PrivateCliBackendPreparedExecution = CliBackendPreparedExecution & {
  isolatedCompletionEnforced?: true;
  secretInput?: CliSecretInput;
};

type RunCliAgentPrepareParams = RunCliAgentParams & {
  /** Ring-zero tool transport supplied only by the OpenClaw orchestrator. */
  systemAgentTool?: import("../tools/system-agent-tool.js").SystemAgentToolOptions;
};

export async function prepareCliRunContext(
  inputParams: RunCliAgentParams,
): Promise<PreparedCliRunContext> {
  return runWithCliPreparationSource(inputParams, () =>
    prepareCliRunContextWithinReadFence(inputParams),
  );
}

async function prepareCliRunContextWithinReadFence(
  inputParams: RunCliAgentParams,
): Promise<PreparedCliRunContext> {
  let params = inputParams.config ? inputParams : { ...inputParams, config: getRuntimeConfig() };
  if (params.sessionManager) {
    // Caller-owned memory is authoritative even when empty. Correlation and native
    // bindings survive; borrowed durable paths, writers, and turn leases do not.
    params = {
      ...params,
      sessionFile: `in-memory:${params.sessionManager.getSessionId()}`,
      sessionTarget: undefined,
      storePath: undefined,
      expectedLifecycleRevision: undefined,
      expectedWriterRunId: undefined,
      userTurnTranscriptRecorder: undefined,
      persistAssistantTranscript: undefined,
      prepareAssistantTranscriptMessage: undefined,
      contextEngineLogicalTurnLease: undefined,
      onContextEngineTurnCandidate: undefined,
    };
  }
  const runConfig = params.config!;
  const sessionOwner = normalizeAgentId(
    parseAgentSessionKey(params.sessionKey)?.agentId ||
      params.agentId?.trim() ||
      LEGACY_IMPLICIT_AGENT_ID,
  );
  // Direct CLI-runner callers predate roster-aware ownership. Adapt that SDK
  // input only for strict workspace admission; keep the original config object
  // for backend hooks, sandboxing, and context-engine identity contracts.
  const workspaceConfig = hasAgentRosterProperty(runConfig)
    ? runConfig
    : ({
        ...runConfig,
        agents: {
          ...runConfig.agents,
          entries: { [sessionOwner]: {} },
        },
      } satisfies OpenClawConfig);
  const { started, startedMonotonicMs } = captureCliRunStartTime();
  // Recovery retry budgets measure elapsed time; keep a monotonic anchor so a
  // wall-clock correction cannot shorten or extend an operator-configured timeout.
  const executionMode = params.executionMode ?? "agent";
  const isSideQuestion = executionMode === "side-question";
  const isControlOperation = params.controlOperation !== undefined;
  // Control bytes must reach the resumed backend without turn hooks, prompts,
  // tools, MCP, skills, or context-engine setup changing their execution.
  const skipsTurnPreparation = isSideQuestion || isControlOperation;
  const runtimeChatType = params.chatType ?? params.sessionEntry?.chatType;
  const workspaceResolution = resolveRunWorkspaceDir({
    workspaceDir: params.workspaceDir,
    sessionKey: params.sessionKey,
    agentId: sessionOwner,
    config: workspaceConfig,
  });
  const resolvedWorkspace = workspaceResolution.workspaceDir;
  const redactedSessionId = redactRunIdentifier(params.sessionId);
  const redactedSessionKey = redactRunIdentifier(params.sessionKey);
  const redactedWorkspace = redactRunIdentifier(resolvedWorkspace);
  if (workspaceResolution.usedFallback) {
    cliBackendLog.warn(
      `[workspace-fallback] caller=runCliAgent reason=${workspaceResolution.fallbackReason} run=${params.runId} session=${redactedSessionId} sessionKey=${redactedSessionKey} agent=${workspaceResolution.agentId} workspace=${redactedWorkspace}`,
    );
  }
  const workspaceDir = resolvedWorkspace;
  const suppliedSessionKey = params.sessionKey?.trim();
  if (suppliedSessionKey) {
    // Native questions and MCP tools share explicit aliases; absent native keys stay sessionless.
    params = {
      ...params,
      sessionKey: canonicalizeMainSessionAlias({
        cfg: runConfig,
        agentId: workspaceResolution.agentId,
        sessionKey: suppliedSessionKey,
      }),
    };
  }
  // Every prompt/history read must observe prior deferred rewrites. Caller-owned
  // memory remains independent of durable work sharing its correlation key.
  if (!params.isolatedCompletion && !isControlOperation && !params.sessionManager) {
    await waitForDeferredTurnMaintenanceForSession(params.sessionKey ?? params.sessionId);
  }
  const policySessionKey = params.runtimePolicySessionKey ?? params.sessionKey;
  // Capture the requester before admission replaces agentId with the execution owner.
  const policyAgentId = resolveSessionAgentIds({
    sessionKey: policySessionKey,
    config: runConfig,
    fallbackAgentId: params.runtimePolicySessionKey ? params.agentId : workspaceResolution.agentId,
  }).sessionAgentId;
  const cwd = params.cwd ? resolveUserPath(params.cwd) : workspaceDir;
  const cwdHash = hashCliSessionText(cwd);

  // params.agentId may identify a distinct runtime-policy requester. Backend
  // config and managed process reuse must key from the resolved session owner.
  const backendResolved = resolveCliBackendConfig(params.provider, params.config, {
    agentId: workspaceResolution.agentId,
  });
  if (!backendResolved) {
    throw new Error(`Unknown CLI backend: ${params.provider}`);
  }
  params = prepareCliRunModelAuthority(params);
  const backendAuthPolicy = resolveBundledCliBackendAuthPolicy(backendResolved.id);
  const canEnforceExactToolAvailability =
    backendResolved.nativeToolMode === "selectable" &&
    ((backendResolved.toolAvailabilityEnforcement === "execution-args" &&
      backendResolved.resolveExecutionArgs !== undefined) ||
      (backendResolved.toolAvailabilityEnforcement === "prepare-execution" &&
        backendResolved.prepareExecution !== undefined));
  const callerToolAuthority = captureCliRunToolAuthority(params, {
    agentId: workspaceResolution.agentId,
    workspaceDir,
    cwd,
  });
  const toolPolicy = resolveCliRuntimeToolPolicy({
    params,
    policySessionKey,
    policyAgentId,
    backendId: backendResolved.id,
    bundleMcp: backendResolved.bundleMcp,
    canEnforceExactToolAvailability,
    isSideQuestion,
    skipsTurnPreparation,
  });
  params = toolPolicy.params;
  const { runtimeToolsAllowPolicy } = toolPolicy;
  const internalParams = params as RunCliAgentPrepareParams;
  const nodeClaudePlacement = detectNodeClaudePlacement({
    backendId: backendResolved.id,
    execHost: params.sessionEntry?.execHost,
    execNode: params.sessionEntry?.execNode,
  });
  params.assertCurrent?.();
  params.abortSignal?.throwIfAborted();
  if (nodeClaudePlacement && params.cliToolAvailability) {
    // Only the personal Workshop has an invocation-bound node callback adapter.
    params = {
      ...params,
      cliToolAvailability: {
        native: params.cliToolAvailability.native,
        openClaw: params.cliToolAvailability.openClaw.filter((name) => name === "skill_workshop"),
      },
    };
  }
  if (params.cliToolAvailability !== undefined && !canEnforceExactToolAvailability) {
    // Cron persists this verbatim and failure alerts truncate at 200 characters,
    // so keep the upgrade recovery and fail-closed outcome compact.
    throw new Error(
      `CLI backend "${backendResolved.id}" cannot enforce this run's tool cap. Upgrade its plugin and retry; if current, ask its maintainer to add exact-cap support. OpenClaw did not start the run.`,
    );
  }
  const sideQuestionDisablesNativeTools =
    isSideQuestion && backendResolved.sideQuestionToolMode === "disabled";
  const requestedNoNativeTools = params.cliToolAvailability?.native.length === 0;
  if (
    params.disableTools === true &&
    (backendResolved.nativeToolMode === "always-on" ||
      (backendResolved.nativeToolMode === "selectable" && !requestedNoNativeTools)) &&
    !sideQuestionDisablesNativeTools
  ) {
    throw new Error(
      `CLI backend ${backendResolved.id} cannot run with tools disabled because it exposes native tools`,
    );
  }
  const { sessionAgentId } = resolveSessionAgentIds({
    sessionKey: params.sessionKey,
    config: params.config,
    agentId: sessionOwner,
  });
  const agentDir = params.agentDir ?? resolveAgentDir(params.config ?? {}, sessionAgentId);
  const requestedAuthProfileId = params.authProfileId?.trim() || undefined;
  let effectiveAuthProfileId =
    requestedAuthProfileId ?? backendResolved.defaultAuthProfileId?.trim() ?? undefined;
  let authStore: AuthProfileStore | undefined;
  let resolvedProfileAuth: ResolvedProviderAuth | undefined;
  const loadScopedAuthStore = (options: { profileId?: string; readOnly?: boolean } = {}) => {
    params.assertCurrent?.();
    return loadAuthProfileStoreForRuntime(agentDir, {
      readOnly: options.readOnly ?? true,
      profileId: options.profileId,
      externalCli: externalCliDiscoveryForProviderAuth({
        cfg: params.config,
        provider: params.provider,
        ...(options.profileId ? { profileId: options.profileId } : {}),
      }),
    });
  };
  if (effectiveAuthProfileId) {
    authStore = loadScopedAuthStore({ profileId: effectiveAuthProfileId });
  } else if (
    backendResolved.autoSelectAuthProfile !== false &&
    (backendResolved.authEpochMode === "profile-only" || backendResolved.prepareExecution)
  ) {
    authStore = loadScopedAuthStore();
    effectiveAuthProfileId =
      resolveAuthProfileOrder({
        cfg: params.config,
        store: authStore,
        provider: params.provider,
        includePendingOAuthRefresh: true,
      })[0]?.trim() || undefined;
  }
  let authCredential = effectiveAuthProfileId
    ? authStore?.profiles[effectiveAuthProfileId]
    : undefined;
  if (
    effectiveAuthProfileId &&
    authCredential &&
    !isSetupCredentialAccessible({
      profileId: effectiveAuthProfileId,
      credential: authCredential,
      agentDir,
    })
  ) {
    throw new Error("This saved sign-in is inactive. Test and activate it in Model Setup.");
  }
  // Claude owns its native login and single-use refresh-token family. Never
  // preflight, refresh, or forward OpenClaw's snapshot; the installed Claude
  // process validates and refreshes its own current login.
  const usesNativeAuthProfile =
    backendAuthPolicy?.nativeAuthProfileIds !== undefined &&
    effectiveAuthProfileId !== undefined &&
    backendAuthPolicy.nativeAuthProfileIds.includes(effectiveAuthProfileId);
  if (usesNativeAuthProfile) {
    effectiveAuthProfileId = undefined;
    authCredential = undefined;
  } else if (
    effectiveAuthProfileId &&
    backendAuthPolicy &&
    (authCredential
      ? authCredential.type !== "oauth" || backendAuthPolicy.oauthRefreshOwner === "core"
      : backendAuthPolicy.strictSelectedProfile)
  ) {
    const authProfileId = effectiveAuthProfileId;
    const profileResolutionError = (provider: string, resolvedProfileId?: string) => {
      const loginCommand = buildOAuthRefreshFailureLoginCommand(provider, {
        profileId: authProfileId,
      });
      const reason =
        resolvedProfileId !== undefined
          ? `selected auth profile "${authProfileId}" resolved as "${resolvedProfileId}"`
          : `could not materialize selected auth profile "${authProfileId}"`;
      return new CliAuthProfilePreparationError({
        message: `CLI backend "${backendResolved.id}" ${reason}. Re-authenticate with: ${loginCommand}. OpenClaw did not start the run.`,
        profileId: authProfileId,
        provider,
        agentDir,
      });
    };
    const writableAuthStore = loadScopedAuthStore({ profileId: authProfileId, readOnly: false });
    const resolvedAuth = await resolveApiKeyForProfile({
      cfg: params.config,
      store: writableAuthStore,
      profileId: authProfileId,
      agentDir,
      // Claude's selected profile is an account boundary. Never refresh or
      // substitute a sibling account while preparing this run.
      ...(backendAuthPolicy?.strictSelectedProfile ? { allowProfileFallback: false } : {}),
    });
    params.assertCurrent?.();
    if (backendAuthPolicy.strictSelectedProfile && resolvedAuth?.profileId !== authProfileId) {
      throw profileResolutionError(
        resolvedAuth?.provider ??
          writableAuthStore.profiles[authProfileId]?.provider ??
          params.provider,
        resolvedAuth?.profileId,
      );
    }
    const resolvedAuthProfileId = resolvedAuth?.profileId ?? authProfileId;
    authStore = loadScopedAuthStore({ profileId: resolvedAuthProfileId });
    authCredential = resolvedAuth?.credential ?? authStore.profiles[resolvedAuthProfileId];
    if (
      backendAuthPolicy?.strictSelectedProfile &&
      (!authCredential ||
        (authCredential.type === "oauth" && !hasUsableOAuthCredential(authCredential)))
    ) {
      throw profileResolutionError(resolvedAuth?.provider ?? params.provider);
    }
    if (resolvedAuth && authCredential) {
      effectiveAuthProfileId = resolvedAuthProfileId;
      resolvedProfileAuth = {
        apiKey: resolvedAuth.apiKey,
        profileId: resolvedAuthProfileId,
        source: `profile:${resolvedAuthProfileId}`,
        mode: resolvedAuth.profileType === "api_key" ? "api-key" : resolvedAuth.profileType,
      };
      // Apply resolved strings only to static credentials with secret refs.
      // OAuth CLI bridges need raw refreshed fields from the reloaded store.
      if (authCredential.type === "api_key") {
        authCredential = { ...authCredential, key: resolvedAuth.apiKey };
      } else if (authCredential.type === "token") {
        authCredential = { ...authCredential, token: resolvedAuth.apiKey };
      }
    }
  }
  const extraSystemPrompt = params.extraSystemPrompt?.trim() ?? "";
  const bindingFacts = params.cliSessionBindingFacts;
  const bindingExtraSystemPromptStatic =
    bindingFacts?.extraSystemPromptStatic ?? params.extraSystemPromptStatic;
  const baseExtraSystemPromptHash =
    bindingExtraSystemPromptStatic !== undefined
      ? hashCliSessionText(bindingExtraSystemPromptStatic.trim() || undefined)
      : hashCliSessionText(extraSystemPrompt);
  const requireExplicitMessageTarget =
    params.requireExplicitMessageTarget ?? isSubagentSessionKey(params.sessionKey);
  const hasCliSessionBindingFacts = bindingFacts !== undefined;
  // Per-turn background restrictions must not replace the session-stable binding policy.
  const bindingRequireExplicitMessageTarget =
    bindingFacts?.requireExplicitMessageTarget ??
    (hasCliSessionBindingFacts
      ? isSubagentSessionKey(params.sessionKey)
      : requireExplicitMessageTarget);
  const bindingSourceReplyDeliveryMode = hasCliSessionBindingFacts
    ? bindingFacts.sourceReplyDeliveryMode
    : params.sourceReplyDeliveryMode;
  const hasBindingMessageToolPolicy =
    bindingSourceReplyDeliveryMode !== undefined ||
    bindingRequireExplicitMessageTarget ||
    (bindingFacts ?? params).requireExplicitMessageTarget !== undefined;
  const messageToolPolicyHash = hasBindingMessageToolPolicy
    ? hashCliSessionText(
        JSON.stringify({
          sourceReplyDeliveryMode: bindingSourceReplyDeliveryMode,
          requireExplicitMessageTarget: bindingRequireExplicitMessageTarget,
        }),
      )
    : undefined;

  const modelId = (params.model ?? "default").trim() || "default";
  const modelProvider =
    normalizeOptionalString(params.modelProvider) ??
    normalizeOptionalString(params.provider) ??
    params.provider;
  const normalizedCatalogModel = normalizeCliModel(modelId, backendResolved.config);
  const normalizedModel =
    backendResolved.resolveModelId?.({
      modelId: normalizedCatalogModel,
      contextWindow: params.contextWindow,
    }) ?? normalizedCatalogModel;
  const {
    fingerprint: questionFingerprint,
    bindQuestionAnswerAuthority,
    bindQuestionAnswerAuthorityForSession,
  } = await callerToolAuthority.bindQuestions({ provider: modelProvider, model: modelId }, () =>
    readRunOperatorAuthority(params),
  );
  if (callerToolAuthority.hasReplyOperation) {
    params = { ...params, toolAuthorityFingerprint: questionFingerprint };
  }
  const modelDisplay = `${params.provider}/${modelId}`;
  let openClawHistoryMessages: unknown[] | undefined;
  const loadOpenClawHistoryMessages = async () => {
    openClawHistoryMessages ??= await loadCliSessionHistoryMessages(params);
    return openClawHistoryMessages;
  };
  const promptBuildHookContext = {
    runId: params.runId,
    agentId: sessionAgentId,
    sessionKey: params.sessionKey,
    sessionId: params.sessionId,
    workspaceDir,
    modelProviderId: params.provider,
    modelId,
    trigger: params.trigger,
    inputProvenance: params.inputProvenance,
    ...buildAgentHookContextChannelFields(params),
  };
  const promptBuildHookRunner = skipsTurnPreparation ? undefined : getGlobalHookRunner();
  let promptBuildHookResult: ResolvedPromptBuildHookResult | undefined;
  if (!skipsTurnPreparation) {
    try {
      promptBuildHookResult = await resolvePromptBuildHookResult({
        config: runConfig,
        prompt: params.prompt,
        messages: await loadOpenClawHistoryMessages(),
        hookCtx: promptBuildHookContext,
        hookRunner: promptBuildHookRunner,
      });
    } catch (error) {
      cliBackendLog.warn(`cli prompt-build hook preparation failed: ${String(error)}`);
    }
  }
  const promptBuildToolsAllow = mergeForcedEmbeddedAttemptToolsAllow(
    promptBuildHookResult?.toolsAllow,
    {
      forceMessageTool: messageToolOwnsVisibleReply({
        sourceReplyDeliveryMode: bindingSourceReplyDeliveryMode,
      }),
    },
  );
  const promptBuildRestrictsTools =
    promptBuildToolsAllow !== undefined &&
    !promptBuildToolsAllow.some((toolName) => normalizeToolPolicyName(toolName) === "*");
  const isClaudeCli = isClaudeCliBackendId(params.provider);
  const requestedContextModelId = isClaudeCli ? resolveClaudeCliContextModelId(modelId) : modelId;
  const normalizedContextModelId = isClaudeCli
    ? resolveClaudeCliContextModelId(normalizedCatalogModel)
    : normalizedCatalogModel;
  // Aliases can map a canonical id to a CLI shorthand or a user shorthand to
  // a canonical id. Resolve both identities and keep the safest owned limit.
  const contextModelIds = uniqueStrings([requestedContextModelId, normalizedContextModelId]);
  const contextTokenCandidates = contextModelIds
    .map((model) =>
      resolveContextTokensForModel({
        cfg: params.config,
        provider: params.provider,
        modelProvider: backendResolved.modelProvider,
        model,
        modelContextWindow: params.modelContextWindow,
        modelContextTokens: params.modelContextTokens,
        allowAsyncLoad: false,
        // A same-name API model may have a different native window from this CLI runtime.
        allowUnscopedModelLookup: false,
      }),
    )
    .filter((tokens) => tokens !== undefined);
  let modelContextTokens = contextTokenCandidates.length
    ? Math.min(...contextTokenCandidates)
    : DEFAULT_CONTEXT_TOKENS;
  // Session-selectable context windows (catalog `contextWindows`, e.g. Claude
  // CLI 200k/1m) cap the resolved window here: the fixed provider contract in
  // resolveAnthropicFixedContextWindow deliberately ignores catalog scalars,
  // so the selected (or default) option must apply after it or a 200k session
  // would auto-compact against a 1M budget.
  const modelCatalog = overlayConfiguredModelCatalog({
    catalog: loadManifestModelCatalog({ config: runConfig, workspaceDir }),
    config: runConfig,
    workspaceDir,
  });
  const { selectableContextEntry, providerThinkingLevel } = resolveCliCatalogCapabilities({
    catalog: modelCatalog,
    provider: params.provider,
    modelProvider: backendResolved.modelProvider,
    modelId,
    normalizedModel: normalizedCatalogModel,
    agentRuntime: backendResolved.id,
    thinkLevel: params.thinkLevel,
  });
  if (selectableContextEntry) {
    const contextWindowProfile = resolveModelContextWindowProfile({
      catalogEntry: selectableContextEntry,
      selected: params.contextWindow,
    });
    // Only an effective option caps the window; the bare catalog scalar stays
    // subordinate to the fixed provider contract above.
    if (contextWindowProfile.contextWindow && contextWindowProfile.contextTokens !== undefined) {
      modelContextTokens = Math.min(modelContextTokens, contextWindowProfile.contextTokens);
    }
  }
  const resolvedContextWindowInfo = resolveContextWindowInfo({
    cfg: params.config,
    provider: params.provider,
    modelId,
    modelContextTokens,
    defaultTokens: DEFAULT_CONTEXT_TOKENS,
  });
  // The generic guard rechecks the requested id in config. An alias target may
  // have a tighter owned limit, so the alias-aware result remains an upper bound.
  const contextWindowInfo =
    resolvedContextWindowInfo.tokens > modelContextTokens
      ? { tokens: modelContextTokens, source: "model" as const }
      : resolvedContextWindowInfo;
  const autoReseedHistoryChars = isClaudeCli
    ? resolveAutoCliSessionReseedHistoryChars(contextWindowInfo.tokens)
    : undefined;

  const sessionLabel = params.sessionKey ?? params.sessionId;
  const { bootstrapFiles, contextFiles: resolvedContextFiles } = skipsTurnPreparation
    ? { bootstrapFiles: [], contextFiles: [] }
    : await resolveBootstrapContextForRunImpl({
        workspaceDir: params.bootstrapWorkspaceDir ?? workspaceDir,
        config: params.config,
        sessionKey: params.sessionKey,
        sessionId: params.sessionId,
        bootstrapUserProfileId: params.bootstrapUserProfileId,
        chatType: runtimeChatType,
        agentId: sessionAgentId,
        contextMode: params.bootstrapContextMode,
        runKind: params.bootstrapContextRunKind,
        warn: makeBootstrapWarnImpl({
          sessionLabel,
          workspaceDir,
          warn: (message) => cliBackendLog.warn(message),
        }),
      });
  // Mirror the embedded runner's bootstrap routing for backends that transport
  // OpenClaw's system prompt. Only a declared native-tool backend can complete
  // the file-based ritual; other backends receive limited guidance.
  const canonicalWorkspace = resolveUserPath(
    resolveAgentWorkspaceDir(params.config ?? {}, workspaceResolution.agentId),
  );
  const selectedNativeToolsProvideFileAccess =
    params.cliToolAvailability === undefined || params.cliToolAvailability.native.length > 0;
  const hasBootstrapFileAccess =
    (backendResolved.nativeToolMode === "always-on" ||
      backendResolved.nativeToolMode === "selectable") &&
    selectedNativeToolsProvideFileAccess &&
    params.disableTools !== true;
  const bootstrapRouting =
    skipsTurnPreparation || !canTransportSystemPrompt(backendResolved.config)
      ? undefined
      : await resolveWorkspaceBootstrapRouting({
          isWorkspaceBootstrapPending: isWorkspaceBootstrapPendingImpl,
          bootstrapFiles,
          bootstrapFilesProvideAccess: false,
          bootstrapContextRunKind: params.bootstrapContextRunKind,
          trigger: params.trigger,
          sessionKey: params.sessionKey,
          isPrimaryRun: isPrimaryBootstrapRun(params.sessionKey),
          isCanonicalWorkspace: canonicalWorkspace === resolvedWorkspace,
          effectiveWorkspace: workspaceDir,
          resolvedWorkspace,
          hasBootstrapFileAccess,
        });
  const bootstrapMode = bootstrapRouting?.bootstrapMode ?? "none";
  const includeBootstrapInSystemContext = bootstrapRouting?.includeBootstrapInSystemContext ?? true;
  const contextFiles = includeBootstrapInSystemContext
    ? resolvedContextFiles
    : resolvedContextFiles.filter((file) => !/(^|[\\/])BOOTSTRAP\.md$/iu.test(file.path.trim()));
  const bootstrapFilesForInjectionStats = includeBootstrapInSystemContext
    ? bootstrapFiles
    : bootstrapFiles.filter((file) => file.name !== DEFAULT_BOOTSTRAP_FILENAME);
  const bootstrapInjectionStats = buildBootstrapInjectionStats({
    bootstrapFiles: bootstrapFilesForInjectionStats,
    injectedFiles: contextFiles,
  });
  const {
    bootstrapAnalysis,
    bootstrapMaxChars,
    bootstrapPromptWarning,
    bootstrapPromptWarningMode,
    bootstrapTotalMaxChars,
  } = buildBootstrapBudgetState({
    config: params.config,
    agentId: sessionAgentId,
    files: bootstrapInjectionStats,
    seenSignatures: params.bootstrapPromptWarningSignaturesSeen,
    previousSignature: params.bootstrapPromptWarningSignature,
  });
  const bootstrapTruncationNotice = buildBootstrapPromptWarningNotice(bootstrapPromptWarning.lines);
  // Ring-zero OpenClaw runs replace the bundle MCP surface entirely: no
  // loopback server, no plugin/user servers. A selectable backend also removes
  // its native tools, leaving only this openclaw stdio server.
  const systemAgentMcpConfig = internalParams.systemAgentTool
    ? buildSystemAgentToolsMcpServerConfig(internalParams.systemAgentTool)
    : undefined;
  const canUseGatewayTools = !nodeClaudePlacement && !skipsTurnPreparation && !systemAgentMcpConfig;
  const bundleMcpEnabled =
    canUseGatewayTools && backendResolved.bundleMcp && params.disableTools !== true;
  let mcpLoopbackRuntime = bundleMcpEnabled ? getActiveMcpLoopbackRuntime() : undefined;
  if (bundleMcpEnabled && !mcpLoopbackRuntime) {
    try {
      await ensureMcpLoopbackServer();
    } catch (error) {
      throw new Error(
        `Bundled MCP is enabled, but the OpenClaw MCP loopback server failed to start: ${String(error)}`,
        { cause: error },
      );
    }
    mcpLoopbackRuntime = getActiveMcpLoopbackRuntime();
  }
  if (bundleMcpEnabled && !mcpLoopbackRuntime) {
    throw new Error(
      "Bundled MCP is enabled, but the OpenClaw MCP loopback server did not publish a runtime after startup.",
    );
  }
  const { nodeWorkshopEnabled, hostOwnedTools } = mcp.resolveCliMcpToolOwnership(params, {
    backend: backendResolved,
    enabled: bundleMcpEnabled,
    nodePlacement: nodeClaudePlacement,
    skipPreparation: skipsTurnPreparation,
  });
  const shouldMaterializeRuntimePolicy =
    runtimeToolsAllowPolicy !== undefined && canUseGatewayTools && params.disableTools !== true;
  const skillLibraryAuthoring: RunCliAgentParams["skillLibraryAuthoring"] =
    nodeWorkshopEnabled && params.skillLibraryAuthoring
      ? { ...params.skillLibraryAuthoring, defaultTarget: "personal" }
      : params.skillLibraryAuthoring;
  const mcpContextBase =
    mcpLoopbackRuntime || shouldMaterializeRuntimePolicy || nodeWorkshopEnabled
      ? buildCliMcpGrantContext({
          run: { ...params, workspaceDir },
          config: runConfig,
          requireExplicitMessageTarget,
          agentId: sessionAgentId,
          runtimePolicyAgentId: params.runtimePolicySessionKey ? policyAgentId : undefined,
          modelProvider,
          modelId,
        })
      : undefined;
  const mcpToolAuthAgentDir = mcpContextBase
    ? resolveRuntimeAuthProfileAgentDir(agentDir)
    : undefined;
  const mcpToolAuth = mcpContextBase
    ? {
        ...(mcpToolAuthAgentDir ? { agentDir: mcpToolAuthAgentDir } : {}),
        store: authStore ?? loadScopedAuthStore(),
      }
    : undefined;
  params.assertCurrent?.();
  const mcpProjection = mcpContextBase
    ? await mcp.prepareCliMcpToolProjection(params, {
        agentId: workspaceResolution.agentId,
        context: mcpContextBase,
        runtimeToolsAllowPolicy,
        defaultMediatedToolNames: hostOwnedTools,
        scope: {
          cfg: runConfig,
          ...(skillLibraryAuthoring ? { skillLibraryAuthoring } : {}),
          ...(mcpToolAuth ? { authProfileStore: mcpToolAuth.store } : {}),
          ...(mcpToolAuth?.agentDir ? { authProfileStoreAgentDir: mcpToolAuth.agentDir } : {}),
        },
        resolvePolicyTools: resolveMcpLoopbackPolicyTools,
        resolveScopedTools: resolveMcpLoopbackScopedTools,
      })
    : { params, tools: [] };
  params = mcpProjection.params;
  params.assertCurrent?.();
  const hookFilteredProjectedTools = applyEmbeddedAttemptToolsAllow(
    mcpProjection.tools,
    promptBuildToolsAllow,
  );
  if (
    promptBuildRestrictsTools &&
    (backendResolved.nativeToolMode === "always-on" ||
      (backendResolved.nativeToolMode === "selectable" && !canEnforceExactToolAvailability))
  ) {
    throw new Error(
      `CLI backend "${backendResolved.id}" cannot enforce before_prompt_build tool restrictions. Use a backend with exact tool availability or remove the hook restriction. OpenClaw did not start the run.`,
    );
  }
  if (
    (promptBuildRestrictsTools &&
      params.cliToolAvailability === undefined &&
      backendResolved.nativeToolMode === "selectable") ||
    shouldMaterializeRuntimePolicy
  ) {
    params = {
      ...params,
      cliToolAvailability: {
        native: [],
        openClaw: hookFilteredProjectedTools.map((tool) => tool.name),
      },
    };
  }
  if (params.cliToolAvailability && promptBuildToolsAllow !== undefined) {
    const filterToolNames = (names: string[]) =>
      applyEmbeddedAttemptToolsAllow(
        names.map((name) => ({ name })),
        promptBuildToolsAllow,
      ).map((tool) => tool.name);
    params = {
      ...params,
      cliToolAvailability: {
        native: filterToolNames(params.cliToolAvailability.native),
        openClaw: filterToolNames(params.cliToolAvailability.openClaw),
      },
    };
  }
  const projectedTools = applyEmbeddedAttemptToolsAllow(
    hookFilteredProjectedTools,
    params.cliToolAvailability?.openClaw,
  );
  const nodeSkillWorkshop = nodeWorkshopEnabled
    ? projectedTools.find((tool) => tool.name === "skill_workshop")
    : undefined;
  const promptTools = bundleMcpEnabled
    ? projectedTools
    : nodeSkillWorkshop
      ? [nodeSkillWorkshop]
      : [];
  const authorizedPromptBuildResult = await (async () => {
    const toolAuthorityFingerprint = params.toolAuthorityFingerprint;
    if (!promptBuildHookRunner || !toolAuthorityFingerprint) {
      return undefined;
    }
    const admittedParams = await admitCliRunParams(params, workspaceResolution.agentId);
    params = admittedParams;
    const assertHostActive = resolveAdmittedRunActiveAssertion(
      admittedParams.admittedRunContext,
      admittedParams.abortSignal,
    );
    if (!assertHostActive) {
      return undefined;
    }
    try {
      return await promptBuildHookRunner.runAuthorizedPromptBuild(
        {
          prompt: params.prompt,
          messages: await loadOpenClawHistoryMessages(),
        },
        promptBuildHookContext,
        {
          toolAuthorityFingerprint,
          activeToolNames: promptTools.map((tool) => tool.name),
          assertHostActive,
        },
      );
    } catch (error) {
      cliBackendLog.warn(`authorized CLI prompt-build hook failed: ${String(error)}`);
      return undefined;
    }
  })();
  params.assertCurrent?.();
  const messageToolAvailable = promptTools.some(
    (tool) => normalizeToolPolicyName(tool.name) === "message",
  );
  const resultContentSourceByToolName = new Map(
    promptTools.flatMap((tool) =>
      tool.resultContentSource ? [[tool.name, tool.resultContentSource] as const] : [],
    ),
  );
  const { mcpGrant, projectNativeToolAuthority, exclusiveTools } = mcp.prepareCliMcpGrant(params, {
    context: mcpContextBase,
    tools: projectedTools,
    promptBuildRestrictsTools,
    hostOwnedTools,
    nativeAuthorityAllowed: !skipsTurnPreparation && !nodeClaudePlacement,
    projectNativeToolAuthority: backendResolved.projectNativeToolAuthority,
  });
  const toolBoundExtraSystemPromptHash = params.cliToolAvailability
    ? hashCliSessionText(
        JSON.stringify([
          baseExtraSystemPromptHash ?? null,
          params.cliToolAvailability.native.toSorted(),
          params.cliToolAvailability.openClaw.toSorted(),
        ]),
      )
    : baseExtraSystemPromptHash;
  const extraSystemPromptHash = resolveCliBootstrapPromptHash({
    baseHash: toolBoundExtraSystemPromptHash,
    bootstrapMode,
    bootstrapTruncationNotice,
    contextFiles,
  });
  let cleanupPreparedResources: (() => Promise<void>) | undefined;
  let preparedExecution: PrivateCliBackendPreparedExecution | undefined;
  try {
    const mcpClientGrant =
      mcpLoopbackRuntime && mcpGrant
        ? mintMcpLoopbackClientGrant({
            ...mcpGrant,
            runtimeOwnerToken: mcpLoopbackRuntime.ownerToken,
            bindQuestionAnswerAuthority: (assertActive) =>
              bindQuestionAnswerAuthorityForSession(mcpGrant.context.sessionKey, assertActive),
            ...(skillLibraryAuthoring ? { skillLibraryAuthoring } : {}),
            ...(mcpToolAuth ? { toolAuth: mcpToolAuth } : {}),
          })
        : undefined;
    const bindMcpClientGrantAdmission = (
      admittedRunContext: NonNullable<RunCliAgentParams["admittedRunContext"]>,
    ) => {
      if (
        mcpClientGrant &&
        mcpLoopbackRuntime &&
        !bindMcpLoopbackClientGrantAdmission({
          token: mcpClientGrant.token,
          runtimeOwnerToken: mcpLoopbackRuntime.ownerToken,
          admittedRunContext,
        })
      ) {
        throw new Error("CLI MCP client grant is no longer valid for this admitted run");
      }
    };
    const mcpClientGrantCapture =
      mcpClientGrant && mcpLoopbackRuntime
        ? (() => {
            let activeToken = mcpClientGrant.token;
            let activeCapture: ReturnType<typeof activateMcpLoopbackClientGrantCapture> = false;
            return {
              transportToken: mcpClientGrant.token,
              adoptProcessToken: (processToken: string) => {
                if (activeToken === processToken) {
                  return;
                }
                if (
                  !transferMcpLoopbackClientGrant({
                    sourceToken: mcpClientGrant.token,
                    targetToken: processToken,
                    runtimeOwnerToken: mcpLoopbackRuntime.ownerToken,
                  })
                ) {
                  throw new Error(
                    "CLI MCP client grant could not transfer onto the live process bearer",
                  );
                }
                activeToken = processToken;
              },
              revokeProcessToken: () => {
                revokeMcpLoopbackClientGrant(activeToken);
              },
              activate: (captureKey: string, assertCurrent: () => void) => {
                const activated = activateMcpLoopbackClientGrantCapture({
                  token: activeToken,
                  runtimeOwnerToken: mcpLoopbackRuntime.ownerToken,
                  captureKey,
                  assertCurrent,
                });
                if (!activated) {
                  throw new Error(
                    "CLI MCP client grant is no longer valid for this Gateway runtime",
                  );
                }
                activeCapture = activated;
              },
              deactivate: (captureKey: string) => {
                deactivateMcpLoopbackClientGrantCapture({
                  token: activeToken,
                  runtimeOwnerToken: mcpLoopbackRuntime.ownerToken,
                  captureKey,
                });
              },
              ...(projectNativeToolAuthority
                ? {
                    captureNativeTools: (tools: unknown) => {
                      params.assertCurrent?.();
                      params.abortSignal?.throwIfAborted();
                      if (!activeCapture || !activeCapture.captureNativeToolAuthority(null)) {
                        throw new Error("Native tool authority capture is no longer active.");
                      }
                      if (
                        !Array.isArray(tools) ||
                        !tools.every((name): name is string => typeof name === "string")
                      ) {
                        throw new Error(
                          "Native runtime reported an invalid tool list; start a fresh session.",
                        );
                      }
                      const selected = params.cliToolAvailability?.native;
                      const capabilities = projectNativeToolAuthority(
                        selected ? tools.filter((name) => selected.includes(name)) : tools,
                      );
                      assertNativeCronCreatorCapabilities(capabilities);
                      const allowed = resolveCliNativeWebSearchEnabled(params, backendResolved)
                        ? capabilities
                        : capabilities.filter((name) => name !== "web_search");
                      if (!activeCapture.captureNativeToolAuthority(allowed)) {
                        throw new Error("Native tool authority capture is no longer active.");
                      }
                    },
                  }
                : {}),
            };
          })()
        : undefined;
    let mcpClientGrantRevoked = false;
    const cleanupMcpClientGrant = mcpClientGrant
      ? async () => {
          if (mcpClientGrantRevoked) {
            return;
          }
          mcpClientGrantRevoked = true;
          revokeMcpLoopbackClientGrant(mcpClientGrant.token);
        }
      : undefined;
    cleanupPreparedResources = cleanupMcpClientGrant;
    const rawLoopbackServerConfig = mcpLoopbackRuntime
      ? createMcpLoopbackServerConfig(mcpLoopbackRuntime.port)
      : undefined;
    const loopbackServerConfig =
      rawLoopbackServerConfig && backendResolved.bundleMcpMode === "claude-config-file"
        ? applyClaudeManagedMcpTimeout(rawLoopbackServerConfig)
        : rawLoopbackServerConfig;
    const nativeMcpCapabilityProfile = mcp.resolveCliNativeMcpPolicy(params, {
      config: runConfig,
      policySessionKey,
      policyAgentId,
      modelProvider,
      modelId,
      workspaceDir,
      cwd,
      runtimeToolsAllowPolicy,
    });
    const preparedBackend = await prepareCliBundleMcpConfig({
      enabled: bundleMcpEnabled || systemAgentMcpConfig !== undefined,
      mode: backendResolved.bundleMcpMode,
      backend: backendResolved.config,
      workspaceDir,
      config: params.config,
      toolOverrides: params.toolOverrides,
      agentDir,
      // Restricted runs serve only the loopback server; merging user/plugin
      // MCP servers would let the run reach tools outside its allowlist.
      ...(systemAgentMcpConfig
        ? { exclusiveConfig: systemAgentMcpConfig }
        : exclusiveTools && loopbackServerConfig
          ? { exclusiveConfig: loopbackServerConfig }
          : {}),
      additionalConfig: exclusiveTools ? undefined : loopbackServerConfig,
      env:
        mcpLoopbackRuntime && mcpClientGrant
          ? {
              OPENCLAW_MCP_TOKEN: mcpClientGrant.token,
              OPENCLAW_MCP_CLI_CAPTURE_KEY: "",
            }
          : undefined,
      warn: (message) => cliBackendLog.warn(message),
      ...(!systemAgentMcpConfig && !exclusiveTools
        ? {
            nativeMcpPolicy: {
              sessionId: params.sessionId,
              ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
              capabilityProfile: nativeMcpCapabilityProfile,
              ...(runtimeToolsAllowPolicy !== undefined
                ? { runtimeToolsAllow: runtimeToolsAllowPolicy }
                : {}),
            },
          }
        : {}),
    });
    const cleanupPreparedBackend = sequenceCliCleanups(
      preparedBackend.cleanup && (() => preparedBackend.cleanup?.()),
      cleanupMcpClientGrant,
    );
    cleanupPreparedResources = cleanupPreparedBackend;
    const prepareExecutionContext = {
      config: params.config,
      workspaceDir,
      agentDir,
      provider: params.provider,
      modelId,
      ...(params.contextWindow ? { contextWindow: params.contextWindow } : {}),
      contextTokenBudget: contextWindowInfo.tokens,
      thinkingLevel: providerThinkingLevel,
      authProfileId: effectiveAuthProfileId,
      executionMode,
      toolAvailability: params.cliToolAvailability,
      env: preparedBackend.env,
      // Bundled owners may project this through a native per-process system-prompt
      // channel. Keep it private so exact isolated inference does not expand the SDK.
      ...(params.isolatedCompletion
        ? {
            isolatedCompletionCwd: cwd,
            isolatedCompletionModelId: normalizedModel,
            isolatedCompletionPrompt: params.prompt,
            isolatedCompletionSystemPrompt: params.extraSystemPrompt ?? "",
          }
        : {}),
    } satisfies Parameters<NonNullable<typeof backendResolved.prepareExecution>>[0];
    try {
      params.assertCurrent?.();
      // Only bundled backends receive this private credential bridge.
      const backendPrepareContext = backendAuthPolicy
        ? { ...prepareExecutionContext, authCredential }
        : prepareExecutionContext;
      preparedExecution =
        (await backendResolved.prepareExecution?.(backendPrepareContext)) ?? undefined;
    } catch (error) {
      if (error instanceof CliBackendAuthProfilePreparationError && effectiveAuthProfileId) {
        // Preserve the selected-profile fact across lazy plugin preparation so
        // the generic runner can settle it once without backend-owned writes.
        throw new CliAuthProfilePreparationError({
          message: error.message,
          profileId: effectiveAuthProfileId,
          provider: authStore?.profiles[effectiveAuthProfileId]?.provider ?? params.provider,
          agentDir,
          cause: error,
        });
      }
      throw error;
    }
    const pluginExecutionConsumer = retainCliPluginExecutionConsumer(preparedExecution?.execute);
    const cleanupExecution = () => preparedExecution?.cleanup?.();
    const preparedBackendCleanup = sequenceCliCleanups(
      pluginExecutionConsumer
        ? () => pluginExecutionConsumer.run(cleanupExecution)
        : preparedExecution?.cleanup && cleanupExecution,
      cleanupPreparedBackend,
      pluginExecutionConsumer && (() => pluginExecutionConsumer.release()),
    );
    cleanupPreparedResources = preparedBackendCleanup;
    params.assertCurrent?.();
    if (params.isolatedCompletion && preparedExecution?.isolatedCompletionEnforced !== true) {
      throw unsupportedIsolatedCompletionError(backendResolved.id);
    }
    if (
      params.cliToolAvailability &&
      backendResolved.toolAvailabilityEnforcement === "prepare-execution" &&
      preparedExecution?.toolAvailabilityEnforced !== true
    ) {
      throw new Error(
        `CLI backend ${backendResolved.id} did not enforce exact per-run tool availability during execution preparation`,
      );
    }
    const skipLocalCredentialEpoch = Boolean(
      backendResolved.authEpochMode === "profile-only" &&
      effectiveAuthProfileId &&
      authCredential &&
      preparedExecution,
    );
    const authEpoch = await resolveCliAuthEpoch({
      provider: params.provider,
      agentDir,
      authProfileId: effectiveAuthProfileId,
      skipLocalCredential: skipLocalCredentialEpoch,
    });
    const authBindingFingerprint = params.onSuccessfulAuthBinding
      ? resolveCliAuthBindingFingerprint({
          provider: params.provider,
          config: runConfig,
          agentDir,
          ...(effectiveAuthProfileId ? { authProfileId: effectiveAuthProfileId } : {}),
          ...(resolvedProfileAuth ? { resolvedAuth: resolvedProfileAuth } : {}),
          ...(skipLocalCredentialEpoch ? { skipLocalCredential: true } : {}),
        })
      : undefined;
    const preparedBackendEnv =
      preparedExecution?.env && Object.keys(preparedExecution.env).length > 0
        ? { ...preparedBackend.env, ...preparedExecution.env }
        : preparedBackend.env;
    const preparedBackendBeforeExecution =
      preparedBackend.beforeExecution || preparedExecution?.beforeExecution
        ? async () => {
            await preparedBackend.beforeExecution?.();
            await preparedExecution?.beforeExecution?.();
          }
        : undefined;
    const claudeSkillsPlugin =
      skipsTurnPreparation || nodeClaudePlacement
        ? { args: [], cleanup: async () => {} }
        : await prepareClaudeCliSkillsPlugin({
            backendId: backendResolved.id,
            skillsSnapshot: params.skillsSnapshot,
          });
    let claudeSkillsPluginClaimed = false;
    const claimLiveSessionResources =
      claudeSkillsPlugin.args.length > 0
        ? () => {
            if (claudeSkillsPluginClaimed) {
              return undefined;
            }
            claudeSkillsPluginClaimed = true;
            return claudeSkillsPlugin.cleanup;
          }
        : undefined;
    const preparedCleanup = sequenceCliCleanups(
      preparedBackendCleanup || claudeSkillsPlugin.args.length > 0
        ? async () => {
            if (!claudeSkillsPluginClaimed) {
              await claudeSkillsPlugin.cleanup();
            }
          }
        : undefined,
      preparedBackendCleanup,
    );
    cleanupPreparedResources = preparedCleanup;
    const preparedBackendClearEnv = [
      ...(preparedBackend.backend.clearEnv ?? []),
      ...(preparedExecution?.clearEnv ?? []),
    ];
    const { liveSession: _liveSession, ...processPerTurnBackend } = preparedBackend.backend;
    const preparedBackendFinal = {
      ...preparedBackend,
      backend: {
        ...(isSideQuestion
          ? { ...processPerTurnBackend, sessionMode: "none" as const }
          : params.disableCliLiveSession
            ? processPerTurnBackend
            : preparedBackend.backend),
        ...(preparedBackendClearEnv.length > 0
          ? { clearEnv: uniqueStrings(preparedBackendClearEnv) }
          : {}),
      },
      ...(preparedBackendEnv ? { env: preparedBackendEnv } : {}),
      ...(preparedBackendBeforeExecution
        ? { beforeExecution: preparedBackendBeforeExecution }
        : {}),
      ...(claimLiveSessionResources ? { claimLiveSessionResources } : {}),
      ...(preparedExecution?.secretInput ? { secretInput: preparedExecution.secretInput } : {}),
      ...(mcpClientGrantCapture ? { mcpClientGrantCapture } : {}),
      ...(preparedCleanup ? { cleanup: preparedCleanup } : {}),
    };
    const executionTarget = resolveCliExecutionTarget({
      params,
      backendId: backendResolved.id,
      execute: preparedExecution?.execute,
    });
    const promptToolNamesHash = bundleMcpEnabled
      ? hashCliSessionText(JSON.stringify(promptTools.map((tool) => tool.name).toSorted()))
      : undefined;
    // `sessionMode: none` may still use a live transport in-process, but neither a
    // returned nor previously stored id is authority for cross-process continuity.
    const ignoreCliSessionCandidate = preparedBackendFinal.backend.sessionMode === "none";
    // Native controls target the already-owned transcript without rebuilding its turn-time MCP
    // topology. Re-validating that topology here would discard the session being compacted.
    const controlOperationCliSessionId = isControlOperation
      ? params.cliSessionBinding?.sessionId?.trim() || params.cliSessionId?.trim()
      : undefined;
    const reusableCliSessionCandidate: CliReusableSession = ignoreCliSessionCandidate
      ? { mode: "none" }
      : controlOperationCliSessionId
        ? { mode: "reuse", sessionId: controlOperationCliSessionId }
        : params.cliSessionBinding
          ? resolveCliSessionReuse({
              binding: params.cliSessionBinding,
              authProfileId: effectiveAuthProfileId,
              authEpoch,
              authEpochVersion: CLI_AUTH_EPOCH_VERSION,
              extraSystemPromptHash,
              messageToolPolicyHash,
              promptToolNamesHash,
              cwdHash,
              mcpConfigHash: preparedBackendFinal.mcpConfigHash,
              mcpResumeHash: preparedBackendFinal.mcpResumeHash,
            })
          : params.cliSessionId
            ? { mode: "reuse", sessionId: params.cliSessionId }
            : { mode: "none" };
    const backendReusableCliSession: CliReusableSession =
      reusableCliSessionCandidate.mode === "reuse-with-drift" &&
      !canTransportSystemPrompt(preparedBackendFinal.backend)
        ? { mode: "invalidate", invalidatedReason: "system-prompt" }
        : reusableCliSessionCandidate;
    const candidateClaudeCliSessionId =
      resolveCliSessionId(backendReusableCliSession)?.trim() || undefined;
    // Control operations must keep the exact native session they were asked to mutate.
    // Ordinary-turn transcript recovery must not turn `/compact` into a fresh session.
    const hasClaudeCliCandidate =
      !isControlOperation &&
      !nodeClaudePlacement &&
      candidateClaudeCliSessionId !== undefined &&
      isClaudeCliBackendId(params.provider);
    const claudeCliTranscriptMissing =
      hasClaudeCliCandidate &&
      !(await claudeCliSessionTranscriptHasContent({
        sessionId: candidateClaudeCliSessionId,
        workspaceDir: cwd,
      }));
    const managedClaudeLiveSessionGeneration =
      claudeCliTranscriptMissing &&
      backendResolved.id === "claude-cli" &&
      "liveSession" in preparedBackendFinal.backend &&
      preparedBackendFinal.backend.liveSession === "claude-stdio" &&
      preparedBackendFinal.backend.output === "jsonl" &&
      preparedBackendFinal.backend.input === "stdin" &&
      getCliLiveSessionGeneration({
        backendId: backendResolved.id,
        agentId: workspaceResolution.agentId,
        sessionId: params.sessionId,
        sessionKey: params.sessionKey,
      });
    const hasManagedClaudeLiveSession = Boolean(managedClaudeLiveSessionGeneration);
    const claudeCliTranscriptOrphanedToolUse =
      hasClaudeCliCandidate &&
      !claudeCliTranscriptMissing &&
      (await claudeCliSessionTranscriptHasOrphanedToolUse({
        sessionId: candidateClaudeCliSessionId,
        workspaceDir: cwd,
      }));
    const claudeCliInvalidatedReason: "missing-transcript" | "orphaned-tool-use" | undefined =
      claudeCliTranscriptMissing && !hasManagedClaudeLiveSession
        ? "missing-transcript"
        : claudeCliTranscriptOrphanedToolUse
          ? "orphaned-tool-use"
          : undefined;
    const reusableCliSession: CliReusableSession = claudeCliInvalidatedReason
      ? { mode: "invalidate", invalidatedReason: claudeCliInvalidatedReason }
      : backendReusableCliSession;
    const reusableCliSessionId = resolveCliSessionId(reusableCliSession);
    const invalidatedReason =
      reusableCliSession.mode === "invalidate" ? reusableCliSession.invalidatedReason : undefined;
    if (invalidatedReason) {
      cliBackendLog.info(
        `cli session reset: provider=${params.provider} reason=${invalidatedReason}`,
      );
    }
    const openClawReferences = skipsTurnPreparation
      ? { docsPath: null, sourcePath: null }
      : await (
          await import("../docs-path.js")
        ).resolveOpenClawReferencePaths({
          workspaceDir,
          argv1: process.argv[1],
          cwd,
          moduleUrl: import.meta.url,
        });
    const skillPreparationParams = params;
    const assertSkillsCurrent = skillPreparationParams.admittedRunContext
      ? createCliRunCurrentAssertion({
          ...skillPreparationParams,
          admittedRunContext: skillPreparationParams.admittedRunContext,
        })
      : () => {
          skillPreparationParams.assertCurrent?.();
          skillPreparationParams.abortSignal?.throwIfAborted();
          skillPreparationParams.preparedRunAdmission?.assertSourceCurrent();
        };
    const preparedSkills =
      skipsTurnPreparation || nodeClaudePlacement || claudeSkillsPlugin.args.length > 0
        ? { prompt: "" }
        : await resolveCliSkillsPrompt({
            assertCurrent: assertSkillsCurrent,
            run: params,
            workspaceDir,
            executionWorkspaceDir: cwd,
            config: params.config,
            agentId: sessionAgentId,
            sessionKey: params.sessionKey?.trim() || params.sessionId,
          });
    assertSkillsCurrent();
    const runtimeChannel = skipsTurnPreparation
      ? undefined
      : normalizeMessageChannel(params.messageChannel ?? params.messageProvider);
    const runtimeCapabilities = skipsTurnPreparation
      ? undefined
      : collectRuntimeChannelCapabilities({
          cfg: params.config,
          channel: runtimeChannel,
          accountId: params.agentAccountId,
        });
    const requesterProfileId = readRunOperatorAuthority(params)?.profileId;
    const builtSystemPrompt = isControlOperation
      ? ""
      : isSideQuestion
        ? extraSystemPrompt
        : await prepareCliSystemPrompt({
            preparedTtsPreferences: params.preparedTtsPreferences,
            requesterProfileId,
            workspaceDir,
            cwd,
            config: params.config,
            extraSystemPrompt,
            sourceReplyDeliveryMode: bindingSourceReplyDeliveryMode,
            requireExplicitMessageTarget: bindingRequireExplicitMessageTarget,
            silentReplyPromptMode: params.silentReplyPromptMode,
            runtimeChannel,
            runtimeChatType,
            runtimeCapabilities,
            ownerNumbers: params.ownerNumbers,
            docsPath: openClawReferences.docsPath ?? undefined,
            sourcePath: openClawReferences.sourcePath ?? undefined,
            skillsPrompt: preparedSkills.prompt,
            tools: promptTools,
            contextFiles,
            bootstrapMode,
            bootstrapTruncationNotice,
            modelDisplay,
            agentId: sessionAgentId,
            sessionKey: params.sessionKey,
            sessionId: params.sessionId,
          });
    const transformedSystemPrompt = !skipsTurnPreparation
      ? (backendResolved.transformSystemPrompt?.({
          config: params.config,
          workspaceDir,
          provider: params.provider,
          modelId,
          modelDisplay,
          agentId: sessionAgentId,
          systemPrompt: builtSystemPrompt,
        }) ?? builtSystemPrompt)
      : builtSystemPrompt;
    const turnRuntimeFacts =
      params.runtimeFactsInTurn && !skipsTurnPreparation
        ? splitSystemPromptRelocatableBoundary(transformedSystemPrompt)
        : undefined;
    let systemPrompt = turnRuntimeFacts?.remainingPrompt ?? transformedSystemPrompt;
    const allowRawTranscriptReseed =
      backendResolved.config.reseedFromRawTranscriptWhenUncompacted === true;
    const historyParams = (params = await admitCliRunParams(params, workspaceResolution.agentId));
    const cliHistoryWriter = !isSideQuestion
      ? await prepareCliHistoryBoundary(historyParams, { credential: authCredential })
      : undefined;
    // Explicit caller-owned memory remains input; it cannot authorize borrowed durable history.
    const historyAllowed = params.sessionManager !== undefined || cliHistoryWriter !== undefined;
    // Native compatibility and transcript account ownership are independent gates.
    const rawTranscriptReseedReason = !historyAllowed
      ? "auth-unknown"
      : reusableCliSessionId
        ? "session-expired"
        : (invalidatedReason ?? (ignoreCliSessionCandidate ? undefined : "missing-transcript"));
    const sessionPromptContext =
      skipsTurnPreparation || params.isolatedCompletion
        ? undefined
        : await loadCliSessionPromptContext({
            ...params,
            allowRawTranscriptReseed,
            rawTranscriptReseedReason,
            nativeSessionId: reusableCliSessionId,
            tools: promptTools,
          });
    const effectiveReplyGuidance =
      skipsTurnPreparation || params.isolatedCompletion
        ? undefined
        : buildHarnessVisibleReplyGuidance({
            sourceReplyDeliveryMode: params.sourceReplyDeliveryMode,
            messageToolAvailable,
            requireExplicitMessageTarget,
          });
    const finalizedTranscriptPrompt =
      (params.finalizePromptForResolvedTools ||
        sessionPromptContext?.durableContext ||
        sessionPromptContext?.sessionGapContext ||
        effectiveReplyGuidance) &&
      params.transcriptPrompt === undefined
        ? params.prompt
        : params.transcriptPrompt;
    let promptContext: CliBackendPromptContext | undefined;
    let promptForHooks: string | undefined;
    let preparedPrompt = isControlOperation
      ? params.prompt
      : (params.finalizePromptForResolvedTools?.({
          prompt: params.prompt,
          messageToolAvailable,
        }) ?? params.prompt);
    if (!isControlOperation && params.skillsSnapshot?.librarySelections?.length) {
      preparedPrompt = remapSkillReferencePaths(preparedPrompt, preparedSkills.usagePaths);
    }
    let historyPromptCurrentTurn = preparedPrompt;
    if (!skipsTurnPreparation) {
      ({
        prompt: preparedPrompt,
        systemPrompt,
        promptContext,
        promptForHooks,
      } = await prepareCliTurnPromptContext({
        configuredTimezone: params.config?.agents?.defaults?.userTimezone,
        prompt: preparedPrompt,
        systemPrompt,
        privateContext: executionTarget.kind === "plugin",
        deliveryGuidance: effectiveReplyGuidance,
        hookResult: promptBuildHookResult,
        prependContext: [
          sessionPromptContext?.durableContext,
          promptBuildHookResult?.prependContext,
          authorizedPromptBuildResult?.prependContext,
        ],
        requesterProfileId,
        capabilityToolNames: new Set(promptTools.map((tool) => tool.name)),
        sessionKey: params.sessionKey,
        agentId: sessionAgentId,
        backend: preparedBackendFinal.backend,
        isNewSession:
          !reusableCliSessionId?.trim() || reusableCliSession.mode === "reuse-with-drift",
        thinkLevel: params.thinkLevel,
        runtimeContextFragments: params.runtimeContextFragments,
        // Caller-owned memory cannot grant access to persisted interrupted inputs.
        sessionTarget: params.isolatedCompletion ? undefined : cliHistoryWriter?.target,
        context: [
          turnRuntimeFacts?.relocatable,
          promptBuildHookResult?.appendContext,
          authorizedPromptBuildResult?.appendContext,
        ],
      }));
      params.assertCurrent?.();
      params.abortSignal?.throwIfAborted();
      const gap = sessionPromptContext?.sessionGapContext;
      const renderCurrentPrompt = createCliCurrentPromptRenderer(params, reusableCliSession, gap);
      const preferResumableText =
        params.currentInboundEventKind === "room_event" && Boolean(reusableCliSessionId);
      historyPromptCurrentTurn = renderCurrentPrompt(preparedPrompt);
      preparedPrompt = renderCurrentPrompt(preparedPrompt, preferResumableText);
      if (promptForHooks !== undefined) {
        promptForHooks = renderCurrentPrompt(promptForHooks, preferResumableText);
      }
    }
    // Node placement keeps history from the Gateway transcript: fresh remote
    // CLI sessions still receive prior conversation context via stdin.
    const shouldPrepareOpenClawHistoryPrompt =
      !skipsTurnPreparation && (!reusableCliSessionId || allowRawTranscriptReseed);
    let openClawHistoryPrompt = shouldPrepareOpenClawHistoryPrompt
      ? buildCliSessionHistoryPrompt({
          messages: sessionPromptContext?.reseedMessages ?? [],
          prompt: historyPromptCurrentTurn,
          maxHistoryChars: autoReseedHistoryChars,
        })
      : undefined;
    const systemPromptWithReplacements = skipsTurnPreparation
      ? systemPrompt
      : applyPluginTextReplacements(systemPrompt, backendResolved.textTransforms?.input);
    // Ensure the cache boundary before appending the model identity so the identity lands in the
    // dynamic suffix, not the cached prefix, for marker-free hook overrides — otherwise an idle
    // turn's prefix (O + identity) diverges from an active media turn's prefix (O) and breaks
    // prompt caching. Skip empty prompts and turns with no identity line, which need no boundary.
    systemPrompt = skipsTurnPreparation
      ? systemPromptWithReplacements
      : appendModelIdentitySystemPrompt({
          systemPrompt:
            buildModelIdentityPromptLine(modelDisplay) &&
            systemPromptWithReplacements.trim().length > 0
              ? ensureSystemPromptCacheBoundary(systemPromptWithReplacements)
              : systemPromptWithReplacements,
          model: modelDisplay,
        });
    const systemPromptReport = buildSystemPromptReport({
      source: "run",
      generatedAt: Date.now(),
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
      provider: params.provider,
      model: modelId,
      workspaceDir,
      bootstrapMaxChars,
      bootstrapTotalMaxChars,
      bootstrapTruncation: buildBootstrapTruncationReportMeta({
        analysis: bootstrapAnalysis,
        warningMode: bootstrapPromptWarningMode,
        warning: bootstrapPromptWarning,
      }),
      sandbox: { mode: "off", sandboxed: false },
      systemPrompt,
      injectedWorkspaceFiles: bootstrapInjectionStats,
      skillsPrompt: preparedSkills.prompt,
      tools: promptTools,
      currentTurn: {
        ...(params.currentInboundEventKind ? { kind: params.currentInboundEventKind } : {}),
        promptChars: preparedPrompt.length,
        runtimeContextChars: [promptContext?.prependContext, promptContext?.appendContext]
          .filter(Boolean)
          .join("\n\n").length,
      },
    });
    const buildPreparedContext = (preparedParams: PreparedCliRunContext["params"]) => ({
      params: preparedParams,
      bindQuestionAnswerAuthority,
      sessionEventSourcePolicy: finalizeCliSessionEventSourcePolicy(
        callerToolAuthority.sessionEventSourcePolicy,
        preparedParams,
        promptBuildToolsAllow,
      ),
      effectiveAuthProfileId,
      ...(authStore ? { authProfileStore: authStore } : {}),
      agentDir,
      started,
      startedMonotonicMs,
      workspaceDir,
      cwd,
      backendResolved,
      hostOwnedTools,
      preparedBackend: preparedBackendFinal,
      ...(loopbackServerConfig &&
      !systemAgentMcpConfig &&
      backendResolved.bundleMcpMode === "claude-config-file"
        ? { managedMcpToolTimeoutMs: CLAUDE_MANAGED_MCP_TIMEOUT_MS }
        : {}),
      executionTarget,
      ...(pluginExecutionConsumer ? { pluginExecutionConsumer } : {}),
      reusableCliSession,
      contextEngineConfig: runConfig,
      modelId,
      normalizedModel,
      providerThinkingLevel,
      contextWindowInfo,
      systemPrompt,
      systemPromptReport,
      claudeSkillsPluginArgs: claudeSkillsPlugin.args,
      ...(cliHistoryWriter ? { cliHistoryWriter } : {}),
      authEpoch,
      authBindingFingerprint,
      ...(skipLocalCredentialEpoch ? { authBindingSkipsLocalCredential: true as const } : {}),
      authEpochVersion: CLI_AUTH_EPOCH_VERSION,
      extraSystemPromptHash,
      messageToolPolicyHash,
      promptToolNamesHash,
      ...(resultContentSourceByToolName.size > 0 ? { resultContentSourceByToolName } : {}),
      cwdHash,
      ...(bundleMcpEnabled ? { mcpDeliveryCapture: true as const } : {}),
    });
    const admitFinalParams = async () => {
      const preparedParams = await admitCliRunParams(
        {
          ...params,
          config: runConfig,
          prompt: preparedPrompt,
          transcriptPrompt: finalizedTranscriptPrompt,
          ...(requireExplicitMessageTarget ? { requireExplicitMessageTarget: true } : {}),
        },
        workspaceResolution.agentId,
      );
      bindMcpClientGrantAdmission(preparedParams.admittedRunContext);
      if (!isControlOperation) {
        recordAdmittedModelRoutingDecision({
          admittedRunContext: preparedParams.admittedRunContext,
          abortSignal: preparedParams.abortSignal,
          requestedProvider:
            params.modelRoutingProvenance?.requestedProvider ??
            params.modelProvider ??
            params.provider,
          requestedModel:
            params.modelRoutingProvenance?.requestedModel ?? params.model ?? "default",
          selectedProvider: params.modelProvider ?? params.provider,
          selectedModel: normalizedModel,
          selectionMode: requestedAuthProfileId ? "explicit" : "automatic",
          credentialProfileId: effectiveAuthProfileId,
          fallbackSelected: params.modelRoutingProvenance?.stage === "fallback",
          fallbackReason: params.modelRoutingProvenance?.fallbackReason,
        });
      }
      return preparedParams;
    };
    if (skipsTurnPreparation) {
      const preparedParams = await admitFinalParams();
      return { ...buildPreparedContext(preparedParams), hadSessionFile: false };
    }
    // Context remains session-owned. Trusted helper runs may borrow a different
    // agentDir only for model/auth execution.
    const contextEngineAgentDir = resolveAgentDir(runConfig, sessionAgentId);
    const contextEngineHostSupport = buildGenericCliContextEngineHostSupport({
      backendId: backendResolved.id,
      capabilities: backendResolved.contextEngineHostCapabilities,
    });
    let resolvedContextEngine;
    let deferContextEngineDisposalUntil: PreparedCliRunContext["deferContextEngineDisposalUntil"] =
      params.contextEngineLogicalTurnLease?.deferDisposalUntil;
    if (params.contextEngineLogicalTurnLease) {
      const effective = await beginContextEngineLogicalTurn({
        lease: params.contextEngineLogicalTurnLease,
        host: contextEngineHostSupport,
        recorder: params.userTurnTranscriptRecorder,
        isHeartbeat: isHeartbeatLifecycleRunKind(params.bootstrapContextRunKind),
        sessionTarget: params.sessionTarget,
      });
      resolvedContextEngine = effective.engine;
    } else {
      const trackDisposal = captureAsyncWorkTracker();
      const ownedEngine = await resolveContextEngine(runConfig, {
        initialize: ensureContextEnginesInitialized,
        agentDir: contextEngineAgentDir,
        workspaceDir,
      });
      resolvedContextEngine = ownedEngine;
      const disposalHolds = new Set<Promise<void>>();
      deferContextEngineDisposalUntil = (promise: Promise<void>) => {
        disposalHolds.add(promise);
        void promise.finally(() => disposalHolds.delete(promise)).catch(() => {});
      };
      cleanupPreparedResources = sequenceCliCleanups(async () => {
        if (disposalHolds.size > 0) {
          // Queued maintenance may need this foreground turn to release its lane first.
          void trackDisposal(async () => {
            await Promise.allSettled(disposalHolds);
            await runCliCleanup(params, "cli-context-engine-release", async () => {
              await ownedEngine.dispose?.();
            });
          }).catch((error: unknown) => {
            cliBackendLog.warn(`CLI context engine cleanup failed: ${String(error)}`);
          });
        } else {
          await ownedEngine.dispose?.();
        }
      }, cleanupPreparedResources);
      preparedBackendFinal.cleanup = cleanupPreparedResources;
    }
    const contextEngine =
      resolvedContextEngine.info.id !== "legacy" ? resolvedContextEngine : undefined;
    if (contextEngine) {
      assertContextEngineHostSupport({
        contextEngine,
        operation: "agent-run",
        host: contextEngineHostSupport,
      });
    }
    const hadSessionFile = await hasCliSessionTranscript(params);
    const contextEngineTurnPrompt = params.transcriptPrompt ?? params.prompt;
    let preparedParams = await admitFinalParams();

    const note = await claimHeartbeatContextForUserRun({
      ...preparedParams,
      agentId: sessionAgentId,
      storePath: params.sessionTarget?.storePath ?? params.storePath,
      detached: Boolean(params.sessionManager || params.isolatedCompletion),
      assertCurrent: createCliRunCurrentAssertion(preparedParams),
    });
    if (note) {
      preparedParams = {
        ...preparedParams,
        transcriptPrompt: finalizedTranscriptPrompt ?? params.prompt,
      };
      const append = (text: string) => composeCliPromptContext(text, { appendContext: note });
      if (executionTarget.kind === "plugin") {
        promptContext = {
          ...promptContext,
          appendContext: append(promptContext?.appendContext ?? ""),
        };
        promptForHooks = append(promptForHooks ?? preparedParams.prompt);
      } else {
        preparedParams.prompt = append(preparedParams.prompt);
        if (openClawHistoryPrompt) {
          openClawHistoryPrompt = append(openClawHistoryPrompt);
        }
      }
    }
    return {
      ...buildPreparedContext(preparedParams),
      ...(managedClaudeLiveSessionGeneration
        ? { requiredClaudeLiveSessionGeneration: managedClaudeLiveSessionGeneration }
        : {}),
      hadSessionFile,
      contextEngine,
      deferContextEngineDisposalUntil,
      contextEngineTurnPrompt,
      ...(promptContext ? { promptContext, promptForHooks } : {}),
      ...(nodeSkillWorkshop ? { nodeSkillWorkshop } : {}),
      ...(openClawHistoryPrompt ? { openClawHistoryPrompt } : {}),
    };
  } catch (err) {
    try {
      await runCliCleanup(params, "cli-prepare-failure", async () => {
        await cleanupPreparedResources?.();
      });
    } catch (cleanupErr) {
      cliBackendLog.warn(`cli backend cleanup after prepare failure failed: ${String(cleanupErr)}`);
    }
    throw err;
  }
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
