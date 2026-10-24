/**
 * Auth profile API-key/OAuth runtime resolver.
 * Converts selected auth profiles into provider API keys, refreshes OAuth
 * credentials, resolves SecretRefs, and maintains runtime store snapshots.
 */
import { isDeepStrictEqual } from "node:util";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { getRuntimeConfig } from "../../config/config.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { parseSecretRef } from "../../config/types.secrets.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { hasSqliteWorkerOutcomeUnknown } from "../../infra/sqlite-worker-contract.js";
import { secretRefKey } from "../../secrets/ref-contract.js";
import { resolveAuthProfileSecretOwnerId } from "../../secrets/runtime-auth-profile-owner.js";
import {
  findActiveDegradedSecretOwner,
  SecretSurfaceUnavailableError,
} from "../../secrets/runtime-degraded-state.js";
import { isUserModelAuthProfileId } from "../../state/user-model-account-id.js";
import { normalizeOptionalSecretInput } from "../../utils/normalize-secret-input.js";
import { resolveProviderIdForAuth } from "../provider-auth-aliases.js";
import { authProfilesLog, CLAUDE_CLI_PROFILE_ID } from "./constants.js";
import {
  evaluateStoredCredentialEligibility,
  resolveTokenExpiryState,
} from "./credential-state.js";
import { formatAuthDoctorHint } from "./doctor.js";
import { createOAuthManager } from "./oauth-manager.js";
import { refreshOAuthCredential } from "./oauth-provider-operations.js";
import {
  OAuthManagerRefreshError,
  isSettledOAuthRefreshFailure,
  markOAuthRefreshFailureSettled,
  OAuthRefreshFailureError,
} from "./oauth-refresh-failure.js";
import { withPersonalAuthProfileStore, type PersonalAuthProfileStore } from "./personal-store.js";
import { assertNoOAuthSecretRefPolicyViolations } from "./policy.js";
import { clearLastGoodProfileWithLock } from "./profiles.js";
import { suggestOAuthProfileIdForLegacyDefault } from "./repair.js";
import {
  getRuntimeAuthProfileStoreSnapshotCore,
  updateRuntimeAuthProfileStoreSnapshot,
} from "./runtime-snapshots.js";
import { getSetupCredentialRuntimeProfile, isSetupCredentialAccessible } from "./setup-access.js";
import {
  loadAuthProfileStoreForRuntimeAsync,
  prepareAuthProfileCredentialRead,
  resolvePersistedAuthProfileOwnerAgentDirAsync,
} from "./store-runtime.js";
import { resolveRuntimeAuthProfileAgentDir } from "./store.js";
import type { AuthProfileCredential, AuthProfileStore, OAuthCredential } from "./types.js";

function isProfileConfigCompatible(params: {
  cfg?: OpenClawConfig;
  profileId: string;
  provider: string;
  mode: "api_key" | "token" | "oauth";
}): boolean {
  const profileConfig = params.cfg?.auth?.profiles?.[params.profileId];
  return (
    !profileConfig ||
    (profileConfig.provider === params.provider &&
      (profileConfig.mode === params.mode ||
        // OAuth and manually supplied bearer tokens share a transport contract.
        ((profileConfig.mode === "oauth" || profileConfig.mode === "token") &&
          (params.mode === "oauth" || params.mode === "token"))))
  );
}

type ResolveApiKeyForProfileResult = {
  apiKey: string;
  provider: string;
  email?: string;
  profileId: string;
  profileType: AuthProfileCredential["type"];
  credential?: AuthProfileCredential;
  /** Retained credential authority; null denotes a runtime-only credential. */
  readCurrentCredential: (() => AuthProfileCredential | undefined) | null;
};

function buildApiKeyProfileResult(
  params: Omit<ResolveApiKeyForProfileResult, "readCurrentCredential"> &
    Partial<Pick<ResolveApiKeyForProfileResult, "readCurrentCredential">>,
): ResolveApiKeyForProfileResult {
  const result = {
    apiKey: params.apiKey,
    provider: params.provider,
    email: params.email,
  };
  for (const key of ["profileId", "profileType", "credential", "readCurrentCredential"] as const) {
    Object.defineProperty(result, key, {
      value: key === "readCurrentCredential" ? (params[key] ?? null) : params[key],
      enumerable: false,
    });
  }
  return result as ResolveApiKeyForProfileResult;
}

