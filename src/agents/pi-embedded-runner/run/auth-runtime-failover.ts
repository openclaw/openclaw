import type { Api, Model } from "@mariozechner/pi-ai";
import type { AuthStorage } from "@mariozechner/pi-coding-agent";
import type { OpenClawConfig } from "../../../config/config.js";
import type { AuthProfileStore } from "../../auth-profiles.js";
import {
  isProfileInCooldown,
  resolveProfilesUnavailableReason,
  saveAuthProfileStore,
  upsertAuthProfileWithLock,
} from "../../auth-profiles.js";
import { FailoverError, resolveFailoverStatus } from "../../failover-error.js";
import {
  getApiKeyForModel,
  isSystemKeychainProvider,
  resolveAuthProfileOrder,
  type ResolvedProviderAuth,
} from "../../model-auth.js";
import { normalizeProviderId } from "../../model-selection.js";
import {
  classifyFailoverReason,
  isFailoverErrorMessage,
  type FailoverReason,
} from "../../pi-embedded-helpers.js";
import { log } from "../logger.js";
import { describeUnknownError } from "../utils.js";

const SYNTHETIC_SYSTEM_KEYCHAIN_PROFILE_SUFFIX = "system-keychain";
const COPILOT_REFRESH_MARGIN_MS = 5 * 60 * 1000;
const COPILOT_REFRESH_RETRY_MS = 60 * 1000;
const COPILOT_REFRESH_MIN_DELAY_MS = 5 * 1000;

type AuthResolutionRuntime = "pi" | "claude-sdk" | undefined;

type CopilotTokenState = {
  githubToken: string;
  expiresAt: number;
  refreshTimer?: ReturnType<typeof setTimeout>;
  refreshInFlight?: Promise<void>;
};

export type AuthProfileCandidate = {
  profileId?: string;
  resolveProfileId?: string;
};

export type RunAuthResolutionState = {
  readonly runtimeOverride: AuthResolutionRuntime;
  readonly authProvider: string;
  readonly lockedProfileId?: string;
  readonly profileCandidates: AuthProfileCandidate[];
  readonly profileIndex: number;
  advanceProfileIndex: () => void;
  fallBackToPiRuntime: () => Promise<boolean>;
};

async function ensureSyntheticSystemKeychainProfile(
  authStore: AuthProfileStore,
  providerId: string,
  agentDir: string | undefined,
): Promise<string> {
  const syntheticProfileId = `${providerId}:${SYNTHETIC_SYSTEM_KEYCHAIN_PROFILE_SUFFIX}`;
  const credential = {
    type: "token" as const,
    provider: providerId,
    token: SYNTHETIC_SYSTEM_KEYCHAIN_PROFILE_SUFFIX,
  };
  if (!authStore.profiles[syntheticProfileId]) {
    authStore.profiles[syntheticProfileId] = credential;
  }
  const lockedStore = await upsertAuthProfileWithLock({
    profileId: syntheticProfileId,
    credential,
    agentDir,
  });
  if (lockedStore?.profiles) {
    authStore.profiles = lockedStore.profiles;
  } else {
    // Best-effort fallback when lock write fails unexpectedly.
    saveAuthProfileStore(authStore, agentDir);
  }
  return syntheticProfileId;
}

