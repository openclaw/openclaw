import { isExactOAuthCredential } from "./oauth-refresh-fence.js";
import { createFailedOAuthRefreshFence } from "./oauth-refresh-marker.js";
import type { beginOAuthRefreshObservation } from "./oauth-refresh-observation.js";
import type { OAuthRefreshPeerClaim } from "./oauth-refresh-peers.js";
import { hasMatchingOAuthIdentity, isSafeOAuthPostClaimSettlement } from "./oauth-shared.js";
import type { PersonalAuthProfileStore } from "./personal-store.js";
import {
  loadAuthProfileStoreWithoutExternalProfilesAsync,
  updateAuthProfileStoreWithLock,
} from "./store-runtime.js";
import type { AuthProfileStore, OAuthCredential } from "./types.js";

export type ResolvedOAuthAccess = {
  apiKey: string;
  credential: OAuthCredential;
};

export type OAuthRefreshClaim =
  | { kind: "unavailable" }
  | {
      kind: "observe";
      ownerAgentDir?: string;
      generation: OAuthCredential;
    }
  | { kind: "use"; credential: OAuthCredential }
  | {
      kind: "claimed";
      personalStore?: PersonalAuthProfileStore;
      profileId: string;
      credential: OAuthCredential;
      fence: OAuthCredential;
      ownerAgentDir?: string;
      authPath: string;
      peerClaims: OAuthRefreshPeerClaim[];
      peerGeneration?: OAuthCredential;
      observation: ReturnType<typeof beginOAuthRefreshObservation>;
    };

export function canReuseOAuthCredentialAfterRefreshFailure(params: {
  forceRefresh?: boolean;
  attempted: OAuthCredential;
  candidate: OAuthCredential;
}): boolean {
  return (
    !params.forceRefresh ||
    (params.attempted.provider === params.candidate.provider &&
      params.attempted.access !== params.candidate.access &&
      hasMatchingOAuthIdentity(params.attempted, params.candidate))
  );
}

export async function loadStoredOAuthRefreshStore(
  agentDir?: string,
  profileId?: string,
  personalStore?: PersonalAuthProfileStore,
): Promise<AuthProfileStore> {
  if (personalStore) {
    return personalStore.read();
  }
  return loadAuthProfileStoreWithoutExternalProfilesAsync(agentDir, {
    allowKeychainPrompt: true,
    profileId,
  });
}

export async function updateOAuthStore(
  params: Parameters<typeof updateAuthProfileStoreWithLock>[0] & {
    personalStore?: PersonalAuthProfileStore;
    assertCurrent?: () => void;
  },
) {
  return params.personalStore
    ? params.personalStore.update(params.updater, params.assertCurrent)
    : updateAuthProfileStoreWithLock(params);
}

export async function settleOAuthRefreshClaim(params: {
  personalStore?: PersonalAuthProfileStore;
  agentDir?: string;
  profileId: string;
  generation: OAuthCredential;
  fence: OAuthCredential;
  refreshed: OAuthCredential;
  validateCredential?: (credential: OAuthCredential) => void;
}): Promise<{ credential: OAuthCredential; persisted: boolean } | null> {
  const current = (
    await loadStoredOAuthRefreshStore(params.agentDir, params.profileId, params.personalStore)
  ).profiles[params.profileId];
  if (
    current?.type === "oauth" &&
    !isExactOAuthCredential(current, params.fence) &&
    isSafeOAuthPostClaimSettlement(params.generation, current)
  ) {
    return { credential: current, persisted: false };
  }
  let credential: OAuthCredential | null = null;
  let persisted = false;
  const result = await updateOAuthStore({
    personalStore: params.personalStore,
    assertCurrent: () => params.validateCredential?.(params.refreshed),
    agentDir: params.agentDir,
    profileId: params.profileId,
    updater: (store) => {
      const existing = store.profiles[params.profileId];
      if (existing?.type !== "oauth") {
        return false;
      }
      if (isExactOAuthCredential(existing, params.fence)) {
        store.profiles[params.profileId] = { ...params.refreshed };
        credential = params.refreshed;
        persisted = true;
        return true;
      }
      // A reconnect or newer owner generation wins. The stale refresh may use
      // that live credential for this call, but it never overwrites it.
      credential = isSafeOAuthPostClaimSettlement(params.generation, existing) ? existing : null;
      return false;
    },
  });
  return result === null || !credential ? null : { credential, persisted };
}

export async function markOAuthRefreshClaimFailed(params: {
  personalStore?: PersonalAuthProfileStore;
  agentDir?: string;
  profileId: string;
  fence: OAuthCredential;
  settledCredential?: OAuthCredential;
}): Promise<void> {
  const updated = await updateOAuthStore({
    personalStore: params.personalStore,
    agentDir: params.agentDir,
    profileId: params.profileId,
    updater: (store) => {
      const existing = store.profiles[params.profileId];
      if (!isExactOAuthCredential(existing, params.settledCredential ?? params.fence)) {
        return false;
      }
      store.profiles[params.profileId] = createFailedOAuthRefreshFence(params.fence);
      return true;
    },
  });
  if (updated === null) {
    throw new Error("Failed to persist terminal OAuth refresh fence");
  }
}

export async function rollbackOAuthRefreshOwnerClaim(params: {
  personalStore?: PersonalAuthProfileStore;
  ownerAgentDir?: string;
  profileId: string;
  fence: OAuthCredential;
  original: OAuthCredential;
}): Promise<void> {
  let restored = false;
  const updated = await updateOAuthStore({
    personalStore: params.personalStore,
    agentDir: params.ownerAgentDir,
    profileId: params.profileId,
    updater: (store) => {
      const existing = store.profiles[params.profileId];
      if (!isExactOAuthCredential(existing, params.fence)) {
        return false;
      }
      store.profiles[params.profileId] = { ...params.original };
      restored = true;
      return true;
    },
  });
  if (updated !== null && restored) {
    return;
  }
  await markOAuthRefreshClaimFailed({
    personalStore: params.personalStore,
    agentDir: params.ownerAgentDir,
    profileId: params.profileId,
    fence: params.fence,
  });
}
