import { formatErrorMessage } from "../../../infra/errors.js";
import type { Model } from "../../../llm/types.js";
import {
  attachProviderAuthAuthority,
  attachProviderRequestAuth,
  assertProviderAuthAuthority,
  getProviderAuthAuthority,
} from "../../../plugins/provider-auth-authority.js";
import { prepareProviderRuntimeAuth } from "../../../plugins/provider-runtime.js";
import type { ProviderCreateStreamFnContext } from "../../../plugins/provider-transport.types.js";
import { SecretSurfaceUnavailableError } from "../../../secrets/runtime-degraded-state.js";
import { resolveSafeTimeoutDelayMs } from "../../../utils/timer-delay.js";
import {
  isProfileInCooldown,
  markAuthProfileFailure,
  resolveProfilesUnavailableReason,
  resolveSubscriptionAuthModeForProfiles,
} from "../../auth-profiles.js";
import { advanceAuthProfileCandidate } from "../../auth-profiles/advance.js";
import {
  captureAuthProfileAuthorization,
  type AuthProfileAuthorization,
} from "../../auth-profiles/authorization.js";
import { hasOAuthIdentity, isSafeToCopyOAuthIdentity } from "../../auth-profiles/oauth-identity.js";
import { OAuthRefreshFailureError } from "../../auth-profiles/oauth-refresh-failure.js";
import {
  getScopedSharedAuthStore,
  isEnvOnlyAuthProfileRuntime,
} from "../../auth-profiles/runtime-scope.js";
import { isSetupCredentialAccessible } from "../../auth-profiles/setup-access.js";
import { FailoverError, resolveFailoverStatus } from "../../failover-error.js";
import { classifyFailoverReason } from "../../failover/classify.js";
import { getFailoverErrorCode } from "../../failover/error.js";
import { resolveRetryAfterMs } from "../../failover/retry-evidence.js";
import type { FailoverReason } from "../../failover/signal.js";
import { renderAuthProfileFailoverCopy } from "../../failover/user-copy.js";
import { resolveProviderModelAuthPolicy } from "../../model-auth-policy.js";
import { getApiKeyForModelCore, MissingProviderAuthError } from "../../model-auth.js";
import { buildProviderAuthRecoveryHint } from "../../provider-auth-recovery-hint.js";
import { providerModelRouteAcceptsAuthMode } from "../../provider-model-route-auth.js";
import { applyPreparedRuntimeAuthToModel } from "../../provider-request-config.js";
import { protectPreparedProviderRuntimeAuth } from "../../provider-runtime-auth-protection.js";
import { unwrapSecretSentinelsForProviderEgress } from "../../provider-secret-egress.js";
import { createRuntimeAuthDeadline } from "../../runtime-auth-refresh.js";
import { resolveAgentTimeoutMs } from "../../timeout.js";
import type { EmbeddedRunAuthControllerParams, LogLike } from "./auth-controller.types.js";
import {
  resolveAuthProfileFailureReason,
  resolveEmbeddedAuthCooldownProbePolicy,
} from "./auth-profile-failure-policy.js";
import {
  RUNTIME_AUTH_REFRESH_MARGIN_MS,
  RUNTIME_AUTH_REFRESH_MIN_DELAY_MS,
  RUNTIME_AUTH_REFRESH_RETRY_MS,
} from "./helpers.js";

export { resolveEmbeddedAuthCooldownProbePolicy } from "./auth-profile-failure-policy.js";
export type { EmbeddedRunAuthState } from "./auth-controller.types.js";

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
 * Own profile selection, runtime auth refresh and failover for one run's shared snapshots.
 */