export async function createRunAuthResolutionState(params: {
  provider: string;
  cfg: OpenClawConfig | undefined;
  authStore: AuthProfileStore;
  agentDir: string | undefined;
  preferredProfileId: string | undefined;
  authProfileIdSource: string | undefined;
}): Promise<RunAuthResolutionState> {
  const normalizedProvider = normalizeProviderId(params.provider);
  const systemKeychain = isSystemKeychainProvider(normalizedProvider);

  if (systemKeychain) {
    let runtimeOverride: AuthResolutionRuntime = "claude-sdk";
    let profileIndex = 0;

    const syntheticProfileId = await ensureSyntheticSystemKeychainProfile(
      params.authStore,
      normalizedProvider,
      params.agentDir,
    );
    const profileCandidates: AuthProfileCandidate[] = [
      { profileId: syntheticProfileId, resolveProfileId: undefined },
    ];

    return {
      get runtimeOverride() {
        return runtimeOverride;
      },
      get authProvider() {
        return params.provider;
      },
      get lockedProfileId() {
        return undefined;
      },
      get profileCandidates() {
        return profileCandidates;
      },
      get profileIndex() {
        return profileIndex;
      },
      advanceProfileIndex() {
        profileIndex += 1;
      },
      async fallBackToPiRuntime() {
        if (runtimeOverride !== "claude-sdk") {
          return false;
        }
        // Keep authProvider unchanged to avoid crossing into a different provider's auth.
        runtimeOverride = "pi";
        profileIndex = 0;
        return true;
      },
    };
  }

  const profileOrder = resolveAuthProfileOrder({
    cfg: params.cfg,
    store: params.authStore,
    provider: normalizedProvider,
    preferredProfile: params.preferredProfileId,
  });

  let lockedProfileId: string | undefined;
  if (params.authProfileIdSource === "user" && params.preferredProfileId) {
    const lockedProfile = params.authStore.profiles[params.preferredProfileId];
    if (lockedProfile && normalizeProviderId(lockedProfile.provider) === normalizedProvider) {
      lockedProfileId = params.preferredProfileId;
      if (profileOrder.length > 0 && !profileOrder.includes(lockedProfileId)) {
        throw new Error(
          `Auth profile "${lockedProfileId}" is not configured for ${normalizedProvider}.`,
        );
      }
    }
  }

  const profileCandidates: AuthProfileCandidate[] = lockedProfileId
    ? [{ profileId: lockedProfileId, resolveProfileId: lockedProfileId }]
    : profileOrder.length > 0
      ? profileOrder.map((id) => ({ profileId: id, resolveProfileId: id }))
      : [{ profileId: undefined, resolveProfileId: undefined }];

  let profileIndex = 0;

  return {
    get runtimeOverride() {
      return undefined;
    },
    get authProvider() {
      return params.provider;
    },
    get lockedProfileId() {
      return lockedProfileId;
    },
    get profileCandidates() {
      return profileCandidates;
    },
    get profileIndex() {
      return profileIndex;
    },
    advanceProfileIndex() {
      if (lockedProfileId) {
        return;
      }
      profileIndex += 1;
    },
    async fallBackToPiRuntime() {
      return false;
    },
  };
}

export type CopilotTokenRefresher = {
  initializeWithGithubToken(githubToken: string): Promise<void>;
  syncForCurrentProfile(reason: string, githubToken: string): Promise<boolean>;
  maybeRefreshForAuthError(
    errorText: string,
    retried: boolean,
    githubToken: string,
  ): Promise<boolean>;
  stop(): void;
};