/** Detect provider errors caused by single-use OAuth refresh token races. */
function isRefreshTokenReusedError(error: unknown): boolean {
  const message = normalizeLowercaseStringOrEmpty(formatErrorMessage(error));
  return (
    message.includes("refresh_token_reused") ||
    message.includes("refresh token has already been used") ||
    message.includes("already been used to generate a new access token")
  );
}

type ResolveApiKeyForProfileParams = {
  cfg?: OpenClawConfig;
  store: AuthProfileStore;
  profileId: string;
  agentDir?: string;
  forceRefresh?: boolean;
  allowProfileFallback?: boolean;
  signal?: AbortSignal;
  /** Reject an OAuth credential before the resolver persists, adopts, or returns it. */
  validateOAuthCredential?: (credential: OAuthCredential) => void;
};

type SecretDefaults = NonNullable<OpenClawConfig["secrets"]>["defaults"];

/** Refresh one OAuth credential and merge provider-returned token fields. */
export async function refreshOAuthCredentialForRuntime(params: {
  credential: OAuthCredential;
  cfg?: OpenClawConfig;
}): Promise<OAuthCredential | null> {
  const refreshed = await refreshOAuthCredential(params.credential, { cfg: params.cfg });
  return refreshed
    ? {
        ...params.credential,
        ...refreshed,
        type: "oauth",
      }
    : null;
}

const oauthManager = createOAuthManager();

if (process.env.VITEST || process.env.NODE_ENV === "test") {
  (globalThis as Record<PropertyKey, unknown>)[Symbol.for("openclaw.oauthTestApi")] = {
    isRefreshTokenReusedError,
  };
}

async function resolveOAuthProfileAccess(
  params: ResolveApiKeyForProfileParams,
  credential: OAuthCredential,
  personalStore?: PersonalAuthProfileStore,
): Promise<ResolveApiKeyForProfileResult | null> {
  const readCurrentCredential =
    !personalStore && credential.authFlow === "chatgpt-token-sharing"
      ? await prepareAuthProfileCredentialRead(params)
      : null;
  const resolved = await oauthManager.resolveOAuthAccess({
    personalStore,
    store: params.store,
    profileId: params.profileId,
    credential,
    agentDir: params.agentDir,
    cfg: params.cfg,
    forceRefresh: params.forceRefresh,
    validateCredential: params.validateOAuthCredential,
    signal: params.signal,
  });
  return resolved
    ? buildApiKeyProfileResult({
        apiKey: resolved.apiKey,
        provider: resolved.credential.provider,
        email: resolved.credential.email ?? credential.email,
        profileId: params.profileId,
        profileType: credential.type,
        credential: resolved.credential,
        readCurrentCredential: personalStore?.readCurrentCredential ?? readCurrentCredential,
      })
    : null;
}

async function tryResolveOAuthProfile(
  params: ResolveApiKeyForProfileParams,
): Promise<ResolveApiKeyForProfileResult | null> {
  const { cfg, store, profileId } = params;
  if (profileId === CLAUDE_CLI_PROFILE_ID) {
    return null;
  }
  const cred = store.profiles[profileId];
  if (
    !cred ||
    cred.type !== "oauth" ||
    !isSetupCredentialAccessible({ profileId, credential: cred, agentDir: params.agentDir })
  ) {
    return null;
  }
  if (
    !isProfileConfigCompatible({
      cfg,
      profileId,
      provider: cred.provider,
      mode: cred.type,
    })
  ) {
    return null;
  }

  const resolved = await resolveOAuthProfileAccess(params, cred);
  params.signal?.throwIfAborted();
  return resolved;
}

function authProfileSecretRefKey(
  profile: AuthProfileCredential,
  defaults: SecretDefaults | undefined,
): string | undefined {
  const ref =
    profile.type === "api_key"
      ? (parseSecretRef(profile.keyRef, defaults) ?? parseSecretRef(profile.key, defaults))
      : profile.type === "token"
        ? (parseSecretRef(profile.tokenRef, defaults) ?? parseSecretRef(profile.token, defaults))
        : null;
  return ref ? secretRefKey(ref) : undefined;
}

