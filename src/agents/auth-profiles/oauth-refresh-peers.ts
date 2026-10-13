import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolvePathViaExistingAncestorSync } from "../../infra/boundary-path.js";
import { toErrorObject } from "../../infra/errors.js";
import { withSqliteReadOnlyWorkerScope } from "../../infra/sqlite-readonly-worker.js";
import { hasSqliteWorkerOutcomeUnknown } from "../../infra/sqlite-worker-contract.js";
import { isUserModelAuthProfileId } from "../../state/user-model-account-id.js";
import {
  fenceCandidateAuthProfileStore,
  listCandidateAuthProfileStores,
  loadCandidateAuthProfileStoreAsync,
  updateCandidateAuthProfileStore,
  type CandidateAuthProfileStore,
} from "./candidate-stores.js";
import { hasUsableOAuthCredential } from "./credential-state.js";
import { isPersistedExternalCliAuthProfile } from "./external-cli-sync.js";
import { isSafeToCopyOAuthRoutingScope } from "./oauth-identity.js";
import { isExactOAuthCredential } from "./oauth-refresh-fence.js";
import {
  createFailedOAuthRefreshFence,
  isOAuthRefreshFence,
  isSameOAuthRefreshGeneration,
} from "./oauth-refresh-marker.js";
import { hasMatchingOAuthIdentity, hasOAuthIdentity } from "./oauth-shared.js";
import { getRuntimeExternalCliProfileIds } from "./runtime-external-profile-references.js";
import type { AuthProfileStore, OAuthCredential } from "./types.js";

export type OAuthRefreshPeerClaim = {
  candidate: CandidateAuthProfileStore;
  original?: OAuthCredential;
};

export function mergeOAuthRefreshPeerClaims(
  existing: readonly OAuthRefreshPeerClaim[],
  discovered: readonly OAuthRefreshPeerClaim[],
): OAuthRefreshPeerClaim[] {
  const keyOf = ({ candidate }: OAuthRefreshPeerClaim) =>
    JSON.stringify([
      candidate.databasePath,
      candidate.databaseIdentity.key,
      candidate.databaseIdentity.birthtime,
    ]);
  // Rediscovery can fence a replacement file at a path whose old claim still needs settlement.
  const claims = new Map(existing.map((claim) => [keyOf(claim), claim]));
  for (const claim of discovered) {
    const key = keyOf(claim);
    const current = claims.get(key);
    claims.set(key, current?.original ? current : claim);
  }
  return [...claims.values()].toSorted((left, right) =>
    left.candidate.databasePath.localeCompare(right.candidate.databasePath),
  );
}

type OAuthRefreshPeerTransition = {
  profileId: string;
  fence: OAuthCredential;
  claims: readonly OAuthRefreshPeerClaim[];
};

export class OAuthRefreshPeerFenceError extends Error {
  readonly claims: OAuthRefreshPeerClaim[];

  constructor(claims: OAuthRefreshPeerClaim[], cause: unknown) {
    super("Failed to fence every historical OAuth refresh peer.", { cause });
    this.name = "OAuthRefreshPeerFenceError";
    this.claims = claims;
  }
}

function isExternalProfileOwned(
  store: AuthProfileStore,
  profileId: string,
  credential: OAuthCredential,
): boolean {
  if (
    store.runtimeExternalProfileIds?.includes(profileId) === true ||
    getRuntimeExternalCliProfileIds(store).includes(profileId)
  ) {
    return true;
  }
  return isPersistedExternalCliAuthProfile({ profileId, credential });
}

function isEligibleHistoricalOAuthPeer(params: {
  store: AuthProfileStore;
  profileId: string;
  credential: OAuthCredential;
  generation: OAuthCredential;
}): boolean {
  return (
    !isUserModelAuthProfileId(params.profileId) &&
    params.credential.provider === params.generation.provider &&
    params.credential.copyToAgents !== true &&
    params.credential.oauthRef === undefined &&
    !isExternalProfileOwned(params.store, params.profileId, params.credential) &&
    isSameOAuthRefreshGeneration({
      profileId: params.profileId,
      left: params.credential,
      right: params.generation,
    })
  );
}

function validateOAuthPeerClaim(params: {
  candidate: CandidateAuthProfileStore;
  store: AuthProfileStore;
  profileId: string;
  credential: OAuthCredential;
  generation: OAuthCredential;
}): boolean {
  if (
    !isSameOAuthRefreshGeneration({
      profileId: params.profileId,
      left: params.credential,
      right: params.generation,
    })
  ) {
    return false;
  }
  if (isOAuthRefreshFence(params.credential)) {
    throw new Error(
      `OAuth refresh generation is already claimed by another owner: ${params.candidate.databasePath}`,
    );
  }
  if (!isExternalProfileOwned(params.store, params.profileId, params.credential)) {
    return isEligibleHistoricalOAuthPeer(params);
  }
  throw new Error(
    `OAuth refresh generation is still owned by an external credential source: ${params.candidate.databasePath}`,
  );
}