export function createCopilotTokenRefresher(params: {
  authStorage: AuthStorage;
  provider: string;
}): CopilotTokenRefresher {
  const state: CopilotTokenState = { githubToken: "", expiresAt: 0 };
  let cancelled = false;

  const clearTimer = (): void => {
    if (!state.refreshTimer) {
      return;
    }
    clearTimeout(state.refreshTimer);
    state.refreshTimer = undefined;
  };

  const stop = (): void => {
    cancelled = true;
    clearTimer();
  };

  const refreshToken = async (reason: string, githubToken?: string): Promise<void> => {
    if (state.refreshInFlight) {
      await state.refreshInFlight;
      return;
    }
    state.refreshInFlight = (async () => {
      const token = (githubToken ?? "").trim() || state.githubToken.trim();
      if (!token) {
        throw new Error("Copilot refresh requires a GitHub token.");
      }
      log.debug(`Refreshing GitHub Copilot token (${reason})...`);
      const { resolveCopilotApiToken } = await import("../../../providers/github-copilot-token.js");
      const copilotToken = await resolveCopilotApiToken({ githubToken: token });
      params.authStorage.setRuntimeApiKey(params.provider, copilotToken.token);
      state.githubToken = token;
      state.expiresAt = copilotToken.expiresAt;
      const remaining = copilotToken.expiresAt - Date.now();
      log.debug(
        `Copilot token refreshed; expires in ${Math.max(0, Math.floor(remaining / 1000))}s.`,
      );
    })()
      .catch((err) => {
        log.warn(`Copilot token refresh failed: ${describeUnknownError(err)}`);
        throw err;
      })
      .finally(() => {
        state.refreshInFlight = undefined;
      });
    await state.refreshInFlight;
  };

  const scheduleRefresh = (): void => {
    if (cancelled) {
      return;
    }
    if (!state.githubToken.trim()) {
      log.warn("Skipping Copilot refresh scheduling; GitHub token missing.");
      return;
    }
    clearTimer();
    const refreshAt = state.expiresAt - COPILOT_REFRESH_MARGIN_MS;
    const delayMs = Math.max(COPILOT_REFRESH_MIN_DELAY_MS, refreshAt - Date.now());
    const timer = setTimeout(() => {
      if (cancelled) {
        return;
      }
      refreshToken("scheduled")
        .then(() => scheduleRefresh())
        .catch(() => {
          if (cancelled) {
            return;
          }
          const retryTimer = setTimeout(() => {
            if (cancelled) {
              return;
            }
            refreshToken("scheduled-retry")
              .then(() => scheduleRefresh())
              .catch(() => undefined);
          }, COPILOT_REFRESH_RETRY_MS);
          state.refreshTimer = retryTimer;
          if (cancelled) {
            clearTimeout(retryTimer);
            state.refreshTimer = undefined;
          }
        });
    }, delayMs);
    state.refreshTimer = timer;
    if (cancelled) {
      clearTimeout(timer);
      state.refreshTimer = undefined;
    }
  };

  const initializeWithGithubToken = async (githubToken: string): Promise<void> => {
    const { resolveCopilotApiToken } = await import("../../../providers/github-copilot-token.js");
    const copilotToken = await resolveCopilotApiToken({ githubToken });
    params.authStorage.setRuntimeApiKey(params.provider, copilotToken.token);
    state.githubToken = githubToken.trim();
    state.expiresAt = copilotToken.expiresAt;
  };

  const syncForCurrentProfile = async (reason: string, githubToken: string): Promise<boolean> => {
    const token = githubToken.trim();
    if (!token) {
      return false;
    }
    state.githubToken = token;
    const tokenStillFresh =
      state.expiresAt > Date.now() + COPILOT_REFRESH_MARGIN_MS && reason !== "auth-error";
    if (tokenStillFresh) {
      scheduleRefresh();
      return true;
    }
    try {
      await refreshToken(reason, token);
      scheduleRefresh();
      return true;
    } catch {
      return false;
    }
  };

  const maybeRefreshForAuthError = async (
    errorText: string,
    retried: boolean,
    githubToken: string,
  ): Promise<boolean> => {
    if (retried) {
      return false;
    }
    if (!isFailoverErrorMessage(errorText)) {
      return false;
    }
    if (classifyFailoverReason(errorText) !== "auth") {
      return false;
    }
    return syncForCurrentProfile("auth-error", githubToken);
  };

  return { initializeWithGithubToken, syncForCurrentProfile, maybeRefreshForAuthError, stop };
}

type CreateRunAuthRuntimeFailoverControllerParams = {
  provider: string;
  modelId: string;
  model: Model<Api>;
  cfg: OpenClawConfig | undefined;
  agentDir: string | undefined;
  authStore: AuthProfileStore;
  authStorage: AuthStorage;
  fallbackConfigured: boolean;
  preferredProfileId: string | undefined;
  authProfileIdSource: "auto" | "user" | undefined;
  onAuthRotationSuccess?: () => void;
  onClaudeSdkToPiFallback?: () => void;
  createAuthResolutionState?: (params: {
    provider: string;
    cfg: OpenClawConfig | undefined;
    authStore: AuthProfileStore;
    agentDir: string | undefined;
    preferredProfileId: string | undefined;
    authProfileIdSource: string | undefined;
  }) => Promise<RunAuthResolutionState>;
};

export type RunAuthRuntimeFailoverController = {
  readonly authResolution: RunAuthResolutionState;
  readonly apiKeyInfo: ResolvedProviderAuth | null;
  readonly lastProfileId: string | undefined;
  resolveAuthLookupModel: () => Model<Api>;
  advanceAuthProfile: () => Promise<boolean>;
  syncCopilotRefreshForCurrentProfile: (reason: string) => Promise<boolean>;
  maybeRefreshCopilotForAuthError: (errorText: string, retried: boolean) => Promise<boolean>;
  stopCopilotRefreshTimer: () => void;
};

