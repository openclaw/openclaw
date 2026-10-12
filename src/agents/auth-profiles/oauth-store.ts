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
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const current = (
      await loadStoredOAuthRefreshStore(params.agentDir, params.profileId, params.personalStore)
    ).profiles[params.profileId];
    // A known-null reply can follow a committed write. Confirm the exact
    // validated postimage before treating it as a stale claim.
    if (
      attempt > 0 &&
      current?.type === "oauth" &&
      isExactOAuthCredential(current, params.refreshed) &&
      !isExactOAuthCredential(current, params.fence)
    ) {
      return { credential: current, persisted: true };
    }
    if (
      current?.type === "oauth" &&
      !isExactOAuthCredential(current, params.fence) &&
      isSafeOAuthPostClaimSettlement(params.generation, current)
    ) {
      return { credential: current, persisted: false };
    }
    // Retry only while a fresh read proves the same claim still owns the fence.
    if (attempt > 0 && !isExactOAuthCredential(current, params.fence)) {
      return null;
    }
    // The updater may run even when the store helper ultimately returns null.
    // Keep its captured result local to this attempt, never to a later retry.
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
    if (result !== null) {
      return credential ? { credential, persisted } : null;
    }
    // updateAuthProfileStoreWithLock returns null only for known contention or
    // changed inherited reads; the next iteration rereads before its one retry.
  }
  return null;
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
