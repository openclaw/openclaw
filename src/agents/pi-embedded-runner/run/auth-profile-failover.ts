import type { Api, Model } from "@mariozechner/pi-ai";
import type { AuthStorage } from "@mariozechner/pi-coding-agent";
import type { OpenClawConfig } from "../../../config/config.js";
import type { ClaudeSdkConfig } from "../../../config/zod-schema.agent-runtime.js";
import type { AuthProfileStore } from "../../auth-profiles.js";
import { isProfileInCooldown, resolveProfilesUnavailableReason } from "../../auth-profiles.js";
import {
  createClaudeSdkAuthResolutionState,
  type ClaudeSdkAuthResolutionState,
  type AuthProfileCandidate,
} from "../../claude-sdk-runner/auth-resolution.js";
import { FailoverError, resolveFailoverStatus } from "../../failover-error.js";
import { getApiKeyForModel, type ResolvedProviderAuth } from "../../model-auth.js";
import {
  classifyFailoverReason,
  isFailoverErrorMessage,
  type FailoverReason,
} from "../../pi-embedded-helpers.js";
import { log } from "../logger.js";
import { describeUnknownError } from "../utils.js";

type CreateRunAuthProfileFailoverControllerParams = {
  provider: string;
  modelId: string;
  model: Model<Api>;
  cfg: OpenClawConfig | undefined;
  agentDir: string | undefined;
  authStore: AuthProfileStore;
  authStorage: AuthStorage;
  fallbackConfigured: boolean;
  claudeSdkConfig: ClaudeSdkConfig | undefined;
  preferredProfileId: string | undefined;
  authProfileIdSource: "auto" | "user" | undefined;
  onAuthRotationSuccess?: () => void;
  onClaudeSdkToPiFallback?: () => void;
};

export type RunAuthProfileFailoverController = {
  readonly authResolution: ClaudeSdkAuthResolutionState;
  readonly apiKeyInfo: ResolvedProviderAuth | null;
  readonly lastProfileId: string | undefined;
  resolveAuthLookupModel: () => Model<Api>;
  advanceAuthProfile: () => Promise<boolean>;
  syncCopilotRefreshForCurrentProfile: (reason: string) => Promise<boolean>;
  maybeRefreshCopilotForAuthError: (errorText: string, retried: boolean) => Promise<boolean>;
  stopCopilotRefreshTimer: () => void;
};

type CopilotTokenState = {
  githubToken: string;
  expiresAt: number;
  refreshTimer?: ReturnType<typeof setTimeout>;
  refreshInFlight?: Promise<void>;
};

const COPILOT_REFRESH_MARGIN_MS = 5 * 60 * 1000;
const COPILOT_REFRESH_RETRY_MS = 60 * 1000;
const COPILOT_REFRESH_MIN_DELAY_MS = 5 * 1000;

