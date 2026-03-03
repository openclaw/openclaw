import type { OpenClawConfig } from "../../config/config.js";
import type { ClaudeSdkConfig } from "../../config/zod-schema.agent-runtime.js";
import {
  saveAuthProfileStore,
  upsertAuthProfileWithLock,
  type AuthProfileStore,
} from "../auth-profiles.js";
import { resolveAuthProfileOrder, SYSTEM_KEYCHAIN_PROVIDERS } from "../model-auth.js";
import { normalizeProviderId } from "../model-selection.js";

export type AuthProfileCandidate = {
  profileId?: string;
  resolveProfileId?: string;
};

const SYNTHETIC_SYSTEM_KEYCHAIN_PROFILE_SUFFIX = "system-keychain";

type AuthResolutionRuntime = "pi" | "claude-sdk" | undefined;

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

async function buildProfileCandidatesForProvider(params: {
  providerId: string;
  authStore: AuthProfileStore;
  cfg: OpenClawConfig | undefined;
  preferredProfileId: string | undefined;
  authProfileIdSource: string | undefined;
  agentDir: string | undefined;
}): Promise<{ lockedProfileId?: string; candidates: AuthProfileCandidate[] }> {
  const { providerId, authStore, cfg, preferredProfileId, authProfileIdSource } = params;

  let lockedProfileId = authProfileIdSource === "user" ? preferredProfileId : undefined;
  if (lockedProfileId) {
    const lockedProfile = authStore.profiles[lockedProfileId];
    if (
      !lockedProfile ||
      normalizeProviderId(lockedProfile.provider) !== normalizeProviderId(providerId)
    ) {
      lockedProfileId = undefined;
    }
  }

  const profileOrder = resolveAuthProfileOrder({
    cfg,
    store: authStore,
    provider: providerId,
    preferredProfile: preferredProfileId,
  });

  if (lockedProfileId && !profileOrder.includes(lockedProfileId)) {
    throw new Error(`Auth profile "${lockedProfileId}" is not configured for ${providerId}.`);
  }

  if (lockedProfileId) {
    return {
      lockedProfileId,
      candidates: [{ profileId: lockedProfileId, resolveProfileId: lockedProfileId }],
    };
  }

  if (profileOrder.length > 0) {
    return {
      candidates: profileOrder.map((profileId) => ({
        profileId,
        resolveProfileId: profileId,
      })),
    };
  }

  if (SYSTEM_KEYCHAIN_PROVIDERS.has(providerId)) {
    const syntheticProfileId = await ensureSyntheticSystemKeychainProfile(
      authStore,
      providerId,
      params.agentDir,
    );
    return {
      candidates: [{ profileId: syntheticProfileId, resolveProfileId: undefined }],
    };
  }

  return {
    candidates: [{ profileId: undefined, resolveProfileId: undefined }],
  };
}

export type ClaudeSdkAuthResolutionState = {
  readonly runtimeOverride: AuthResolutionRuntime;
  readonly authProvider: string;
  readonly lockedProfileId?: string;
  readonly profileCandidates: AuthProfileCandidate[];
  readonly profileIndex: number;
  advanceProfileIndex: () => void;
  fallBackToPiRuntime: () => Promise<boolean>;
};

export async function createClaudeSdkAuthResolutionState(params: {
  provider: string;
  cfg: OpenClawConfig | undefined;
  claudeSdkConfig: ClaudeSdkConfig | undefined;
  authStore: AuthProfileStore;
  agentDir: string | undefined;
  preferredProfileId: string | undefined;
  authProfileIdSource: string | undefined;
}): Promise<ClaudeSdkAuthResolutionState> {
  const normalizedProvider = normalizeProviderId(params.provider);
  const isSystemKeychain = SYSTEM_KEYCHAIN_PROVIDERS.has(normalizedProvider);

  // Only system-keychain providers route through claude-sdk runtime.
  let runtimeOverride: AuthResolutionRuntime = isSystemKeychain ? "claude-sdk" : undefined;
  let authProvider = params.provider;
  let lockedProfileId: string | undefined;
  let profileCandidates: AuthProfileCandidate[] = [];
  let profileIndex = 0;

  const setActiveAuthProvider = async (
    providerId: string,
    nextRuntime: AuthResolutionRuntime,
  ): Promise<void> => {
    runtimeOverride = nextRuntime;
    authProvider = providerId;
    const profileContext = await buildProfileCandidatesForProvider({
      providerId,
      authStore: params.authStore,
      cfg: params.cfg,
      agentDir: params.agentDir,
      preferredProfileId: params.preferredProfileId,
      authProfileIdSource: params.authProfileIdSource,
    });
    lockedProfileId = profileContext.lockedProfileId;
    profileCandidates = profileContext.candidates;
    profileIndex = 0;
  };

  await setActiveAuthProvider(authProvider, runtimeOverride);

  return {
    get runtimeOverride() {
      return runtimeOverride;
    },
    get authProvider() {
      return authProvider;
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
      if (runtimeOverride !== "claude-sdk") {
        return false;
      }
      // Only runtimeOverride changes to "pi"; authProvider intentionally stays as
      // params.provider (e.g. "claude-personal"). This ensures Pi runtime fails auth
      // cleanly rather than silently crossing into anthropic API-key credentials.
      await setActiveAuthProvider(params.provider, "pi");
      return true;
    },
  };
}