function isRemovableOAuthRefreshPeer(params: {
  store: AuthProfileStore;
  profileId: string;
  credential: OAuthCredential;
  generation: OAuthCredential;
}): boolean {
  return (
    (isOAuthRefreshFence(params.generation) &&
      isExactOAuthCredential(params.credential, params.generation)) ||
    isEligibleHistoricalOAuthPeer(params)
  );
}

async function listPeerCandidates(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  ownerDatabasePath: string;
}): Promise<CandidateAuthProfileStore[]> {
  const ownerDatabasePath = resolvePathViaExistingAncestorSync(params.ownerDatabasePath);
  return (await listCandidateAuthProfileStores(params)).filter(
    (candidate) => candidate.databasePath !== ownerDatabasePath,
  );
}

/** All peer transitions compare the captured generation inside the candidate's write lock. */
function updateOAuthRefreshPeer(
  candidate: CandidateAuthProfileStore,
  profileId: string,
  expected: OAuthCredential,
  update: (store: AuthProfileStore) => void,
  preserveProfileState?: boolean,
) {
  return updateCandidateAuthProfileStore({
    candidate,
    profileId,
    preserveProfileState,
    updater: (store) => {
      if (!isExactOAuthCredential(store.profiles[profileId], expected)) {
        return false;
      }
      update(store);
      return true;
    },
  });
}

/**
 * Replace every provable historical peer generation with the owner's exact
 * pending fence. Reads and writes are sequential, so no two databases share a
 * transaction.
 */
export async function fenceOAuthRefreshPeers(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  ownerDatabasePath: string;
  profileId: string;
  generation: OAuthCredential;
  fence: OAuthCredential;
  rollbackOnFailure?: boolean;
  /** Register the transaction's exact claim before its fence can commit. */
  onFence?: (databasePath: string) => void;
}): Promise<OAuthRefreshPeerClaim[]> {
  const claims: OAuthRefreshPeerClaim[] = [];
  try {
    for (const candidate of await listPeerCandidates(params)) {
      if (!candidate.databaseIdentity.key.startsWith("file:")) {
        continue;
      }
      await fenceCandidateAuthProfileStore({
        candidate,
        profileId: params.profileId,
        generation: params.generation,
        updater(store) {
          const credential = store.profiles[params.profileId];
          if (credential?.type !== "oauth") {
            return false;
          }
          if (isExactOAuthCredential(credential, params.fence)) {
            params.onFence?.(candidate.databasePath);
            claims.push({ candidate });
            return false;
          }
          if (
            !validateOAuthPeerClaim({
              candidate,
              store,
              profileId: params.profileId,
              credential,
              generation: params.generation,
            })
          ) {
            return false;
          }
          params.onFence?.(candidate.databasePath);
          // Retain provisional custody if COMMIT succeeds but its reply is lost.
          claims.push({ candidate, original: { ...credential } });
          store.profiles[params.profileId] = { ...params.fence };
          return true;
        },
      });
    }
    return claims;
  } catch (error) {
    if (params.rollbackOnFailure !== false) {
      try {
        await rollbackOAuthRefreshPeerClaims({
          profileId: params.profileId,
          fence: params.fence,
          claims,
        });
      } catch (rollbackError) {
        // oxlint-disable-next-line preserve-caught-error -- AggregateError.errors retains rollbackError; cause must remain the original fencing failure.
        throw new AggregateError(
          [error, rollbackError],
          "Failed to fence every historical OAuth refresh peer and roll back partial claims.",
          { cause: error },
        );
      }
      throw error;
    }
    throw new OAuthRefreshPeerFenceError(claims, error);
  }
}

/** Restore pre-I/O peer claims; a retained fence becomes terminal on restore failure. */
export async function rollbackOAuthRefreshPeerClaims(
  params: OAuthRefreshPeerTransition,
): Promise<void> {
  const unresolved: Error[] = [];
  for (const claim of params.claims.toReversed()) {
    if (!claim.original) {
      continue;
    }
    let restoreError: Error | undefined;
    try {
      const restored = await updateOAuthRefreshPeer(
        claim.candidate,
        params.profileId,
        params.fence,
        (store) => {
          store.profiles[params.profileId] = { ...claim.original! };
        },
      );
      if (restored.changed) {
        continue;
      }
    } catch (error) {
      restoreError = toErrorObject(error, "Failed to restore OAuth refresh peer");
      if (hasSqliteWorkerOutcomeUnknown(error)) {
        unresolved.push(restoreError);
        continue;
      }
    }
    try {
      await updateOAuthRefreshPeer(claim.candidate, params.profileId, params.fence, (store) => {
        store.profiles[params.profileId] = createFailedOAuthRefreshFence(params.fence);
      });
    } catch (error) {
      const terminalError = toErrorObject(error, "Failed to terminally fence OAuth refresh peer");
      unresolved.push(
        restoreError
          ? new AggregateError(
              [restoreError, terminalError],
              `Failed to resolve OAuth refresh peer rollback: ${claim.candidate.databasePath}`,
              { cause: restoreError },
            )
          : terminalError,
      );
    }
  }
  if (unresolved.length > 0) {
    throw new AggregateError(unresolved, "Failed to roll back every OAuth refresh peer.", {
      cause: unresolved[0],
    });
  }
}