export async function createRunAuthProfileFailoverController(
  params: CreateRunAuthProfileFailoverControllerParams,
): Promise<RunAuthProfileFailoverController> {
  const authResolution = await createClaudeSdkAuthResolutionState({
    provider: params.provider,
    cfg: params.cfg,
    claudeSdkConfig: params.claudeSdkConfig,
    authStore: params.authStore,
    agentDir: params.agentDir,
    preferredProfileId: params.preferredProfileId,
    authProfileIdSource: params.authProfileIdSource,
  });

  let apiKeyInfo: ResolvedProviderAuth | null = null;
  let lastProfileId: string | undefined;
  let sawNonCooldownCandidateFailure = false;
  let lastCandidateResolutionError: unknown;
  const copilotTokenState: CopilotTokenState | null =
    authResolution.authProvider === "github-copilot" ? { githubToken: "", expiresAt: 0 } : null;
  let copilotRefreshCancelled = false;

  const resolveAuthLookupModel = () =>
    authResolution.authProvider === params.model.provider
      ? params.model
      : { ...params.model, provider: authResolution.authProvider };

  const clearCopilotRefreshTimer = () => {
    if (!copilotTokenState?.refreshTimer) {
      return;
    }
    clearTimeout(copilotTokenState.refreshTimer);
    copilotTokenState.refreshTimer = undefined;
  };

  const stopCopilotRefreshTimer = () => {
    if (!copilotTokenState) {
      return;
    }
    copilotRefreshCancelled = true;
    clearCopilotRefreshTimer();
  };

  const refreshCopilotToken = async (reason: string): Promise<void> => {
    if (!copilotTokenState) {
      return;
    }
    if (copilotTokenState.refreshInFlight) {
      await copilotTokenState.refreshInFlight;
      return;
    }
    copilotTokenState.refreshInFlight = (async () => {
      const githubToken = apiKeyInfo?.apiKey?.trim() || copilotTokenState.githubToken.trim();
      if (!githubToken) {
        throw new Error("Copilot refresh requires a GitHub token.");
      }
      copilotTokenState.githubToken = githubToken;
      log.debug(`Refreshing GitHub Copilot token (${reason})...`);
      const { resolveCopilotApiToken } = await import("../../../providers/github-copilot-token.js");
      const copilotToken = await resolveCopilotApiToken({
        githubToken,
      });
      params.authStorage.setRuntimeApiKey(authResolution.authProvider, copilotToken.token);
      copilotTokenState.expiresAt = copilotToken.expiresAt;
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
        copilotTokenState.refreshInFlight = undefined;
      });
    await copilotTokenState.refreshInFlight;
  };

  const scheduleCopilotRefresh = (): void => {
    if (!copilotTokenState || copilotRefreshCancelled) {
      return;
    }
    if (!copilotTokenState.githubToken.trim()) {
      log.warn("Skipping Copilot refresh scheduling; GitHub token missing.");
      return;
    }
    clearCopilotRefreshTimer();
    const now = Date.now();
    const refreshAt = copilotTokenState.expiresAt - COPILOT_REFRESH_MARGIN_MS;
    const delayMs = Math.max(COPILOT_REFRESH_MIN_DELAY_MS, refreshAt - now);
    const timer = setTimeout(() => {
      if (copilotRefreshCancelled) {
        return;
      }
      refreshCopilotToken("scheduled")
        .then(() => scheduleCopilotRefresh())
        .catch(() => {
          if (copilotRefreshCancelled) {
            return;
          }
          const retryTimer = setTimeout(() => {
            if (copilotRefreshCancelled) {
              return;
            }
            refreshCopilotToken("scheduled-retry")
              .then(() => scheduleCopilotRefresh())
              .catch(() => undefined);
          }, COPILOT_REFRESH_RETRY_MS);
          copilotTokenState.refreshTimer = retryTimer;
          if (copilotRefreshCancelled) {
            clearTimeout(retryTimer);
            copilotTokenState.refreshTimer = undefined;
          }
        });
    }, delayMs);
    copilotTokenState.refreshTimer = timer;
    if (copilotRefreshCancelled) {
      clearTimeout(timer);
      copilotTokenState.refreshTimer = undefined;
    }
  };

  const syncCopilotRefreshForCurrentProfile = async (reason: string): Promise<boolean> => {
    if (!copilotTokenState) {
      return false;
    }
    const githubToken = apiKeyInfo?.apiKey?.trim() ?? "";
    if (!githubToken) {
      return false;
    }
    copilotTokenState.githubToken = githubToken;
    try {
      await refreshCopilotToken(reason);
      scheduleCopilotRefresh();
      return true;
    } catch {
      return false;
    }
  };

  const maybeRefreshCopilotForAuthError = async (
    errorText: string,
    retried: boolean,
  ): Promise<boolean> => {
    if (!copilotTokenState || retried) {
      return false;
    }
    if (!isFailoverErrorMessage(errorText)) {
      return false;
    }
    if (classifyFailoverReason(errorText) !== "auth") {
      return false;
    }
    return syncCopilotRefreshForCurrentProfile("auth-error");
  };

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
    if (authResolution.authProvider === "github-copilot") {
      const { resolveCopilotApiToken } = await import("../../../providers/github-copilot-token.js");
      const copilotToken = await resolveCopilotApiToken({
        githubToken: apiKeyInfo.apiKey,
      });
      params.authStorage.setRuntimeApiKey(authResolution.authProvider, copilotToken.token);
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

  const advanceAuthProfile = async (): Promise<boolean> => {
    // User-pinned profiles are locked and should never rotate within the run loop.
    if (authResolution.lockedProfileId) {
      return false;
    }
    authResolution.advanceProfileIndex();
    if (await initializeCurrentAuthCandidate()) {
      await syncCopilotRefreshForCurrentProfile("profile-rotate");
      params.onAuthRotationSuccess?.();
      return true;
    }
    if (authResolution.runtimeOverride === "claude-sdk") {
      if (await authResolution.fallBackToPiRuntime()) {
        params.onClaudeSdkToPiFallback?.();
        if (await initializeCurrentAuthCandidate()) {
          await syncCopilotRefreshForCurrentProfile("profile-rotate");
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
    syncCopilotRefreshForCurrentProfile,
    maybeRefreshCopilotForAuthError,
    stopCopilotRefreshTimer,
  };
}
