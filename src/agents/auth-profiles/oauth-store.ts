import { asDateTimestampMs } from "@openclaw/normalization-core/number-coercion";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { formatErrorMessage, toErrorObject } from "../../infra/errors.js";
import { isUserModelAuthProfileId } from "../../state/user-model-account-id.js";
import { continueAuthProfileAuthorization } from "./authorization-lifetime.js";
import { authProfilesLog } from "./constants.js";
import { hasUsableOAuthCredential } from "./credential-state.js";
import { resolveOAuthMirrorDecision } from "./oauth-identity.js";
import { buildOAuthApiKey } from "./oauth-provider-operations.js";
import { appendOAuthRefreshCleanupErrors } from "./oauth-refresh-failure.js";
import { isExactOAuthCredential } from "./oauth-refresh-fence.js";
import { createFailedOAuthRefreshFence } from "./oauth-refresh-marker.js";
import type { beginOAuthRefreshObservation } from "./oauth-refresh-observation.js";
import { rollbackOAuthRefreshPeerClaims } from "./oauth-refresh-peers.js";
import type { OAuthRefreshPeerClaim } from "./oauth-refresh-peers.js";
import {
  hasMatchingOAuthIdentity,
  isSafeOAuthPostClaimSettlement,
  isSafeToAdoptMainStoreOAuthIdentity,
} from "./oauth-shared.js";
import type { PersonalAuthProfileStore } from "./personal-store.js";
import {
  ensureAuthProfileStoreWithoutExternalProfilesAsync,
  loadAuthProfileStoreWithoutExternalProfilesAsync,
  updateAuthProfileStoreWithLock,
} from "./store-runtime.js";
import type { AuthProfileStore, OAuthCredential } from "./types.js";

export type ResolvedOAuthAccess = {
  apiKey: string;
  credential: OAuthCredential;
};