/**
 * Retire exact peer fences only when their original credential can safely
 * inherit the authoritative shared credential. Otherwise leave a terminal
 * marker so merged resolution cannot expose another account.
 */
export async function settleOAuthRefreshPeerClaims(
  params: OAuthRefreshPeerTransition & {
    authoritativeSharedCredential?: OAuthCredential;
    replacement: OAuthCredential;
  },
): Promise<void> {
  let firstError: Error | undefined;
  for (const claim of params.claims) {
    try {
      await updateOAuthRefreshPeer(
        claim.candidate,
        params.profileId,
        params.fence,
        (store) => {
          const inherited = params.authoritativeSharedCredential;
          const canInherit =
            claim.original !== undefined &&
            inherited !== undefined &&
            inherited.provider === claim.original.provider &&
            isSafeToCopyOAuthRoutingScope(claim.original, inherited) &&
            hasUsableOAuthCredential(inherited) &&
            (hasMatchingOAuthIdentity(claim.original, inherited) ||
              (!hasOAuthIdentity(claim.original) &&
                isExactOAuthCredential(inherited, params.replacement)));
          if (canInherit) {
            delete store.profiles[params.profileId];
          } else {
            store.profiles[params.profileId] = createFailedOAuthRefreshFence(params.fence);
          }
        },
        true,
      );
    } catch (error) {
      firstError ??= toErrorObject(error, "Failed to settle OAuth refresh peer");
    }
  }
  if (firstError !== undefined) {
    throw firstError;
  }
}

/** Convert every exact peer fence into a terminal no-replay marker. */
export async function failOAuthRefreshPeerClaims(
  params: OAuthRefreshPeerTransition,
): Promise<void> {
  const failed = createFailedOAuthRefreshFence(params.fence);
  let firstError: Error | undefined;
  for (const claim of params.claims) {
    try {
      await updateOAuthRefreshPeer(claim.candidate, params.profileId, params.fence, (store) => {
        store.profiles[params.profileId] = failed;
      });
    } catch (error) {
      firstError ??= toErrorObject(error, "Failed to fail OAuth refresh peer");
    }
  }
  if (firstError !== undefined) {
    throw firstError;
  }
}

export type OAuthRefreshGenerationPeer = {
  candidate: CandidateAuthProfileStore;
  profileId: string;
  credential: OAuthCredential;
  generation: OAuthCredential;
};

/** Capture exact historical peers before removal updates their config references. */
export async function listOAuthRefreshGenerationPeers(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  ownerDatabasePath: string;
  profileId: string;
  generation: OAuthCredential;
}): Promise<OAuthRefreshGenerationPeer[]> {
  return withSqliteReadOnlyWorkerScope(async () => {
    const peers: OAuthRefreshGenerationPeer[] = [];
    for (const candidate of await listPeerCandidates(params)) {
      const store = await loadCandidateAuthProfileStoreAsync(candidate);
      const credential = store?.profiles[params.profileId];
      if (!store || credential?.type !== "oauth") {
        continue;
      }
      const removable = isRemovableOAuthRefreshPeer({
        store,
        profileId: params.profileId,
        credential,
        generation: params.generation,
      });
      if (!removable) {
        continue;
      }
      peers.push({
        candidate,
        profileId: params.profileId,
        credential,
        generation: params.generation,
      });
    }
    return peers;
  });
}

/** Remove only captured generations; a reconnect during config cleanup survives. */
export async function removeOAuthRefreshGenerationPeers(
  peers: readonly OAuthRefreshGenerationPeer[],
): Promise<void> {
  for (const { candidate, profileId, credential, generation } of peers) {
    await updateCandidateAuthProfileStore({
      candidate,
      preserveProfileState: true,
      profileId,
      updater: (currentStore) => {
        const current = currentStore.profiles[profileId];
        if (current?.type !== "oauth") {
          return false;
        }
        if (
          !isExactOAuthCredential(current, credential) ||
          !isRemovableOAuthRefreshPeer({
            store: currentStore,
            profileId,
            credential: current,
            generation,
          })
        ) {
          return false;
        }
        delete currentStore.profiles[profileId];
        return true;
      },
    });
  }
}
