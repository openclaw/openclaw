/**
 * Prepares CLI backend run context: backend config, prompts, bootstrap context,
 * MCP, auth epoch, and reusable session metadata.
 */
import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import { getRuntimeConfig } from "../../config/config.js";
import {
  assertContextEngineHostSupport,
  buildGenericCliContextEngineHostSupport,
} from "../../context-engine/host-compat.js";
import { ensureContextEnginesInitialized } from "../../context-engine/init.js";
import { resolveContextEngine } from "../../context-engine/registry.js";
import { ensureMcpLoopbackServer } from "../../gateway/mcp-http.js";
import {
  createMcpLoopbackServerConfig,
  getActiveMcpLoopbackRuntime,
  resolveMcpLoopbackBearerToken,
} from "../../gateway/mcp-http.loopback-runtime.js";
import { resolveMcpLoopbackScopedTools } from "../../gateway/mcp-http.runtime.js";
import { isClaudeCliProvider } from "../../plugin-sdk/anthropic-cli.js";
import type {
  CliBackendAuthEpochMode,
  CliBackendForwardedCredentialKind,
  CliBackendPlugin,
  CliBackendPreparedExecution,
} from "../../plugins/cli-backend.types.js";
import { buildAgentHookContextChannelFields } from "../../plugins/hook-agent-context.js";
import { getGlobalHookRunner } from "../../plugins/hook-runner-global.js";
import { resolveProviderCliBackendAuthCredential } from "../../plugins/provider-runtime.runtime.js";
import type { ProviderResolvedCliBackendAuthCredential } from "../../plugins/types.js";
import { isSubagentSessionKey } from "../../routing/session-key.js";
import { annotateInterSessionPromptText } from "../../sessions/input-provenance.js";
import { resolveSkillsPromptForRun } from "../../skills/loading/workspace.js";
import { resolveEmbeddedRunSkillEntries } from "../../skills/runtime/embedded-run-entries.js";
import { resolveUserPath } from "../../utils.js";
import { normalizeMessageChannel } from "../../utils/message-channel.js";
import { resolveAgentDir, resolveSessionAgentIds } from "../agent-scope.js";
import { externalCliDiscoveryForProviderAuth } from "../auth-profiles/external-cli-discovery.js";
import { resolveApiKeyForProfile } from "../auth-profiles/oauth.js";
import { resolveAuthProfileOrder } from "../auth-profiles/order.js";
import { loadAuthProfileStoreForRuntime } from "../auth-profiles/store.js";
import type { AuthProfileCredential, AuthProfileStore } from "../auth-profiles/types.js";
import {
  buildBootstrapInjectionStats,
  buildBootstrapPromptWarning,
  buildBootstrapTruncationReportMeta,
  analyzeBootstrapBudget,
} from "../bootstrap-budget.js";
import {
  makeBootstrapWarn as makeBootstrapWarnImpl,
  resolveBootstrapContextForRun as resolveBootstrapContextForRunImpl,
} from "../bootstrap-files.js";
import { CLI_AUTH_EPOCH_VERSION, resolveCliAuthEpoch } from "../cli-auth-epoch.js";
import { resolveCliBackendConfig } from "../cli-backends.js";
import { hashCliSessionText, resolveCliSessionReuse } from "../cli-session.js";
import {
  claudeCliSessionTranscriptHasContent,
  claudeCliSessionTranscriptHasOrphanedToolUse,
} from "../command/attempt-execution.helpers.js";
import { resolveContextWindowInfo } from "../context-window-guard.js";
import { resolveContextTokensForModel } from "../context.js";
import { DEFAULT_CONTEXT_TOKENS } from "../defaults.js";
import {
  resolveBootstrapMaxChars,
  resolveBootstrapPromptTruncationWarningMode,
  resolveBootstrapTotalMaxChars,
} from "../embedded-agent-helpers.js";
import { resolvePromptBuildHookResult } from "../embedded-agent-runner/run/attempt.prompt-helpers.js";
import {
  prependSystemPromptAddition,
  resolveAttemptMediaTaskSystemPromptAddition,
} from "../embedded-agent-runner/run/attempt.prompt-helpers.js";
import { composeSystemPromptWithHookContext } from "../embedded-agent-runner/run/attempt.thread-helpers.js";
import { buildCurrentInboundPrompt } from "../embedded-agent-runner/run/runtime-context-prompt.js";
import {
  mapSandboxSkillEntriesForPrompt,
  resolveSandboxSkillRuntimeInputs,
} from "../embedded-agent-runner/sandbox-skills.js";
import { resolveHeartbeatPromptForSystemPrompt } from "../heartbeat-system-prompt.js";
import { applyPluginTextReplacements } from "../plugin-text-transforms.js";
import { collectRuntimeChannelCapabilities } from "../runtime-capabilities.js";
import { ensureSandboxWorkspaceForSession } from "../sandbox.js";
import { ensureSystemPromptCacheBoundary } from "../system-prompt-cache-boundary.js";
import { buildSystemPromptReport } from "../system-prompt-report.js";
import { appendModelIdentitySystemPrompt, buildModelIdentityPromptLine } from "../system-prompt.js";
import { redactRunIdentifier, resolveRunWorkspaceDir } from "../workspace-run.js";
import { prepareCliBundleMcpConfig } from "./bundle-mcp.js";
import { prepareClaudeCliSkillsPlugin } from "./claude-skills-plugin.js";
import { buildCliAgentSystemPrompt, normalizeCliModel } from "./helpers.js";
import { cliBackendLog } from "./log.js";
import {
  buildCliSessionHistoryPrompt,
  hasCliSessionTranscript,
  loadCliSessionHistoryMessages,
  loadCliSessionReseedMessages,
  resolveAutoCliSessionReseedHistoryChars,
} from "./session-history.js";
import type { CliReusableSession, PreparedCliRunContext, RunCliAgentParams } from "./types.js";