/** Resolve a selected auth profile into the provider API key string. */
export async function resolveApiKeyForProfile(
  params: ResolveApiKeyForProfileParams,
): Promise<ResolveApiKeyForProfileResult | null> {
  // Credential and degraded-owner lookups must share the store read's bounded auth scope.
  const scopedParams = { ...params, agentDir: resolveRuntimeAuthProfileAgentDir(params.agentDir) };
  params.signal?.throwIfAborted();
  const resolved = isUserModelAuthProfileId(params.profileId)
    ? ((await withPersonalAuthProfileStore(params.profileId, (owner) =>
        resolveApiKeyForProfileOwned(scopedParams, owner),
      )) ?? null)
    : await resolveApiKeyForProfileOwned(scopedParams);
  params.signal?.throwIfAborted();
  return resolved;
}

async function resolveApiKeyForProfileOwned(
  params: ResolveApiKeyForProfileParams,
  personalStore?: PersonalAuthProfileStore,
): Promise<ResolveApiKeyForProfileResult | null> {
  params.signal?.throwIfAborted();
  const { cfg, store, profileId } = params;
  const storedProfile = personalStore
    ? (await personalStore.read()).profiles[profileId]
    : store.profiles[profileId];
  params.signal?.throwIfAborted();
  if (
    !storedProfile ||
    !isSetupCredentialAccessible({
      profileId,
      credential: storedProfile,
      agentDir: params.agentDir,
    })
  ) {
    return null;
  }
  // Claude owns this native login slot. Legacy persisted copies must never
  // resolve, refresh, or leave OpenClaw as bearer tokens.
  if (profileId === CLAUDE_CLI_PROFILE_ID) {
    return null;
  }
  const configForRefResolution = cfg ?? getRuntimeConfig();
  const refDefaults = configForRefResolution.secrets?.defaults;
  const agentDir = params.agentDir;
  const setupProfile = getSetupCredentialRuntimeProfile({
    agentDir,
    profileId,
    profile: storedProfile,
  });
  const runtimeProfile =
    setupProfile === undefined
      ? getRuntimeAuthProfileStoreSnapshotCore(agentDir)?.profiles[profileId]
      : setupProfile;
  const inputRefKey = authProfileSecretRefKey(storedProfile, refDefaults);
  const runtimeRefKey = runtimeProfile
    ? authProfileSecretRefKey(runtimeProfile, refDefaults)
    : undefined;
  const published = Boolean(
    runtimeProfile &&
    (isDeepStrictEqual(runtimeProfile, storedProfile) ||
      (inputRefKey &&
        runtimeRefKey === inputRefKey &&
        runtimeProfile.type === storedProfile.type &&
        runtimeProfile.provider === storedProfile.provider)),
  );
  let cred = storedProfile;
  if (published && runtimeProfile?.type === "api_key" && storedProfile.type === "api_key") {
    const value = runtimeProfile.key;
    cred = { ...storedProfile, key: value };
  } else if (published && runtimeProfile?.type === "token" && storedProfile.type === "token") {
    const value = runtimeProfile.token;
    cred = { ...storedProfile, token: value };
  }
  if (
    !isProfileConfigCompatible({
      cfg,
      profileId,
      provider: cred.provider,
      mode: cred.type,
    })
  ) {
    return null;
  }

  assertNoOAuthSecretRefPolicyViolations({
    store,
    cfg: configForRefResolution,
    profileIds: [profileId],
    context: `auth profile ${profileId}`,
  });
  if (cred.type === "api_key" || cred.type === "token") {
    if (cred.type === "api_key") {
      if (!evaluateStoredCredentialEligibility({ credential: cred }).eligible) {
        return null;
      }
    } else {
      const expiryState = resolveTokenExpiryState(cred.expires);
      if (expiryState === "expired" || expiryState === "invalid_expires") {
        return null;
      }
    }
    const ownerId = resolveAuthProfileSecretOwnerId(params);
    const degraded = findActiveDegradedSecretOwner("account", ownerId);
    // Another store may reuse this profile id; only the matching published credential is blocked.
    if (degraded && published) {
      throw new SecretSurfaceUnavailableError(degraded);
    }
    const inlineValue = cred.type === "api_key" ? cred.key : cred.token;
    const refKey = authProfileSecretRefKey(cred, refDefaults);
    const apiKey = normalizeOptionalSecretInput(inlineValue);
    if (refKey && (!published || !apiKey)) {
      throw new SecretSurfaceUnavailableError({
        ownerKind: "account",
        ownerId,
        state: "unavailable",
        paths: [`auth-profiles.${profileId}.${cred.type === "api_key" ? "key" : "token"}`],
        refKeys: [refKey],
        reason: "secret reference was not materialized by the active runtime",
      });
    }
    if (!apiKey) {
      return null;
    }
    return buildApiKeyProfileResult({
      apiKey,
      provider: cred.provider,
      email: cred.email,
      profileId,
      profileType: cred.type,
      readCurrentCredential: personalStore?.readCurrentCredential,
    });
  }

  try {
    const resolved = await resolveOAuthProfileAccess(params, cred, personalStore);
    params.signal?.throwIfAborted();
    return resolved;
  } catch (error) {
    params.signal?.throwIfAborted();
    if (hasSqliteWorkerOutcomeUnknown(error)) {
      throw error;
    }
    let settlementComplete = isSettledOAuthRefreshFailure(error);
    let refreshedStore =
      error instanceof OAuthManagerRefreshError
        ? error.getRefreshedStore()
        : personalStore
          ? await personalStore.read()
          : await loadAuthProfileStoreForRuntimeAsync(params.agentDir, {
              profileId,
              readOnly: true,
              allowKeychainPrompt: false,
            });
    const surfacedCause =
      error instanceof OAuthManagerRefreshError && error.cause ? error.cause : error;
    if (isRefreshTokenReusedError(surfacedCause)) {
      const ownerAgentDir = await resolvePersistedAuthProfileOwnerAgentDirAsync({
        agentDir: params.agentDir,
        profileId,
      });
      let clearedLastGood = false;
      try {
        await clearLastGoodProfileWithLock({
          provider: cred.provider,
          profileId,
          agentDir: ownerAgentDir,
        });
        clearedLastGood = true;
      } catch (cleanupError) {
        settlementComplete = false;
        // The refresh failure owns the operator diagnosis; stale last-good cleanup is secondary.
        authProfilesLog.warn("failed to clear stale OAuth last-good state after refresh failure", {
          error: formatErrorMessage(cleanupError),
        });
      }
      const snapshot =
        params.agentDir !== ownerAgentDir
          ? getRuntimeAuthProfileStoreSnapshotCore(params.agentDir)
          : undefined;
      if (snapshot) {
        const providerKey = resolveProviderIdForAuth(cred.provider);
        if (snapshot.lastGood?.[providerKey] === profileId) {
          delete snapshot.lastGood[providerKey];
          if (Object.keys(snapshot.lastGood).length === 0) {
            snapshot.lastGood = undefined;
          }
          updateRuntimeAuthProfileStoreSnapshot(snapshot, params.agentDir);
        }
      }
      if (clearedLastGood) {
        refreshedStore = personalStore
          ? await personalStore.read()
          : await loadAuthProfileStoreForRuntimeAsync(params.agentDir, {
              profileId,
              readOnly: true,
              allowKeychainPrompt: false,
            });
      }
    }
    const fallbackProfileId =
      params.allowProfileFallback === false
        ? null
        : suggestOAuthProfileIdForLegacyDefault({
            cfg,
            store: refreshedStore,
            provider: cred.provider,
            legacyProfileId: profileId,
          });
    if (fallbackProfileId && fallbackProfileId !== profileId) {
      try {
        const fallbackResolved = await tryResolveOAuthProfile({
          cfg,
          store: refreshedStore,
          profileId: fallbackProfileId,
          agentDir: params.agentDir,
          forceRefresh: params.forceRefresh,
          validateOAuthCredential: params.validateOAuthCredential,
          signal: params.signal,
        });
        params.signal?.throwIfAborted();
        if (fallbackResolved) {
          return fallbackResolved;
        }
      } catch {
        params.signal?.throwIfAborted();
        // keep original error
      }
    }

    const message = formatErrorMessage(surfacedCause);
    const retryable = error instanceof OAuthRefreshFailureError && error.retryable === true;
    const hint = retryable
      ? undefined
      : await formatAuthDoctorHint({
          cfg,
          store: refreshedStore,
          provider: cred.provider,
          profileId,
        });
    const failure = new OAuthRefreshFailureError({
      provider: cred.provider,
      profileId,
      message:
        `OAuth token refresh failed for ${cred.provider}: ${message}. ` +
        (retryable ? "Please try again shortly." : "Please try again or re-authenticate.") +
        (hint ? `\n\n${hint}` : ""),
      cause: error,
    });
    if (settlementComplete) {
      markOAuthRefreshFailureSettled(failure);
    }
    throw failure;
  }
}