export type OAuthRefreshFailureSettlement = {
  supersedingOwner: OAuthCredential | null;
  validationError: OAuthSettlementCredentialValidationError | null;
  cleanupErrors: unknown[];
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
      assertPersonalRefreshCurrent?: () => void;
      profileId: string;
      credential: OAuthCredential;
      storedCredential: OAuthCredential;
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

export async function adoptNewerMainOAuthCredential(params: {
  profileId: string;
  agentDir?: string;
  credential: OAuthCredential;
}): Promise<OAuthCredential | null> {
  if (!params.agentDir || isUserModelAuthProfileId(params.profileId)) {
    return null;
  }
  try {
    const mainStore = await ensureAuthProfileStoreWithoutExternalProfilesAsync(undefined, {
      allowKeychainPrompt: false,
    });
    const mainCred = mainStore.profiles[params.profileId];
    if (mainCred?.type !== "oauth") {
      return null;
    }
    const mainExpires = asDateTimestampMs(mainCred.expires);
    const localExpires = asDateTimestampMs(params.credential.expires);
    if (
      mainCred.provider === params.credential.provider &&
      hasUsableOAuthCredential(mainCred) &&
      mainExpires !== undefined &&
      (localExpires === undefined || mainExpires > localExpires) &&
      isSafeToAdoptMainStoreOAuthIdentity(params.credential, mainCred)
    ) {
      return mainCred;
    }
  } catch (err) {
    authProfilesLog.debug("adoptNewerMainOAuthCredential failed", {
      profileId: params.profileId,
      error: formatErrorMessage(err),
    });
  }
  return null;
}

/** Validate and mirror the current shared credential before peer settlement. */
export async function resolveAuthoritativeSharedOAuthCredentialUnderLock(params: {
  profileId: string;
  candidate: OAuthCredential;
  validateCredential?: (credential: OAuthCredential) => void;
}): Promise<OAuthCredential | undefined> {
  let validatedAuthoritative = false;
  const acceptAuthoritative = (credential: OAuthCredential): boolean => {
    try {
      validateSettlementCredential(params.validateCredential, credential);
      validatedAuthoritative = true;
      return true;
    } catch {
      authProfilesLog.warn(
        "refused shared OAuth credential during settlement: credential validation failed",
        {
          profileId: params.profileId,
        },
      );
      return false;
    }
  };
  const updated = await updateAuthProfileStoreWithLock({
    agentDir: undefined,
    profileId: params.profileId,
    sharedStoreWrite: true,
    updater: (store) => {
      const existing = store.profiles[params.profileId];
      const decision = resolveOAuthMirrorDecision({
        existing,
        refreshed: params.candidate,
      });
      if (decision !== "mirror") {
        if (decision === "identity-mismatch-or-regression") {
          authProfilesLog.warn(
            "refused to mirror OAuth credential: identity mismatch or regression",
            {
              profileId: params.profileId,
            },
          );
        }
        if (decision === "incoming-not-fresher" && existing?.type === "oauth") {
          acceptAuthoritative(existing);
        }
        return false;
      }
      if (existing?.type === "oauth" && !acceptAuthoritative(existing)) {
        return false;
      }
      store.profiles[params.profileId] = { ...params.candidate };
      validatedAuthoritative = true;
      return true;
    },
  });
  if (updated === null) {
    throw new Error("Failed to read authoritative shared OAuth credential");
  }
  if (!validatedAuthoritative) {
    return undefined;
  }
  const authoritative = updated.profiles[params.profileId];
  return authoritative?.type === "oauth" ? authoritative : undefined;
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

async function updateOAuthStore(
  params: Parameters<typeof updateAuthProfileStoreWithLock>[0] & {
    personalStore?: PersonalAuthProfileStore;
    assertCurrent?: () => void;
  },
) {
  return params.personalStore
    ? params.personalStore.update(params.updater, params.assertCurrent)
    : updateAuthProfileStoreWithLock(params);
}

/** Claim against the persisted credential, which may differ from an adopted bootstrap token. */
export async function persistOAuthRefreshClaim(params: {
  personalStore?: PersonalAuthProfileStore;
  agentDir?: string;
  profileId: string;
  expected: OAuthCredential;
  fence: OAuthCredential;
  assertAdmission?: () => void;
  assertCurrent: () => void;
}): Promise<boolean> {
  let claimed = false;
  const updated = await updateOAuthStore({
    personalStore: params.personalStore,
    agentDir: params.agentDir,
    profileId: params.profileId,
    assertCurrent: params.assertCurrent,
    updater: (store) => {
      // Admit before this claim publishes its own pending-credential denial.
      // Accepted claim persistence and refresh settlement retain their native owner.
      params.assertAdmission?.();
      if (!isExactOAuthCredential(store.profiles[params.profileId], params.expected)) {
        return false;
      }
      store.profiles[params.profileId] = continueAuthProfileAuthorization(
        params.expected,
        params.fence,
      );
      claimed = true;
      return true;
    },
  });
  return updated !== null && claimed;
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
        store.profiles[params.profileId] = continueAuthProfileAuthorization(existing, {
          ...params.refreshed,
        });
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
  assertCurrent?: () => void;
}): Promise<void> {
  let restored = false;
  const updated = await updateOAuthStore({
    personalStore: params.personalStore,
    agentDir: params.ownerAgentDir,
    profileId: params.profileId,
    assertCurrent: params.assertCurrent,
    updater: (store) => {
      const existing = store.profiles[params.profileId];
      if (!isExactOAuthCredential(existing, params.fence)) {
        return false;
      }
      store.profiles[params.profileId] = continueAuthProfileAuthorization(params.fence, {
        ...params.original,
      });
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

export async function buildValidatedOAuthAccess(
  credential: OAuthCredential,
  context: {
    cfg?: OpenClawConfig;
    agentDir?: string;
    validateCredential?: (credential: OAuthCredential) => void;
    personalStore?: PersonalAuthProfileStore;
  },
): Promise<ResolvedOAuthAccess> {
  context.validateCredential?.(credential);
  const apiKey = await buildOAuthApiKey(
    context.personalStore ? structuredClone(credential) : credential,
    context.cfg,
  );
  const accepted = context.personalStore
    ? await context.personalStore.accept(credential, (current) =>
        context.validateCredential?.(current),
      )
    : credential;
  return { apiKey, credential: accepted };
}

/** Restore completed transient work; observer timeouts never enter this rollback. */
export async function rollbackTransientOAuthRefreshClaim(
  claim: Extract<OAuthRefreshClaim, { kind: "claimed" }>,
  claims: readonly OAuthRefreshPeerClaim[],
  assertCurrent: () => void,
): Promise<unknown[]> {
  assertCurrent();
  const errors: unknown[] = [];
  try {
    await rollbackOAuthRefreshPeerClaims({
      profileId: claim.profileId,
      fence: claim.fence,
      claims,
      assertCurrent,
    });
  } catch (error) {
    errors.push(error);
  }
  try {
    await rollbackOAuthRefreshOwnerClaim({
      personalStore: claim.personalStore,
      ownerAgentDir: claim.ownerAgentDir,
      profileId: claim.profileId,
      fence: claim.fence,
      original: claim.storedCredential,
      assertCurrent,
    });
  } catch (error) {
    errors.push(error);
    try {
      await markOAuthRefreshClaimFailed({
        personalStore: claim.personalStore,
        agentDir: claim.ownerAgentDir,
        profileId: claim.profileId,
        fence: claim.fence,
      });
    } catch (cleanupError) {
      errors.push(cleanupError);
    }
  }
  return errors;
}

export class OAuthSettlementCredentialValidationError extends Error {
  constructor(cause: unknown, cleanupErrors: readonly unknown[] = []) {
    const error = toErrorObject(cause, "OAuth credential validation failed");
    super(error.message, { cause: appendOAuthRefreshCleanupErrors(error, cleanupErrors) });
    this.name = "OAuthSettlementCredentialValidationError";
  }
}

export function validateSettlementCredential(
  validateCredential: ((credential: OAuthCredential) => void) | undefined,
  credential: OAuthCredential,
): void {
  try {
    validateCredential?.(credential);
  } catch (error) {
    throw new OAuthSettlementCredentialValidationError(error);
  }
}