export async function createRunAuthRuntimeFailoverController(
  params: CreateRunAuthRuntimeFailoverControllerParams,
): Promise<RunAuthRuntimeFailoverController> {
  const authResolution = await (params.createAuthResolutionState ?? createRunAuthResolutionState)({
    provider: params.provider,
    cfg: params.cfg,
    authStore: params.authStore,
    agentDir: params.agentDir,
    preferredProfileId: params.preferredProfileId,
    authProfileIdSource: params.authProfileIdSource,
  });

  let apiKeyInfo: ResolvedProviderAuth | null = null;
  let lastProfileId: string | undefined;
  let sawNonCooldownCandidateFailure = false;
  let lastCandidateResolutionError: unknown;

  const copilotRefresher: CopilotTokenRefresher | null =
    authResolution.authProvider === "github-copilot"
      ? createCopilotTokenRefresher({
          authStorage: params.authStorage,
          provider: authResolution.authProvider,
        })
      : null;

  const resolveAuthLookupModel = () =>
    authResolution.authProvider === params.model.provider
      ? params.model
      : { ...params.model, provider: authResolution.authProvider };

  const resolveAuthProfileFailoverReason = (args: {
    allInCooldown: boolean;
    message: string;
    profileIds?: Array<string | undefined>;
  }): FailoverReason => {
    if (args.allInCooldown) {
      const profileIds = (
        args.profileIds ?? authResolution.profileCandidates.map((candidate) => candidate.profileId)
      ).filter((id): id is string => typeof id === "string" && id.length > 0);
      if (profileIds.length === 0) {
        const classified = classifyFailoverReason(args.message);
        return classified ?? "auth";
      }
      return (
        resolveProfilesUnavailableReason({
          store: params.authStore,
          profileIds,
        }) ?? "rate_limit"
      );
    }
    const classified = classifyFailoverReason(args.message);
    return classified ?? "auth";
  };

  const throwAuthProfileFailover = (args: {
    allInCooldown: boolean;
    message?: string;
    error?: unknown;
  }): never => {
    const fallbackMessage = `No available auth profile for ${authResolution.authProvider} (all in cooldown or unavailable).`;
    const message =
      args.message?.trim() ||
      (args.error ? describeUnknownError(args.error).trim() : "") ||
      fallbackMessage;
    const reason = resolveAuthProfileFailoverReason({
      allInCooldown: args.allInCooldown,
      message,
      profileIds: authResolution.profileCandidates.map((candidate) => candidate.profileId),
    });
    if (params.fallbackConfigured) {
      throw new FailoverError(message, {
        reason,
        provider: authResolution.authProvider,
        model: params.modelId,
        status: resolveFailoverStatus(reason),
        cause: args.error,
      });
    }
    if (args.error instanceof Error) {
      throw args.error;
    }
    throw new Error(message);
  };

  const resolveApiKeyForCandidate = async (candidate?: AuthProfileCandidate) => {
    return getApiKeyForModel({
      model: resolveAuthLookupModel(),
      cfg: params.cfg,
      profileId: candidate?.resolveProfileId,
      store: params.authStore,
      agentDir: params.agentDir,
    });
  };

  const applyApiKeyInfo = async (candidate?: AuthProfileCandidate): Promise<void> => {
    apiKeyInfo = await resolveApiKeyForCandidate(candidate);
    const resolvedProfileId =
      apiKeyInfo.profileId ?? candidate?.profileId ?? candidate?.resolveProfileId;
    if (!apiKeyInfo.apiKey) {
      if (apiKeyInfo.mode !== "aws-sdk" && apiKeyInfo.mode !== "system-keychain") {
        throw new Error(
          `No API key resolved for provider "${authResolution.authProvider}" (auth mode: ${apiKeyInfo.mode}).`,
        );
      }
      lastProfileId = resolvedProfileId;
      return;
    }
    if (copilotRefresher) {
      await copilotRefresher.initializeWithGithubToken(apiKeyInfo.apiKey);
    } else {
      params.authStorage.setRuntimeApiKey(authResolution.authProvider, apiKeyInfo.apiKey);
    }
    lastProfileId = apiKeyInfo.profileId ?? candidate?.profileId;
  };

  const initializeCurrentAuthCandidate = async (): Promise<boolean> => {
    while (authResolution.profileIndex < authResolution.profileCandidates.length) {
      const candidate = authResolution.profileCandidates[authResolution.profileIndex];
      const candidateProfileId = candidate?.profileId;
      if (
        candidateProfileId &&
        candidateProfileId !== authResolution.lockedProfileId &&
        isProfileInCooldown(params.authStore, candidateProfileId)
      ) {
        authResolution.advanceProfileIndex();
        continue;
      }
      try {
        await applyApiKeyInfo(candidate);
        return true;
      } catch (error) {
        if (candidateProfileId && candidateProfileId === authResolution.lockedProfileId) {
          throw error;
        }
        sawNonCooldownCandidateFailure = true;
        lastCandidateResolutionError = error;
        authResolution.advanceProfileIndex();
      }
    }
    return false;
  };

  const currentGithubToken = () => apiKeyInfo?.apiKey?.trim() ?? "";

  const advanceAuthProfile = async (): Promise<boolean> => {
    // User-pinned profiles are locked and should never rotate within the run loop.
    if (authResolution.lockedProfileId) {
      return false;
    }
    authResolution.advanceProfileIndex();
    if (await initializeCurrentAuthCandidate()) {
      await copilotRefresher?.syncForCurrentProfile("profile-rotate", currentGithubToken());
      params.onAuthRotationSuccess?.();
      return true;
    }
    if (authResolution.runtimeOverride === "claude-sdk") {
      if (await authResolution.fallBackToPiRuntime()) {
        params.onClaudeSdkToPiFallback?.();
        if (await initializeCurrentAuthCandidate()) {
          await copilotRefresher?.syncForCurrentProfile("profile-rotate", currentGithubToken());
          params.onAuthRotationSuccess?.();
          return true;
        }
        log.warn(
          `Auth profile failover switched from Claude SDK to Pi runtime, but no usable auth profile was available for provider "${authResolution.authProvider}".`,
        );
      }
    }
    return false;
  };

  try {
    let initialized = await initializeCurrentAuthCandidate();
    if (!initialized && authResolution.runtimeOverride === "claude-sdk") {
      if (await authResolution.fallBackToPiRuntime()) {
        params.onClaudeSdkToPiFallback?.();
        initialized = await initializeCurrentAuthCandidate();
        if (!initialized) {
          log.warn(
            `Auth profile initialization switched from Claude SDK to Pi runtime, but no usable auth profile was available for provider "${authResolution.authProvider}".`,
          );
        }
      }
    }
    if (!initialized) {
      throwAuthProfileFailover({
        allInCooldown: !sawNonCooldownCandidateFailure,
        error: lastCandidateResolutionError,
      });
    }
  } catch (error) {
    if (error instanceof FailoverError) {
      throw error;
    }
    const activeCandidateProfileId =
      authResolution.profileCandidates[authResolution.profileIndex]?.profileId;
    if (activeCandidateProfileId && activeCandidateProfileId === authResolution.lockedProfileId) {
      throwAuthProfileFailover({ allInCooldown: false, error });
    }
    const advanced = await advanceAuthProfile();
    if (!advanced) {
      throwAuthProfileFailover({ allInCooldown: false, error });
    }
  }

  return {
    get authResolution() {
      return authResolution;
    },
    get apiKeyInfo() {
      return apiKeyInfo;
    },
    get lastProfileId() {
      return lastProfileId;
    },
    resolveAuthLookupModel,
    advanceAuthProfile,
    syncCopilotRefreshForCurrentProfile: (reason) =>
      copilotRefresher?.syncForCurrentProfile(reason, currentGithubToken()) ??
      Promise.resolve(false),
    maybeRefreshCopilotForAuthError: (errorText, retried) =>
      copilotRefresher?.maybeRefreshForAuthError(errorText, retried, currentGithubToken()) ??
      Promise.resolve(false),
    stopCopilotRefreshTimer: () => copilotRefresher?.stop(),
  };
}
