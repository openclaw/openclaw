import type { ThinkLevel } from "../../../auto-reply/thinking.js";
import { formatErrorMessage } from "../../../infra/errors.js";
import type { Model } from "../../../llm/types.js";
import type { ProviderModelRouteAuthRequirement } from "../../../plugin-sdk/provider-model-types.js";
import {
  attachProviderAuthAuthority,
  getProviderAuthAuthority,
} from "../../../plugins/provider-auth-authority.js";
import { prepareProviderRuntimeAuth } from "../../../plugins/provider-runtime.js";
import { SecretSurfaceUnavailableError } from "../../../secrets/runtime-degraded-state.js";
import {
  type AuthProfileStore,
  isProfileInCooldown,
  markAuthProfileFailure,
  resolveProfilesUnavailableReason,
  resolveSubscriptionAuthModeForProfiles,
} from "../../auth-profiles.js";
import { advanceAuthProfileCandidate } from "../../auth-profiles/advance.js";
import { OAuthRefreshFailureError } from "../../auth-profiles/oauth-refresh-failure.js";
import { FailoverError, resolveFailoverStatus } from "../../failover-error.js";
import { shouldUseTransientCooldownProbeSlot } from "../../failover-policy.js";
import { classifyFailoverReason } from "../../failover/classify.js";
import { getFailoverErrorCode } from "../../failover/error.js";
import type { FailoverReason } from "../../failover/signal.js";
import { renderAuthProfileFailoverCopy } from "../../failover/user-copy.js";
import { resolveProviderModelAuthPolicy } from "../../model-auth-policy.js";
import {
  getApiKeyForModelCore,
  MissingProviderAuthError,
  type ResolvedProviderAuth,
} from "../../model-auth.js";
import { buildProviderAuthRecoveryHint } from "../../provider-auth-recovery-hint.js";
import { providerModelRouteAcceptsAuthMode } from "../../provider-model-route-auth.js";
import { applyPreparedRuntimeAuthToModel } from "../../provider-request-config.js";
import { protectPreparedProviderRuntimeAuth } from "../../provider-runtime-auth-protection.js";
import { clampRuntimeAuthRefreshDelayMs } from "../../runtime-auth-refresh.js";
import { resolveAuthProfileFailureReason } from "./auth-profile-failure-policy.js";
import type { AuthProfileFailurePolicy } from "./auth-profile-failure-policy.types.js";
import {
  RUNTIME_AUTH_REFRESH_MARGIN_MS,
  RUNTIME_AUTH_REFRESH_MIN_DELAY_MS,
  RUNTIME_AUTH_REFRESH_RETRY_MS,
  type RuntimeAuthState,
} from "./helpers.js";
import type { resolveEmbeddedRunEffectiveModel } from "./model-harness.js";
import type { RunEmbeddedAgentParams } from "./params.js";

export type EmbeddedRunAuthState = {
  readonly models: {
    runtime: Model;
    effective: ReturnType<typeof resolveEmbeddedRunEffectiveModel>["effectiveModel"];
  };
  apiKeyInfo: ResolvedProviderAuth | null;
  lastProfileId: string | undefined;
  runtimeAuthState: RuntimeAuthState | null;
  runtimeAuthRefreshCancelled: boolean;
  profileIndex: number;
  thinkLevel: ThinkLevel;
};

type RuntimeApiKeySink = {
  setRuntimeApiKey(provider: string, apiKey: string): void;
};

type LogLike = {
  debug(message: string): void;
  info(message: string): void;
  warn(message: string): void;
};

function resolveUnavailableAuthReason(
  store: AuthProfileStore,
  profileIds: string[],
): FailoverReason {
  return resolveProfilesUnavailableReason({ store, profileIds }) ?? "unknown";
}