const prepareDeps = {
  makeBootstrapWarn: makeBootstrapWarnImpl,
  resolveBootstrapContextForRun: resolveBootstrapContextForRunImpl,
  getActiveMcpLoopbackRuntime,
  ensureMcpLoopbackServer,
  createMcpLoopbackServerConfig,
  resolveMcpLoopbackBearerToken,
  resolveMcpLoopbackScopedTools,
  resolveOpenClawReferencePaths: async (
    params: Parameters<typeof import("../docs-path.js").resolveOpenClawReferencePaths>[0],
  ) => (await import("../docs-path.js")).resolveOpenClawReferencePaths(params),
  prepareClaudeCliSkillsPlugin,
  claudeCliSessionTranscriptHasContent,
  claudeCliSessionTranscriptHasOrphanedToolUse,
  resolveApiKeyForProfile,
  resolveProviderCliBackendAuthCredential,
};
const defaultPrepareDeps = { ...prepareDeps };

async function resolveCliSkillsPrompt(params: {
  agentId: string;
  config: RunCliAgentParams["config"];
  sessionKey: string;
  skillsSnapshot: RunCliAgentParams["skillsSnapshot"];
  workspaceDir: string;
}): Promise<string> {
  const sandboxWorkspace = await ensureSandboxWorkspaceForSession({
    config: params.config,
    sessionKey: params.sessionKey,
    workspaceDir: params.workspaceDir,
  });
  if (!sandboxWorkspace) {
    return resolveSkillsPromptForRun({
      skillsSnapshot: params.skillsSnapshot,
      workspaceDir: params.workspaceDir,
      config: params.config,
      agentId: params.agentId,
    });
  }

  const {
    skillsEligibility,
    skillsPromptWorkspaceDir,
    skillsSnapshot: skillsSnapshotForRun,
    skillsWorkspaceDir,
    workspaceOnly,
  } = resolveSandboxSkillRuntimeInputs({
    sandbox: {
      enabled: true,
      ...(sandboxWorkspace.containerWorkdir
        ? { containerWorkdir: sandboxWorkspace.containerWorkdir }
        : {}),
      ...(sandboxWorkspace.skillsEligibility
        ? { skillsEligibility: sandboxWorkspace.skillsEligibility }
        : {}),
      ...(sandboxWorkspace.skillsWorkspaceDir
        ? { skillsWorkspaceDir: sandboxWorkspace.skillsWorkspaceDir }
        : {}),
      ...(sandboxWorkspace.workspaceAccess
        ? { workspaceAccess: sandboxWorkspace.workspaceAccess }
        : {}),
    },
    effectiveWorkspace: sandboxWorkspace.workspaceDir,
    skillsSnapshot: params.skillsSnapshot,
  });
  const { shouldLoadSkillEntries, skillEntries } = resolveEmbeddedRunSkillEntries({
    workspaceDir: skillsWorkspaceDir,
    config: params.config,
    agentId: params.agentId,
    eligibility: skillsEligibility,
    skillsSnapshot: skillsSnapshotForRun,
    workspaceOnly,
  });
  const promptSkillEntries = mapSandboxSkillEntriesForPrompt({
    entries: shouldLoadSkillEntries ? skillEntries : undefined,
    skillsWorkspaceDir,
    skillsPromptWorkspaceDir,
  });
  return resolveSkillsPromptForRun({
    skillsSnapshot: skillsSnapshotForRun,
    entries: promptSkillEntries,
    workspaceDir: skillsPromptWorkspaceDir,
    config: params.config,
    agentId: params.agentId,
    eligibility: skillsEligibility,
  });
}

const CLAUDE_CLI_CONTEXT_MODEL_ALIASES: Record<string, string> = {
  opus: "claude-opus-4-8",
  "opus-4.8": "claude-opus-4-8",
  "opus-4-8": "claude-opus-4-8",
  "opus-4.7": "claude-opus-4-7",
  "opus-4-7": "claude-opus-4-7",
  "opus-4.6": "claude-opus-4-6",
  "opus-4-6": "claude-opus-4-6",
  sonnet: "claude-sonnet-4-6",
  "sonnet-4.6": "claude-sonnet-4-6",
  "sonnet-4-6": "claude-sonnet-4-6",
};

function resolveClaudeCliContextModelId(modelId: string): string {
  const trimmed = modelId.trim();
  const lower = trimmed.toLowerCase();
  return CLAUDE_CLI_CONTEXT_MODEL_ALIASES[lower] ?? trimmed;
}

/** Overrides preparation dependencies for CLI runner tests. */
export function setCliRunnerPrepareTestDeps(overrides: Partial<typeof prepareDeps>): void {
  Object.assign(prepareDeps, overrides);
}

/** Restores CLI runner preparation dependencies after isolated tests. */
export function resetCliRunnerPrepareTestDeps(): void {
  Object.assign(prepareDeps, defaultPrepareDeps);
}

/** Returns whether profile-owned prepared execution should skip local CLI epoch hashing. */
export function shouldSkipLocalCliCredentialEpoch(params: {
  authEpochMode?: CliBackendAuthEpochMode;
  authProfileId?: string;
  authCredential?: unknown;
  preparedExecution?: CliBackendPreparedExecution | null;
}): boolean {
  return Boolean(
    params.authEpochMode === "profile-only" &&
    params.authProfileId &&
    params.authCredential &&
    params.preparedExecution,
  );
}

type ForwardableAuthCredential = AuthProfileCredential | ProviderResolvedCliBackendAuthCredential;