export function createEmbeddedRunAuthController(params: EmbeddedRunAuthControllerParams) {
  const { state } = params;
  const {
    run: withAuthDeadline,
    signal: authSignal,
    cancel: cancelAuth,
  } = createRuntimeAuthDeadline({
    provider: params.provider,
    timeoutMs: resolveAgentTimeoutMs({ cfg: params.config, overrideMs: params.timeoutMs }),
    signal: params.signal,
    getDeadline: params.getDeadline,
  });
  let requestAuthGeneration: object | undefined;
  let requestAuthAuthorization: AuthProfileAuthorization | undefined;
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

  const prepareRuntimeAuthForModel = (prepareParams: {
    runtimeModel: Model;
    apiKey: string;
    authMode: string;
    profileId?: string;
    signal?: AbortSignal;
  }) =>
    withAuthDeadline(
      "runtime auth exchange",
      async (signal) => {
        // Canonical observation follows credential resolution and precedes provider egress.
        // It catches another process replacing a profile that retained the same ID.
        await params.authProfileBinding?.revalidate();
        signal.throwIfAborted();
        params.assertCurrent?.();
        params.authProfileBinding?.assertCurrent();
        const preparedAuth = await prepareProviderRuntimeAuth({
          assertCurrent: () => {
            signal.throwIfAborted();
            params.assertCurrent?.();
          },
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
            signal,
          },
        });
        signal.throwIfAborted();
        return protectPreparedProviderRuntimeAuth({
          provider: prepareParams.runtimeModel.provider,
          preparedAuth,
        });
      },
      prepareParams.signal,
    );

  const clearRuntimeAuthRefreshTimer = () => {
    const runtimeAuthState = state.runtimeAuthState;
    if (!runtimeAuthState?.refreshTimer) {
      return;
    }
    clearTimeout(runtimeAuthState.refreshTimer);
    runtimeAuthState.refreshTimer = undefined;
  };

  const stopRuntimeAuthRefreshTimer = () => {
    state.runtimeAuthRefreshCancelled = true;
    requestAuthAuthorization?.dispose();
    requestAuthAuthorization = undefined;
    clearRuntimeAuthRefreshTimer();
  };

  const refreshRuntimeAuth = async (reason: string): Promise<void> => {
    const runtimeAuthState = state.runtimeAuthState;
    if (!runtimeAuthState) {
      return;
    }
    if (runtimeAuthState.refreshInFlight) {
      return runtimeAuthState.refreshInFlight;
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
    const delayMs = resolveSafeTimeoutDelayMs(refreshAt - now, {
      minMs: RUNTIME_AUTH_REFRESH_MIN_DELAY_MS,
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
      return resolveProfilesUnavailableReason({ store: params.authStore, profileIds }) ?? "unknown";
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
    const reason =
      error.retryable && params.authProfileFailurePolicy !== "local"
        ? "timeout"
        : resolveAuthProfileFailureReason({
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
        retryAfterMs: resolveRetryAfterMs(errorText, Date.now(), error),
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
    requestAuthGeneration = undefined;
    requestAuthAuthorization?.dispose();
    requestAuthAuthorization = undefined;
    const preparedModel = await params.prepareModelForAuthProfile?.(candidate, attemptIndex);
    const apiKeyInfo = await withAuthDeadline("credential resolution", (signal) =>
      getApiKeyForModelCore({
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
        signal,
      }),
    );
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
    const generation = {};
    requestAuthGeneration = generation;
    const selected = profileId ? params.authStore.profiles[profileId] : undefined;
    const assertSelectionCurrent = () => {
      authSignal.throwIfAborted();
      params.assertCurrent?.();
      if (state.runtimeAuthRefreshCancelled || requestAuthGeneration !== generation) {
        throw new Error("Provider request auth capability is closed.");
      }
      params.authProfileBinding?.assertCurrent();
      assertProviderAuthAuthority(runtimeModel);
    };
    // Canonical writers retire account authorization on reconnect/removal; overlays keep their owner.
    const setupVerification =
      profileId &&
      selected?.setup?.replacement &&
      isSetupCredentialAccessible({ profileId, credential: selected, agentDir: params.agentDir });
    const requestAuthSupported =
      !isEnvOnlyAuthProfileRuntime() &&
      !getScopedSharedAuthStore() &&
      !setupVerification &&
      !params.authStore.runtimeExternalProfileIds?.includes(profileId ?? "");
    const authorization =
      requestAuthSupported && apiKeyInfo.mode === "oauth" && profileId && selected?.type === "oauth"
        ? await captureAuthProfileAuthorization({
            profileId,
            agentDir: params.agentDir,
            cfg: params.config,
            assertCurrent: assertSelectionCurrent,
          })
        : undefined;
    requestAuthAuthorization = authorization;
    let runtimeAuthHandled = false;
    try {
      const preparedAuth = await prepareRuntimeAuthForModel({
        runtimeModel,
        apiKey: sourceApiKey,
        authMode: apiKeyInfo.mode,
        profileId: apiKeyInfo.profileId,
      });
      if (authorization) {
        assertSelectionCurrent();
        authorization.assertCurrent();
      }
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
      if (authSignal.aborted || params.authProfileBinding || !usesAwsSdkChain) {
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
    const requestAuth: ProviderCreateStreamFnContext["requestAuth"] =
      authorization && apiKeyInfo.mode === "oauth" && profileId && selected?.type === "oauth"
        ? {
            version: 1,
            async resolve({ signal }) {
              const requestSignal = signal ? AbortSignal.any([authSignal, signal]) : authSignal;
              const assertCurrent = () => {
                requestSignal.throwIfAborted();
                assertSelectionCurrent();
                authorization.assertCurrent();
              };
              assertCurrent();
              // Omit the attempt's captured store. Canonical resolution owns refresh/rotation.
              const current = await withAuthDeadline(
                "credential resolution",
                (credentialSignal) =>
                  getApiKeyForModelCore({
                    model: runtimeModel,
                    cfg: params.config,
                    profileId,
                    lockedProfile: true,
                    allowAuthProfileFallback: false,
                    agentDir: params.agentDir,
                    workspaceDir: params.workspaceDir,
                    signal: credentialSignal,
                    assertRefreshAdmission: assertCurrent,
                    validateOAuthCredential: (credential) => {
                      if (
                        credential.provider !== selected.provider ||
                        credential.authFlow !== selected.authFlow ||
                        !isSafeToCopyOAuthIdentity(selected, credential) ||
                        (!hasOAuthIdentity(selected) && credential.refresh !== selected.refresh)
                      ) {
                        throw new Error("Provider request credentials changed account identity.");
                      }
                    },
                  }),
                requestSignal,
              );
              assertCurrent();
              if (current.profileId !== profileId || current.mode !== "oauth" || !current.apiKey) {
                throw new Error(
                  "Provider request credentials no longer match the selected OAuth profile.",
                );
              }
              const prepared = await prepareRuntimeAuthForModel({
                runtimeModel,
                apiKey: current.apiKey,
                authMode: "oauth",
                profileId,
                signal: requestSignal,
              });
              const assertRequestCurrent = () => {
                assertCurrent();
                assertProviderAuthAuthority(current);
              };
              assertRequestCurrent();
              const apiKey = prepared?.apiKey ?? current.apiKey;
              params.authStorage.setRuntimeApiKey(runtimeModel.provider, apiKey);
              state.apiKeyInfo = current;
              return {
                apiKey: unwrapSecretSentinelsForProviderEgress(apiKey, "provider request auth"),
                assertCurrent: assertRequestCurrent,
              };
            },
          }
        : undefined;
    state.models.runtime = attachProviderRequestAuth(state.models.runtime, requestAuth);
    state.models.effective = attachProviderRequestAuth(state.models.effective, requestAuth);
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
          if (authSignal.aborted || error instanceof SecretSurfaceUnavailableError) {
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
      if (
        authSignal.aborted ||
        err instanceof FailoverError ||
        err instanceof SecretSurfaceUnavailableError
      ) {
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
    } catch (error) {
      if (authSignal.aborted) {
        throw error;
      }
      return false;
    }
  };

  return {
    close: () => {
      stopRuntimeAuthRefreshTimer();
      cancelAuth();
    },
    applyAuthProfileCandidate: applyApiKeyInfo,
    advanceAuthProfile,
    initializeAuthProfile,
    maybeRefreshRuntimeAuthForAuthError,
    stopRuntimeAuthRefreshTimer,
  };
}