/** Decides whether one automatic profile may bypass its current cooldown. */
export function resolveEmbeddedAuthCooldownProbePolicy(params: {
  authStore: AuthProfileStore;
  profileCandidates: Array<string | undefined>;
  lockedProfileId?: string;
  modelId: string;
  allowTransientCooldownProbe: boolean;
}): { probeProfileIds: ReadonlySet<string>; unavailableReason: FailoverReason | null } {
  const autoProfileCandidates = params.profileCandidates.filter(
    (candidate): candidate is string =>
      typeof candidate === "string" && candidate.length > 0 && candidate !== params.lockedProfileId,
  );
  const allAutoProfilesInCooldown =
    autoProfileCandidates.length > 0 &&
    autoProfileCandidates.every((candidate) =>
      isProfileInCooldown(params.authStore, candidate, undefined, params.modelId),
    );
  const unavailableReason = allAutoProfilesInCooldown
    ? resolveUnavailableAuthReason(params.authStore, autoProfileCandidates)
    : null;
  const probeProfileIds = new Set<string>();
  if (
    params.allowTransientCooldownProbe &&
    allAutoProfilesInCooldown &&
    shouldUseTransientCooldownProbeSlot(unavailableReason)
  ) {
    for (const candidate of autoProfileCandidates) {
      const candidateReason = resolveUnavailableAuthReason(params.authStore, [candidate]);
      if (shouldUseTransientCooldownProbeSlot(candidateReason)) {
        probeProfileIds.add(candidate);
      }
    }
  }
  return { probeProfileIds, unavailableReason };
}

/** Shares one transient probe across the selected owner's initial and later candidates. */
export function createEmbeddedAuthProfileAdmission(
  params: Parameters<typeof resolveEmbeddedAuthCooldownProbePolicy>[0] & {
    provider: string;
    log: Pick<LogLike, "warn">;
  },
): (candidate: string | undefined) => boolean {
  const policy = resolveEmbeddedAuthCooldownProbePolicy(params);
  let probed = false;
  return (candidate) => {
    if (
      !candidate ||
      !isProfileInCooldown(params.authStore, candidate, undefined, params.modelId)
    ) {
      return true;
    }
    if (probed || !policy.probeProfileIds.has(candidate)) {
      return false;
    }
    probed = true;
    params.log.warn(
      `checking cooldowned auth profile for ${params.provider}/${params.modelId} due to ${policy.unavailableReason ?? "transient"} unavailability`,
    );
    return true;
  };
}

/**
 * Coordinates auth profile selection, runtime auth preparation/refresh, and
 * profile failover for one embedded run. Runtime snapshots and auth refreshes
 * share this state so profile rotation cannot leave either with stale credentials.
 */