function resolveForwardedCredentialProviderId(
  credential: ForwardableAuthCredential | undefined,
): string | undefined {
  if (!credential) {
    return undefined;
  }
  return "providerId" in credential ? credential.providerId : credential.provider;
}

function resolveForwardedCredentialKind(
  credential: ForwardableAuthCredential | undefined,
): string | undefined {
  if (!credential) {
    return undefined;
  }
  return "kind" in credential ? credential.kind : credential.type;
}

function isForwardedCredentialKind(
  value: string | undefined,
): value is CliBackendForwardedCredentialKind {
  return value === "api_key" || value === "oauth" || value === "token";
}

export function shouldForwardAuthCredentialToCliBackend(params: {
  backend: Pick<CliBackendPlugin, "authProfileForwarding">;
  authProfileId?: string;
  authCredential?: ForwardableAuthCredential;
}): boolean {
  const capability = params.backend.authProfileForwarding;
  if (!capability?.supported || !params.authProfileId || !params.authCredential) {
    return false;
  }
  const providerId = resolveForwardedCredentialProviderId(params.authCredential);
  const credentialKind = resolveForwardedCredentialKind(params.authCredential);
  return Boolean(
    providerId &&
    isForwardedCredentialKind(credentialKind) &&
    capability.providers.includes(providerId) &&
    capability.credentialKinds.includes(credentialKind),
  );
}

async function resolveDefaultCliBackendAuthCredential(params: {
  cfg?: RunCliAgentParams["config"];
  store: AuthProfileStore;
  profileId: string;
  agentDir?: string;
}): Promise<ProviderResolvedCliBackendAuthCredential | undefined> {
  const resolved = await prepareDeps.resolveApiKeyForProfile({
    cfg: params.cfg,
    store: params.store,
    profileId: params.profileId,
    agentDir: params.agentDir,
  });
  if (!resolved) {
    return undefined;
  }
  const credential = resolved.credential ?? params.store.profiles[resolved.profileId];
  if (resolved.profileType === "api_key") {
    return {
      kind: "api_key",
      providerId: resolved.provider,
      profileId: resolved.profileId,
      apiKey: resolved.apiKey,
      ...(resolved.email ? { email: resolved.email } : {}),
    };
  }
  if (resolved.profileType === "token") {
    return {
      kind: "token",
      providerId: resolved.provider,
      profileId: resolved.profileId,
      token: resolved.apiKey,
      ...(credential?.type === "token" && typeof credential.expires === "number"
        ? { expiresAt: credential.expires }
        : {}),
      ...(resolved.email ? { email: resolved.email } : {}),
    };
  }
  return {
    kind: "oauth",
    providerId: resolved.provider,
    profileId: resolved.profileId,
    accessToken:
      credential?.type === "oauth" && credential.access ? credential.access : resolved.apiKey,
    ...(credential?.type === "oauth" && credential.refresh
      ? { refreshToken: credential.refresh }
      : {}),
    ...(credential?.type === "oauth" && typeof credential.expires === "number"
      ? { expiresAt: credential.expires }
      : {}),
    ...(credential?.type === "oauth" && credential.projectId
      ? { projectId: credential.projectId }
      : {}),
    ...(resolved.email ? { email: resolved.email } : {}),
  };
}

async function resolveCliBackendAuthCredential(params: {
  cfg?: RunCliAgentParams["config"];
  workspaceDir: string;
  agentDir?: string;
  provider: string;
  modelId: string;
  profileId: string;
  credential: AuthProfileCredential;
  store: AuthProfileStore;
}): Promise<ProviderResolvedCliBackendAuthCredential | undefined> {
  return (
    (await prepareDeps.resolveProviderCliBackendAuthCredential({
      config: params.cfg,
      workspaceDir: params.workspaceDir,
      provider: params.provider,
      context: {
        config: params.cfg,
        agentDir: params.agentDir,
        workspaceDir: params.workspaceDir,
        provider: params.provider,
        modelId: params.modelId,
        profileId: params.profileId,
        credential: params.credential,
        store: params.store,
      },
    })) ??
    (await resolveDefaultCliBackendAuthCredential({
      cfg: params.cfg,
      store: params.store,
      profileId: params.profileId,
      agentDir: params.agentDir,
    }))
  );
}