export function createEmbeddedRunAuthController(params: {
  authProfileBinding?: RunEmbeddedAgentParams["authProfileBinding"];
  config: RunEmbeddedAgentParams["config"];
  agentDir: string;
  workspaceDir: string;
  authStore: AuthProfileStore;
  authStorage: RuntimeApiKeySink;
  profileCandidates: Array<string | undefined>;
  lockedProfileId?: string;
  initialThinkLevel: ThinkLevel;
  attemptedThinking: Set<ThinkLevel>;
  fallbackConfigured: boolean;
  allowTransientCooldownProbe: boolean;
  authProfileFailurePolicy?: AuthProfileFailurePolicy;
  authProfileStateMode?: "read-write" | "read-only";
  runId?: string;
  provider: string;
  modelId: string;
  state: EmbeddedRunAuthState;
  prepareModelForAuthProfile?(
    profileId: string | undefined,
    attemptIndex?: number,
  ): Promise<{
    runtimeModel: Model;
    authRequirement?: ProviderModelRouteAuthRequirement;
    allowAuthProfileFallback?: boolean;
    commit(): void;
  }>;
  log: LogLike;
}) {
  const { state } = params;
  // Runtime auth overlays are profile-scoped. Keep the pre-auth model so a
  // later profile cannot inherit an earlier profile's endpoint or headers.
  const baseRuntimeModel = state.models.runtime;
  const baseEffectiveModel = state.models.effective;

  const applyPreparedRuntimeRequestOverrides = (
    model: Model,
    preparedAuth: Parameters<typeof applyPreparedRuntimeAuthToModel>[1],
  ): void => {
    const runtimeModel = applyPreparedRuntimeAuthToModel(model, preparedAuth);
    if (runtimeModel === model) {
      return;
    }
    // Runtime auth plugins may override baseUrl and safe request auth headers,
    // while the shared applier strips privileged transport knobs.
    state.models.runtime = runtimeModel;
    state.models.effective = applyPreparedRuntimeAuthToModel(state.models.effective, preparedAuth);
  };

  const prepareRuntimeAuthForModel = async (prepareParams: {
    runtimeModel: Model;
    apiKey: string;
    authMode: string;
    profileId?: string;
  }) => {
    // Canonical observation follows credential resolution and precedes provider egress.
    // It catches another process replacing a profile that retained the same ID.
    await params.authProfileBinding?.revalidate();
    params.authProfileBinding?.assertCurrent();
    const preparedAuth = await prepareProviderRuntimeAuth({
      provider: prepareParams.runtimeModel.provider,
      config: params.config,
      workspaceDir: params.workspaceDir,
      env: process.env,
      context: {
        config: params.config,
        agentDir: params.agentDir,
        workspaceDir: params.workspaceDir,
        env: process.env,
        provider: prepareParams.runtimeModel.provider,
        modelId: params.modelId,
        model: prepareParams.runtimeModel,
        apiKey: prepareParams.apiKey,
        authMode: prepareParams.authMode,
        profileId: prepareParams.profileId,
      },
    });
    return protectPreparedProviderRuntimeAuth({
      provider: prepareParams.runtimeModel.provider,
      preparedAuth,
    });
  };

  const clearRuntimeAuthRefreshTimer = () => {
    const runtimeAuthState = state.runtimeAuthState;
    if (!runtimeAuthState?.refreshTimer) {
      return;
    }
    clearTimeout(runtimeAuthState.refreshTimer);
    runtimeAuthState.refreshTimer = undefined;
  };

  const stopRuntimeAuthRefreshTimer = () => {
    if (!state.runtimeAuthState) {
      return;
    }
    state.runtimeAuthRefreshCancelled = true;
    clearRuntimeAuthRefreshTimer();
  };

  const refreshRuntimeAuth = async (reason: string): Promise<void> => {
    const runtimeAuthState = state.runtimeAuthState;
    if (!runtimeAuthState) {
      return;
    }
    if (runtimeAuthState.refreshInFlight) {
      await runtimeAuthState.refreshInFlight;
      return;
    }
    // Publish only while the captured credential state is still active.
    const refreshPromise: Promise<void> = (async () => {
      const sourceApiKey = runtimeAuthState.sourceApiKey.trim();
      if (!sourceApiKey) {
        throw new Error(`Runtime auth refresh requires a source credential.`);
      }
      const runtimeModel = state.models.runtime;
      const preparedAuth = await prepareRuntimeAuthForModel({
        runtimeModel,
        apiKey: sourceApiKey,
        authMode: runtimeAuthState.authMode,
        profileId: runtimeAuthState.profileId,
      });
      if (!preparedAuth?.apiKey) {
        throw new Error(
          `Provider "${runtimeModel.provider}" does not support runtime auth refresh.`,
        );
      }
      if (state.runtimeAuthState !== runtimeAuthState) {
        params.log.debug(
          `Ignoring stale runtime auth refresh for ${runtimeModel.provider}; auth state advanced before ${reason} refresh completed.`,
        );
        return;
      }
      params.authStorage.setRuntimeApiKey(runtimeModel.provider, preparedAuth.apiKey);
      applyPreparedRuntimeRequestOverrides(runtimeModel, preparedAuth);
      state.runtimeAuthState = {
        ...runtimeAuthState,
        apiKey: preparedAuth.apiKey,
        expiresAt: preparedAuth.expiresAt,
      };
    })()
      .catch((err: unknown) => {
        const runtimeModel = state.models.runtime;
        params.log.warn(
          `Runtime auth refresh failed for ${runtimeModel.provider}: ${formatErrorMessage(err)}`,
        );
        throw err;
      })
      .finally(() => {
        const activeState = state.runtimeAuthState;
        if (activeState?.refreshInFlight === refreshPromise) {
          activeState.refreshInFlight = undefined;
        }
      });
    runtimeAuthState.refreshInFlight = refreshPromise;
    await refreshPromise;
  };

  const scheduleRuntimeAuthRefresh = (): void => {
    const runtimeAuthState = state.runtimeAuthState;
    if (!runtimeAuthState || state.runtimeAuthRefreshCancelled) {
      return;
    }
    const runtimeModel = state.models.runtime;
    if (!runtimeAuthState.sourceApiKey.trim()) {
      params.log.warn(
        `Skipping runtime auth refresh scheduling for ${runtimeModel.provider}; source credential missing.`,
      );
      return;
    }
    if (!runtimeAuthState.expiresAt) {
      return;
    }
    clearRuntimeAuthRefreshTimer();
    const now = Date.now();
    const refreshAt = runtimeAuthState.expiresAt - RUNTIME_AUTH_REFRESH_MARGIN_MS;
    const delayMs = clampRuntimeAuthRefreshDelayMs({
      refreshAt,
      now,
      minDelayMs: RUNTIME_AUTH_REFRESH_MIN_DELAY_MS,
    });
    const refresh = (reason: "scheduled" | "scheduled-retry") => {
      if (state.runtimeAuthRefreshCancelled) {
        return;
      }
      refreshRuntimeAuth(reason)
        .then(scheduleRuntimeAuthRefresh)
        .catch(() => {
          if (reason === "scheduled-retry" || state.runtimeAuthRefreshCancelled) {
            return;
          }
          const retryTimer = setTimeout(
            () => refresh("scheduled-retry"),
            RUNTIME_AUTH_REFRESH_RETRY_MS,
          );
          const activeRuntimeAuthState = state.runtimeAuthState;
          if (activeRuntimeAuthState) {
            activeRuntimeAuthState.refreshTimer = retryTimer;
          }
        });
    };
    runtimeAuthState.refreshTimer = setTimeout(() => refresh("scheduled"), delayMs);
  };

  const resolveAuthProfileFailoverReason = (failoverParams: {
    allInCooldown: boolean;
    message: string;
  }): FailoverReason => {
    if (failoverParams.allInCooldown) {
      const profileIds = params.profileCandidates.filter(
        (id): id is string => typeof id === "string" && id.length > 0,
      );
      return resolveUnavailableAuthReason(params.authStore, profileIds);
    }
    return classifyFailoverReason(failoverParams.message, { provider: params.provider }) ?? "auth";
  };

  const recordOAuthRefreshFailure = async (
    candidate: string | undefined,
    error: unknown,
  ): Promise<void> => {
    if (!(error instanceof OAuthRefreshFailureError)) {
      return;
    }
    const profileId = error.profileId ?? candidate;
    const provider = error.provider || params.provider;
    const errorText = formatErrorMessage(error);
    params.log.warn(
      `auth profile "${profileId ?? "(unknown)"}" failed for provider "${provider}": ${errorText}`,
    );
    if (!profileId || params.authProfileStateMode === "read-only") {
      return;
    }
    const reason = resolveAuthProfileFailureReason({
      failoverReason: resolveAuthProfileFailoverReason({
        allInCooldown: false,
        message: errorText,
      }),
      policy: params.authProfileFailurePolicy,
    });
    if (!reason) {
      return;
    }
    try {
      await markAuthProfileFailure({
        store: params.authStore,
        profileId,
        reason,
        cfg: params.config,
        agentDir: params.agentDir,
        runId: params.runId,
        modelId: params.modelId,
      });
    } catch (markError) {
      params.log.warn(
        `auth profile "${profileId}" failure bookkeeping failed for provider "${provider}": ${formatErrorMessage(markError)}`,
      );
    }
  };

  const throwAuthProfileFailover = (failoverParams: {
    allInCooldown: boolean;
    error?: unknown;
  }): never => {
    const provider = params.provider;
    const modelId = params.modelId;
    const messageForReason = failoverParams.error
      ? formatErrorMessage(failoverParams.error).trim()
      : "";
    const code = failoverParams.error ? getFailoverErrorCode(failoverParams.error) : undefined;
    const reason = resolveAuthProfileFailoverReason({
      allInCooldown: failoverParams.allInCooldown,
      message: messageForReason,
    });
    const message =
      (code === "selected_auth_profile_unavailable" ? messageForReason : undefined) ||
      renderAuthProfileFailoverCopy({
        reason,
        provider,
        allInCooldown: failoverParams.allInCooldown,
        recoveryHint: buildProviderAuthRecoveryHint({
          provider,
          config: params.config,
          workspaceDir: params.workspaceDir,
          env: process.env,
        }),
      });
    if (params.fallbackConfigured) {
      const authMode =
        reason === "billing" ||
        reason === "auth" ||
        reason === "auth_permanent" ||
        reason === "session_expired"
          ? resolveSubscriptionAuthModeForProfiles({
              store: params.authStore,
              profileIds: failoverParams.allInCooldown
                ? params.profileCandidates
                : [params.profileCandidates[state.profileIndex]],
            })
          : undefined;
      throw new FailoverError(message, {
        reason,
        provider,
        model: modelId,
        authMode,
        status: resolveFailoverStatus(reason, code),
        code,
        authProfileFailure: { allInCooldown: failoverParams.allInCooldown },
        cause: failoverParams.error,
      });
    }
    if (failoverParams.error instanceof Error) {
      throw failoverParams.error;
    }
    throw new Error(message);
  };

  const applyApiKeyInfo = async (
    candidate?: string,
    attemptIndex?: number,
    forceRefresh = false,
  ): Promise<void> => {
    const preparedModel = await params.prepareModelForAuthProfile?.(candidate, attemptIndex);
    const apiKeyInfo = await getApiKeyForModelCore({
      model: preparedModel?.runtimeModel ?? state.models.runtime,
      cfg: params.config,
      profileId: candidate,
      store: params.authStore,
      agentDir: params.agentDir,
      workspaceDir: params.workspaceDir,
      lockedProfile: forceRefresh || (candidate != null && candidate === params.lockedProfileId),
      forceRefresh,
      allowAuthProfileFallback: preparedModel?.allowAuthProfileFallback,
      secretSentinels: true,
    });
    if (
      preparedModel?.authRequirement &&
      !providerModelRouteAcceptsAuthMode({
        requirement: preparedModel.authRequirement,
        mode: apiKeyInfo.mode ?? (apiKeyInfo.apiKey ? "api-key" : undefined),
        authRequirement: resolveProviderModelAuthPolicy({
          provider: preparedModel.runtimeModel.provider,
          mode: apiKeyInfo.mode,
          authFlow: apiKeyInfo.authFlow,
          api: preparedModel.runtimeModel.api,
          baseUrl: preparedModel.runtimeModel.baseUrl,
        }).authRequirement,
      })
    ) {
      throw new Error(
        `Resolved ${apiKeyInfo.mode ?? "unknown"} credentials are incompatible with the selected ${preparedModel.authRequirement} route for ${preparedModel.runtimeModel.provider}.`,
      );
    }
    params.authProfileBinding?.assertCurrent();
    if (params.authProfileBinding && apiKeyInfo.profileId !== params.authProfileBinding.profileId) {
      throw new Error("Resolved credentials do not belong to the automation inference owner.");
    }
    // Preserve the checked source even when resolution fails before route commit.
    state.apiKeyInfo = apiKeyInfo;
    const usesAwsSdkChain = !apiKeyInfo.apiKey && apiKeyInfo.mode === "aws-sdk";
    if (!apiKeyInfo.apiKey && !usesAwsSdkChain) {
      const runtimeModel = preparedModel?.runtimeModel ?? state.models.runtime;
      throw new MissingProviderAuthError(runtimeModel.provider, apiKeyInfo);
    }
    preparedModel?.commit();
    if (!preparedModel?.authRequirement) {
      state.models.runtime = baseRuntimeModel;
      state.models.effective = baseEffectiveModel;
    }
    const authAuthority = getProviderAuthAuthority(apiKeyInfo);
    state.models.runtime = attachProviderAuthAuthority(state.models.runtime, authAuthority);
    state.models.effective = attachProviderAuthAuthority(state.models.effective, authAuthority);
    const runtimeModel = state.models.runtime;
    // AWS's default credential chain has no explicit key. The sentinel admits
    // runtime auth preparation or, without a plugin token, SDK request signing.
    const sourceApiKey = apiKeyInfo.apiKey || "__aws_sdk_auth__";
    const profileId = usesAwsSdkChain ? (apiKeyInfo.profileId ?? candidate) : apiKeyInfo.profileId;
    let runtimeAuthHandled = false;
    try {
      const preparedAuth = await prepareRuntimeAuthForModel({
        runtimeModel,
        apiKey: sourceApiKey,
        authMode: apiKeyInfo.mode,
        profileId: apiKeyInfo.profileId,
      });
      applyPreparedRuntimeRequestOverrides(runtimeModel, preparedAuth);
      if (preparedAuth?.apiKey) {
        clearRuntimeAuthRefreshTimer();
        params.authStorage.setRuntimeApiKey(runtimeModel.provider, preparedAuth.apiKey);
        state.runtimeAuthState = {
          apiKey: preparedAuth.apiKey,
          sourceApiKey,
          authMode: apiKeyInfo.mode,
          profileId,
          expiresAt: preparedAuth.expiresAt,
        };
        if (preparedAuth.expiresAt) {
          scheduleRuntimeAuthRefresh();
        }
        runtimeAuthHandled = true;
      }
    } catch (error) {
      if (params.authProfileBinding || !usesAwsSdkChain) {
        throw error;
      }
      params.log.warn(
        `prepareProviderRuntimeAuth failed for ${runtimeModel.provider}, falling back to sentinel: ${formatErrorMessage(error)}`,
      );
    }
    if (!runtimeAuthHandled) {
      clearRuntimeAuthRefreshTimer();
      params.authStorage.setRuntimeApiKey(runtimeModel.provider, sourceApiKey);
      state.runtimeAuthState = null;
    }
    state.lastProfileId = profileId;
  };

  const advanceAuthProfile = async (): Promise<boolean> => {
    const advanced = await advanceAuthProfileCandidate({
      candidates: params.profileCandidates,
      state,
      isAvailable: (candidate) =>
        !candidate || !isProfileInCooldown(params.authStore, candidate, undefined, params.modelId),
      tryPrepare: async (candidate, index) => {
        try {
          await applyApiKeyInfo(candidate, index);
          return true;
        } catch (error) {
          if (error instanceof SecretSurfaceUnavailableError) {
            throw error;
          }
          await recordOAuthRefreshFailure(candidate, error);
          return false;
        }
      },
    });
    if (advanced) {
      state.thinkLevel = params.initialThinkLevel;
      params.attemptedThinking.clear();
    }
    return advanced;
  };

  const initializeAuthProfile = async () => {
    try {
      const admitCandidate = createEmbeddedAuthProfileAdmission(params);
      while (state.profileIndex < params.profileCandidates.length) {
        if (!admitCandidate(params.profileCandidates[state.profileIndex])) {
          state.profileIndex += 1;
          continue;
        }
        await applyApiKeyInfo(params.profileCandidates[state.profileIndex], state.profileIndex);
        break;
      }
      if (state.profileIndex >= params.profileCandidates.length) {
        throwAuthProfileFailover({ allInCooldown: true });
      }
    } catch (err) {
      if (err instanceof FailoverError || err instanceof SecretSurfaceUnavailableError) {
        throw err;
      }
      await recordOAuthRefreshFailure(params.profileCandidates[state.profileIndex], err);
      const advanced = await advanceAuthProfile();
      if (!advanced) {
        throwAuthProfileFailover({ allInCooldown: false, error: err });
      }
    }
  };

  const maybeRefreshRuntimeAuthForAuthError = async (
    errorText: string,
    retried: boolean,
  ): Promise<boolean> => {
    if (retried || classifyFailoverReason(errorText, { provider: params.provider }) !== "auth") {
      return false;
    }
    try {
      if (state.runtimeAuthState) {
        await refreshRuntimeAuth("auth-error");
        scheduleRuntimeAuthRefresh();
      } else if (
        params.provider === "openai" &&
        state.lastProfileId &&
        state.apiKeyInfo?.mode === "oauth" &&
        state.apiKeyInfo.authFlow === "chatgpt-token-sharing" &&
        /\btoken_expired\b|\bauthentication token is expired\b/iu.test(errorText)
      ) {
        await applyApiKeyInfo(state.lastProfileId, state.profileIndex, true);
      } else {
        return false;
      }
      return true;
    } catch {
      return false;
    }
  };

  return {
    applyAuthProfileCandidate: applyApiKeyInfo,
    advanceAuthProfile,
    initializeAuthProfile,
    maybeRefreshRuntimeAuthForAuthError,
    stopRuntimeAuthRefreshTimer,
  };
}