/** Builds the complete context required to execute a CLI-backed agent run. */
export async function prepareCliRunContext(
  params: RunCliAgentParams,
): Promise<PreparedCliRunContext> {
  const started = Date.now();
  const executionMode = params.executionMode ?? "agent";
  const isSideQuestion = executionMode === "side-question";
  const workspaceResolution = resolveRunWorkspaceDir({
    workspaceDir: params.workspaceDir,
    sessionKey: params.sessionKey,
    agentId: params.agentId,
    config: params.config,
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
  const cwd = params.cwd ? resolveUserPath(params.cwd) : workspaceDir;
  const cwdHash = hashCliSessionText(cwd);

  const backendResolved = resolveCliBackendConfig(params.provider, params.config, {
    agentId: params.agentId,
  });
  if (!backendResolved) {
    throw new Error(`Unknown CLI backend: ${params.provider}`);
  }
  const modelId = (params.model ?? "default").trim() || "default";
  const normalizedModel = normalizeCliModel(modelId, backendResolved.config);
  const modelDisplay = `${params.provider}/${modelId}`;
  if (params.toolsAllow !== undefined) {
    throw new Error(
      `CLI backend ${backendResolved.id} cannot enforce runtime toolsAllow; use an embedded runtime for restricted tool policy`,
    );
  }
  const sideQuestionDisablesNativeTools =
    isSideQuestion && backendResolved.sideQuestionToolMode === "disabled";
  if (
    params.disableTools === true &&
    backendResolved.nativeToolMode === "always-on" &&
    !sideQuestionDisablesNativeTools
  ) {
    throw new Error(
      `CLI backend ${backendResolved.id} cannot run with tools disabled because it exposes native tools`,
    );
  }
  const { defaultAgentId, sessionAgentId } = resolveSessionAgentIds({
    sessionKey: params.sessionKey,
    config: params.config,
    agentId: params.agentId,
  });
  const agentDir = resolveAgentDir(params.config ?? {}, sessionAgentId);
  const requestedAuthProfileId = params.authProfileId?.trim() || undefined;
  let effectiveAuthProfileId =
    requestedAuthProfileId ?? backendResolved.defaultAuthProfileId?.trim() ?? undefined;
  let authStore: AuthProfileStore | undefined;
  let authCredential: ForwardableAuthCredential | undefined;
  const loadScopedAuthStore = (options: { profileId?: string; readOnly?: boolean } = {}) =>
    loadAuthProfileStoreForRuntime(agentDir, {
      readOnly: options.readOnly ?? true,
      externalCli: externalCliDiscoveryForProviderAuth({
        cfg: params.config,
        provider: params.provider,
        ...(options.profileId ? { profileId: options.profileId } : {}),
      }),
    });
  if (effectiveAuthProfileId) {
    authStore = loadScopedAuthStore({ profileId: effectiveAuthProfileId });
    authCredential = authStore.profiles[effectiveAuthProfileId];
  } else if (backendResolved.prepareExecution || backendResolved.authEpochMode === "profile-only") {
    authStore = loadScopedAuthStore();
    effectiveAuthProfileId =
      resolveAuthProfileOrder({
        cfg: params.config,
        store: authStore,
        provider: params.provider,
      })[0]?.trim() || undefined;
    if (effectiveAuthProfileId) {
      authCredential = authStore.profiles[effectiveAuthProfileId];
    }
  }
  if (effectiveAuthProfileId) {
    const authProfileId = effectiveAuthProfileId;
    const shouldForwardAuthCredential = shouldForwardAuthCredentialToCliBackend({
      backend: backendResolved,
      authProfileId,
      authCredential,
    });
    if (shouldForwardAuthCredential) {
      const selectedProviderId = resolveForwardedCredentialProviderId(authCredential);

      // Fail closed at the public Plugin SDK boundary. Never pass the raw
      // persisted auth-profile object into prepareExecution; only a typed,
      // resolver-produced credential may cross into backend code.
      authCredential = undefined;

      if (selectedProviderId) {
        const writableAuthStore = loadScopedAuthStore({
          profileId: authProfileId,
          readOnly: false,
        });
        const selectedCredential = writableAuthStore.profiles[authProfileId];
        const resolvedAuthCredential =
          selectedCredential &&
          (await resolveCliBackendAuthCredential({
            cfg: params.config,
            workspaceDir,
            provider: selectedProviderId,
            agentDir,
            modelId,
            profileId: authProfileId,
            credential: selectedCredential,
            store: writableAuthStore,
          }));
        if (
          resolvedAuthCredential &&
          shouldForwardAuthCredentialToCliBackend({
            backend: backendResolved,
            authProfileId: resolvedAuthCredential.profileId,
            authCredential: resolvedAuthCredential,
          })
        ) {
          effectiveAuthProfileId = resolvedAuthCredential.profileId;
          authStore = loadScopedAuthStore({ profileId: effectiveAuthProfileId });
          authCredential = resolvedAuthCredential;
        }
      }
    }
  }
  const extraSystemPrompt = params.extraSystemPrompt?.trim() ?? "";
  // Use the static portion (excluding per-message inbound metadata) for session reuse hashing.
  // Per-message metadata (timestamps, message IDs) changes every turn and must not trigger session resets.
  const extraSystemPromptHash =
    params.extraSystemPromptStatic !== undefined
      ? hashCliSessionText(params.extraSystemPromptStatic.trim() || undefined)
      : hashCliSessionText(extraSystemPrompt);
  const requireExplicitMessageTarget =
    params.requireExplicitMessageTarget ?? isSubagentSessionKey(params.sessionKey);
  const messageToolPolicyHash =
    params.sourceReplyDeliveryMode !== undefined ||
    params.requireExplicitMessageTarget !== undefined ||
    requireExplicitMessageTarget
      ? hashCliSessionText(
          JSON.stringify({
            sourceReplyDeliveryMode: params.sourceReplyDeliveryMode,
            requireExplicitMessageTarget,
          }),
        )
      : undefined;

  const isClaudeCli = isClaudeCliProvider(params.provider);
  const modelContextTokens = isClaudeCli
    ? resolveContextTokensForModel({
        cfg: params.config,
        provider: params.provider,
        model: resolveClaudeCliContextModelId(modelId),
        fallbackContextTokens: 200_000,
        allowAsyncLoad: false,
      })
    : undefined;
  const contextWindowInfo = resolveContextWindowInfo({
    cfg: params.config,
    provider: params.provider,
    modelId,
    modelContextTokens,
    defaultTokens: DEFAULT_CONTEXT_TOKENS,
  });
  const autoReseedHistoryChars = isClaudeCli
    ? resolveAutoCliSessionReseedHistoryChars(contextWindowInfo.tokens)
    : undefined;

  const sessionLabel = params.sessionKey ?? params.sessionId;
  const { bootstrapFiles, contextFiles } = isSideQuestion
    ? { bootstrapFiles: [], contextFiles: [] }
    : await prepareDeps.resolveBootstrapContextForRun({
        workspaceDir,
        config: params.config,
        sessionKey: params.sessionKey,
        sessionId: params.sessionId,
        agentId: sessionAgentId,
        contextMode: params.bootstrapContextMode,
        runKind: params.bootstrapContextRunKind,
        warn: prepareDeps.makeBootstrapWarn({
          sessionLabel,
          workspaceDir,
          warn: (message) => cliBackendLog.warn(message),
        }),
      });
  const bootstrapMaxChars = resolveBootstrapMaxChars(params.config, sessionAgentId);
  const bootstrapTotalMaxChars = resolveBootstrapTotalMaxChars(params.config, sessionAgentId);
  const bootstrapAnalysis = analyzeBootstrapBudget({
    files: buildBootstrapInjectionStats({
      bootstrapFiles,
      injectedFiles: contextFiles,
    }),
    bootstrapMaxChars,
    bootstrapTotalMaxChars,
  });
  const bootstrapPromptWarningMode = resolveBootstrapPromptTruncationWarningMode(params.config);
  const bootstrapPromptWarning = buildBootstrapPromptWarning({
    analysis: bootstrapAnalysis,
    mode: bootstrapPromptWarningMode,
    seenSignatures: params.bootstrapPromptWarningSignaturesSeen,
    previousSignature: params.bootstrapPromptWarningSignature,
  });
  const bundleMcpEnabled =
    !isSideQuestion && backendResolved.bundleMcp && params.disableTools !== true;
  let mcpLoopbackRuntime = bundleMcpEnabled ? prepareDeps.getActiveMcpLoopbackRuntime() : undefined;
  if (bundleMcpEnabled && !mcpLoopbackRuntime) {
    try {
      await prepareDeps.ensureMcpLoopbackServer();
    } catch (error) {
      cliBackendLog.warn(`mcp loopback server failed to start: ${String(error)}`);
      throw error;
    }
    mcpLoopbackRuntime = prepareDeps.getActiveMcpLoopbackRuntime();
    if (!mcpLoopbackRuntime) {
      throw new Error("mcp loopback server failed to start");
    }
  }
  const mcpDeliveryCaptureEnabled = bundleMcpEnabled && Boolean(mcpLoopbackRuntime);
  const preparedBackend = await prepareCliBundleMcpConfig({
    enabled: bundleMcpEnabled,
    mode: backendResolved.bundleMcpMode,
    backend: backendResolved.config,
    workspaceDir,
    config: params.config,
    additionalConfig: mcpLoopbackRuntime
      ? prepareDeps.createMcpLoopbackServerConfig(mcpLoopbackRuntime.port)
      : undefined,
    env: mcpLoopbackRuntime
      ? {
          OPENCLAW_MCP_TOKEN: prepareDeps.resolveMcpLoopbackBearerToken(
            mcpLoopbackRuntime,
            params.senderIsOwner === true,
          ),
          OPENCLAW_MCP_AGENT_ID: sessionAgentId ?? "",
          OPENCLAW_MCP_ACCOUNT_ID: params.agentAccountId ?? "",
          OPENCLAW_MCP_SESSION_KEY: params.sessionKey ?? "",
          OPENCLAW_MCP_SESSION_ID: params.sessionId,
          OPENCLAW_MCP_MESSAGE_CHANNEL: params.messageChannel ?? params.messageProvider ?? "",
          OPENCLAW_MCP_CURRENT_CHANNEL_ID: params.currentChannelId ?? "",
          OPENCLAW_MCP_CURRENT_THREAD_TS: params.currentThreadTs ?? "",
          OPENCLAW_MCP_CURRENT_MESSAGE_ID:
            params.currentMessageId != null ? String(params.currentMessageId) : "",
          OPENCLAW_MCP_CURRENT_INBOUND_AUDIO: params.currentInboundAudio === true ? "true" : "",
          OPENCLAW_MCP_INBOUND_EVENT_KIND: params.currentInboundEventKind ?? "",
          OPENCLAW_MCP_SOURCE_REPLY_DELIVERY_MODE: params.sourceReplyDeliveryMode ?? "",
          OPENCLAW_MCP_REQUIRE_EXPLICIT_MESSAGE_TARGET: requireExplicitMessageTarget ? "true" : "",
          OPENCLAW_MCP_CLI_CAPTURE_KEY: "",
        }
      : undefined,
    warn: (message) => cliBackendLog.warn(message),
  });
  const prepareExecutionContext = {
    config: params.config,
    workspaceDir,
    agentDir,
    provider: params.provider,
    modelId,
    authProfileId: effectiveAuthProfileId,
    executionMode,
    env: preparedBackend.env,
  } as Parameters<NonNullable<typeof backendResolved.prepareExecution>>[0];
  let preparedExecution: Awaited<ReturnType<NonNullable<typeof backendResolved.prepareExecution>>> =
    undefined;
  try {
    const forwardAuthCredential = shouldForwardAuthCredentialToCliBackend({
      backend: backendResolved,
      authProfileId: effectiveAuthProfileId,
      authCredential,
    });
    preparedExecution = await backendResolved.prepareExecution?.(
      (forwardAuthCredential
        ? {
            ...prepareExecutionContext,
            authCredential,
          }
        : prepareExecutionContext) as typeof prepareExecutionContext,
    );
  } catch (err) {
    try {
      await preparedBackend.cleanup?.();
    } catch (cleanupErr) {
      cliBackendLog.warn(`cli backend cleanup after prepare failure failed: ${String(cleanupErr)}`);
    }
    throw err;
  }
  const skipLocalCredentialEpoch = shouldSkipLocalCliCredentialEpoch({
    authEpochMode: backendResolved.authEpochMode,
    authProfileId: effectiveAuthProfileId,
    authCredential,
    preparedExecution,
  });
  let authEpoch: Awaited<ReturnType<typeof resolveCliAuthEpoch>>;
  try {
    authEpoch = await resolveCliAuthEpoch({
      provider: params.provider,
      agentDir,
      authProfileId: effectiveAuthProfileId,
      skipLocalCredential: skipLocalCredentialEpoch,
    });
  } catch (err) {
    try {
      await preparedExecution?.cleanup?.();
      await preparedBackend.cleanup?.();
    } catch (cleanupErr) {
      cliBackendLog.warn(
        `cli backend cleanup after auth epoch failure failed: ${String(cleanupErr)}`,
      );
    }
    throw err;
  }
  const preparedBackendEnv =
    preparedExecution?.env && Object.keys(preparedExecution.env).length > 0
      ? { ...preparedBackend.env, ...preparedExecution.env }
      : preparedBackend.env;
  const preparedBackendCleanup =
    preparedBackend.cleanup || preparedExecution?.cleanup
      ? async () => {
          try {
            await preparedExecution?.cleanup?.();
          } finally {
            await preparedBackend.cleanup?.();
          }
        }
      : undefined;
  const preparedBackendBeforeExecution =
    preparedBackend.beforeExecution || preparedExecution?.beforeExecution
      ? async () => {
          await preparedBackend.beforeExecution?.();
          await preparedExecution?.beforeExecution?.();
        }
      : undefined;
  const claudeSkillsPlugin = isSideQuestion
    ? { args: [], cleanup: async () => {} }
    : await prepareDeps.prepareClaudeCliSkillsPlugin({
        backendId: backendResolved.id,
        skillsSnapshot: params.skillsSnapshot,
      });
  const preparedCleanup =
    preparedBackendCleanup || claudeSkillsPlugin.args.length > 0
      ? async () => {
          try {
            await claudeSkillsPlugin.cleanup();
          } finally {
            await preparedBackendCleanup?.();
          }
        }
      : undefined;
  const preparedBackendClearEnv = [
    ...(preparedBackend.backend.clearEnv ?? []),
    ...(preparedExecution?.clearEnv ?? []),
  ];
  const sideQuestionBackend = (() => {
    const { liveSession: _liveSession, ...backend } = preparedBackend.backend;
    return {
      ...backend,
      sessionMode: "none" as const,
    };
  })();
  const preparedBackendFinal = {
    ...preparedBackend,
    backend: {
      ...(isSideQuestion ? sideQuestionBackend : preparedBackend.backend),
      ...(preparedBackendClearEnv.length > 0
        ? { clearEnv: uniqueStrings(preparedBackendClearEnv) }
        : {}),
    },
    ...(preparedBackendEnv ? { env: preparedBackendEnv } : {}),
    ...(preparedBackendBeforeExecution ? { beforeExecution: preparedBackendBeforeExecution } : {}),
    ...(preparedCleanup ? { cleanup: preparedCleanup } : {}),
  };
  try {
    const promptTools =
      bundleMcpEnabled && mcpLoopbackRuntime
        ? prepareDeps.resolveMcpLoopbackScopedTools({
            cfg: params.config ?? getRuntimeConfig(),
            sessionKey: params.sessionKey ?? "",
            messageProvider: params.messageChannel ?? params.messageProvider,
            currentChannelId: params.currentChannelId,
            currentThreadTs: params.currentThreadTs,
            currentMessageId: params.currentMessageId,
            currentInboundAudio: params.currentInboundAudio,
            accountId: params.agentAccountId,
            inboundEventKind: params.currentInboundEventKind,
            sourceReplyDeliveryMode: params.sourceReplyDeliveryMode,
            requireExplicitMessageTarget,
            senderIsOwner: params.senderIsOwner,
          }).tools
        : [];
    const promptToolNamesHash =
      bundleMcpEnabled && mcpLoopbackRuntime
        ? hashCliSessionText(JSON.stringify(promptTools.map((tool) => tool.name).toSorted()))
        : undefined;
    const reusableCliSessionCandidate: CliReusableSession = isSideQuestion
      ? {}
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
          ? { sessionId: params.cliSessionId }
          : {};
    const candidateClaudeCliSessionId = reusableCliSessionCandidate.sessionId?.trim() || undefined;
    const hasClaudeCliCandidate =
      candidateClaudeCliSessionId !== undefined && isClaudeCliProvider(params.provider);
    const claudeCliTranscriptMissing =
      hasClaudeCliCandidate &&
      !(await prepareDeps.claudeCliSessionTranscriptHasContent({
        sessionId: candidateClaudeCliSessionId,
        workspaceDir: cwd,
      }));
    const claudeCliTranscriptOrphanedToolUse =
      hasClaudeCliCandidate &&
      !claudeCliTranscriptMissing &&
      (await prepareDeps.claudeCliSessionTranscriptHasOrphanedToolUse({
        sessionId: candidateClaudeCliSessionId,
        workspaceDir: cwd,
      }));
    const claudeCliInvalidatedReason: CliReusableSession["invalidatedReason"] | undefined =
      claudeCliTranscriptMissing
        ? "missing-transcript"
        : claudeCliTranscriptOrphanedToolUse
          ? "orphaned-tool-use"
          : undefined;
    const reusableCliSession: CliReusableSession = claudeCliInvalidatedReason
      ? { invalidatedReason: claudeCliInvalidatedReason }
      : reusableCliSessionCandidate;
    if (reusableCliSession.invalidatedReason) {
      cliBackendLog.info(
        `cli session reset: provider=${params.provider} reason=${reusableCliSession.invalidatedReason}`,
      );
    }
    let openClawHistoryMessages: unknown[] | undefined;
    const loadOpenClawHistoryMessages = async () => {
      openClawHistoryMessages ??= await loadCliSessionHistoryMessages({
        sessionId: params.sessionId,
        sessionFile: params.sessionFile,
        sessionKey: params.sessionKey,
        agentId: params.agentId,
        config: params.config,
      });
      return openClawHistoryMessages;
    };
    const heartbeatPrompt =
      isSideQuestion || params.bootstrapContextRunKind === "commitment-only"
        ? undefined
        : resolveHeartbeatPromptForSystemPrompt({
            config: params.config,
            agentId: sessionAgentId,
            defaultAgentId,
          });
    const openClawReferences = isSideQuestion
      ? { docsPath: null, sourcePath: null }
      : await prepareDeps.resolveOpenClawReferencePaths({
          workspaceDir,
          argv1: process.argv[1],
          cwd,
          moduleUrl: import.meta.url,
        });
    const systemPromptSkillsPrompt =
      isSideQuestion || claudeSkillsPlugin.args.length > 0
        ? ""
        : await resolveCliSkillsPrompt({
            skillsSnapshot: params.skillsSnapshot,
            workspaceDir,
            config: params.config,
            agentId: sessionAgentId,
            sessionKey: params.sessionKey?.trim() || params.sessionId,
          });
    const runtimeChannel = isSideQuestion
      ? undefined
      : normalizeMessageChannel(params.messageChannel ?? params.messageProvider);
    const runtimeCapabilities = isSideQuestion
      ? undefined
      : collectRuntimeChannelCapabilities({
          cfg: params.config,
          channel: runtimeChannel,
          accountId: params.agentAccountId,
        });
    const builtSystemPrompt = isSideQuestion
      ? extraSystemPrompt
      : buildCliAgentSystemPrompt({
          workspaceDir,
          cwd,
          config: params.config,
          defaultThinkLevel: params.thinkLevel,
          extraSystemPrompt,
          sourceReplyDeliveryMode: params.sourceReplyDeliveryMode,
          requireExplicitMessageTarget,
          silentReplyPromptMode: params.silentReplyPromptMode,
          runtimeChannel,
          runtimeChatType: params.sessionEntry?.chatType,
          runtimeCapabilities,
          ownerNumbers: params.ownerNumbers,
          heartbeatPrompt,
          docsPath: openClawReferences.docsPath ?? undefined,
          sourcePath: openClawReferences.sourcePath ?? undefined,
          skillsPrompt: systemPromptSkillsPrompt,
          tools: promptTools,
          contextFiles,
          modelDisplay,
          agentId: sessionAgentId,
          sessionKey: params.sessionKey,
          sessionId: params.sessionId,
        });
    const transformedSystemPrompt = !isSideQuestion
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
    let systemPrompt = transformedSystemPrompt;
    let preparedPrompt = params.prompt;
    if (!isSideQuestion) {
      const hookRunner = getGlobalHookRunner();
      try {
        const hookResult = await resolvePromptBuildHookResult({
          config: params.config ?? getRuntimeConfig(),
          prompt: params.prompt,
          messages: await loadOpenClawHistoryMessages(),
          hookCtx: {
            runId: params.runId,
            agentId: sessionAgentId,
            sessionKey: params.sessionKey,
            sessionId: params.sessionId,
            workspaceDir,
            modelProviderId: params.provider,
            modelId,
            trigger: params.trigger,
            ...buildAgentHookContextChannelFields(params),
          },
          hookRunner,
          bootstrapContextRunKind: params.bootstrapContextRunKind,
        });
        if (hookResult.prependContext) {
          preparedPrompt = `${hookResult.prependContext}\n\n${preparedPrompt}`;
        }
        if (hookResult.appendContext) {
          preparedPrompt = `${preparedPrompt}\n\n${hookResult.appendContext}`;
        }
        const hookSystemPrompt = hookResult.systemPrompt?.trim();
        if (hookSystemPrompt) {
          systemPrompt = hookSystemPrompt;
        }
        systemPrompt =
          composeSystemPromptWithHookContext({
            baseSystemPrompt: systemPrompt,
            prependSystemContext: hookResult.prependSystemContext,
            appendSystemContext: hookResult.appendSystemContext,
          }) ?? systemPrompt;
        const mediaTaskSystemPromptAddition = resolveAttemptMediaTaskSystemPromptAddition({
          sessionKey: params.sessionKey,
          trigger: params.trigger,
        });
        if (mediaTaskSystemPromptAddition) {
          systemPrompt = prependSystemPromptAddition({
            systemPrompt: ensureSystemPromptCacheBoundary(systemPrompt),
            systemPromptAddition: mediaTaskSystemPromptAddition,
          });
        }
      } catch (error) {
        cliBackendLog.warn(`cli prompt-build hook preparation failed: ${String(error)}`);
      }
    }
    let historyPromptCurrentTurn = preparedPrompt;
    if (!isSideQuestion) {
      const fullCurrentInboundPrompt = buildCurrentInboundPrompt({
        context: params.currentInboundContext,
        prompt: preparedPrompt,
      });
      const runCurrentInboundPrompt = buildCurrentInboundPrompt({
        context: params.currentInboundContext,
        prompt: preparedPrompt,
        preferResumableText:
          params.currentInboundEventKind === "room_event" && Boolean(reusableCliSession.sessionId),
      });
      historyPromptCurrentTurn = annotateInterSessionPromptText(
        fullCurrentInboundPrompt,
        params.inputProvenance,
      );
      preparedPrompt = annotateInterSessionPromptText(
        runCurrentInboundPrompt,
        params.inputProvenance,
      );
    }
    const allowRawTranscriptReseed =
      backendResolved.config.reseedFromRawTranscriptWhenUncompacted === true;
    const rawTranscriptReseedReason = reusableCliSession.sessionId
      ? "session-expired"
      : reusableCliSession.invalidatedReason;
    const shouldPrepareOpenClawHistoryPrompt =
      !isSideQuestion && (!reusableCliSession.sessionId || allowRawTranscriptReseed);
    const openClawHistoryPrompt = shouldPrepareOpenClawHistoryPrompt
      ? buildCliSessionHistoryPrompt({
          messages: await loadCliSessionReseedMessages({
            sessionId: params.sessionId,
            sessionFile: params.sessionFile,
            sessionKey: params.sessionKey,
            agentId: params.agentId,
            config: params.config,
            allowRawTranscriptReseed,
            rawTranscriptReseedReason,
          }),
          prompt: historyPromptCurrentTurn,
          maxHistoryChars: autoReseedHistoryChars,
        })
      : undefined;
    const systemPromptWithReplacements = applyPluginTextReplacements(
      systemPrompt,
      backendResolved.textTransforms?.input,
    );
    // Ensure the cache boundary before appending the model identity so the identity lands in the
    // dynamic suffix, not the cached prefix, for marker-free hook overrides — otherwise an idle
    // turn's prefix (O + identity) diverges from an active media turn's prefix (O) and breaks
    // prompt caching. Skip empty prompts and turns with no identity line, which need no boundary.
    systemPrompt = isSideQuestion
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
      bootstrapFiles,
      injectedFiles: contextFiles,
      skillsPrompt: systemPromptSkillsPrompt,
      tools: promptTools,
      currentTurn: {
        ...(params.currentInboundEventKind ? { kind: params.currentInboundEventKind } : {}),
        promptChars: preparedPrompt.length,
        runtimeContextChars: 0,
      },
    });
    const contextEngineConfig = params.config ?? getRuntimeConfig();
    if (isSideQuestion) {
      const preparedParams: RunCliAgentParams = {
        ...params,
        config: contextEngineConfig,
        prompt: preparedPrompt,
        ...(requireExplicitMessageTarget ? { requireExplicitMessageTarget: true } : {}),
      };

      return {
        params: preparedParams,
        effectiveAuthProfileId,
        started,
        workspaceDir,
        cwd,
        backendResolved,
        preparedBackend: preparedBackendFinal,
        reusableCliSession,
        hadSessionFile: false,
        contextEngineConfig,
        modelId,
        normalizedModel,
        contextWindowInfo,
        systemPrompt,
        systemPromptReport,
        claudeSkillsPluginArgs: claudeSkillsPlugin.args,
        bootstrapPromptWarningLines: bootstrapPromptWarning.lines,
        authEpoch,
        authEpochVersion: CLI_AUTH_EPOCH_VERSION,
        extraSystemPromptHash,
        messageToolPolicyHash,
        promptToolNamesHash,
        cwdHash,
        ...(mcpDeliveryCaptureEnabled ? { mcpDeliveryCapture: true } : {}),
      };
    }
    ensureContextEnginesInitialized();
    const { sessionAgentId: contextEngineSessionAgentId } = resolveSessionAgentIds({
      sessionKey: params.sessionKey,
      config: contextEngineConfig,
      agentId: params.agentId,
    });
    const contextEngineAgentDir = resolveAgentDir(contextEngineConfig, contextEngineSessionAgentId);
    const resolvedContextEngine = await resolveContextEngine(contextEngineConfig, {
      agentDir: contextEngineAgentDir,
      workspaceDir,
    });
    const contextEngine =
      resolvedContextEngine.info.id !== "legacy" ? resolvedContextEngine : undefined;
    if (contextEngine) {
      assertContextEngineHostSupport({
        contextEngine,
        operation: "agent-run",
        host: buildGenericCliContextEngineHostSupport({
          backendId: backendResolved.id,
          capabilities: backendResolved.contextEngineHostCapabilities,
        }),
      });
    }
    const hadSessionFile = await hasCliSessionTranscript({
      sessionId: params.sessionId,
      sessionFile: params.sessionFile,
      sessionKey: params.sessionKey,
      agentId: params.agentId,
      config: contextEngineConfig,
    });
    const contextEngineTurnPrompt = params.transcriptPrompt ?? params.prompt;
    const preparedParams: RunCliAgentParams = {
      ...params,
      config: contextEngineConfig,
      prompt: preparedPrompt,
      ...(requireExplicitMessageTarget ? { requireExplicitMessageTarget: true } : {}),
    };

    return {
      params: preparedParams,
      effectiveAuthProfileId,
      started,
      workspaceDir,
      cwd,
      backendResolved,
      preparedBackend: preparedBackendFinal,
      reusableCliSession,
      hadSessionFile,
      contextEngineConfig,
      contextEngine,
      contextEngineTurnPrompt,
      modelId,
      normalizedModel,
      contextWindowInfo,
      systemPrompt,
      systemPromptReport,
      claudeSkillsPluginArgs: claudeSkillsPlugin.args,
      bootstrapPromptWarningLines: bootstrapPromptWarning.lines,
      ...(openClawHistoryPrompt ? { openClawHistoryPrompt } : {}),
      heartbeatPrompt,
      authEpoch,
      authEpochVersion: CLI_AUTH_EPOCH_VERSION,
      extraSystemPromptHash,
      messageToolPolicyHash,
      promptToolNamesHash,
      cwdHash,
      ...(mcpDeliveryCaptureEnabled ? { mcpDeliveryCapture: true } : {}),
    };
  } catch (err) {
    try {
      await preparedBackendFinal.cleanup?.();
    } catch (cleanupErr) {
      cliBackendLog.warn(`cli backend cleanup after prepare failure failed: ${String(cleanupErr)}`);
    }
    throw err;
  }
}
