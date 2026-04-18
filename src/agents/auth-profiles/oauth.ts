import {
  getOAuthApiKey,
  getOAuthProviders,
  type OAuthCredentials,
  type OAuthProvider,
} from "@mariozechner/pi-ai/oauth";
import { loadConfig } from "../../config/config.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { coerceSecretRef } from "../../config/types.secrets.js";
import { formatErrorMessage } from "../../infra/errors.js";
import {
  formatProviderAuthProfileApiKeyWithPlugin,
  refreshProviderOAuthCredentialWithPlugin,
} from "../../plugins/provider-runtime.runtime.js";
import { resolveSecretRefString, type SecretRefResolveCache } from "../../secrets/resolve.js";
import { normalizeLowercaseStringOrEmpty } from "../../shared/string-coerce.js";
import { refreshChutesTokens } from "../chutes-oauth.js";
import { log } from "./constants.js";
import { resolveTokenExpiryState } from "./credential-state.js";
import { formatAuthDoctorHint } from "./doctor.js";
import { readManagedExternalCliCredential } from "./external-cli-sync.js";
import { createOAuthManager, OAuthManagerRefreshError } from "./oauth-manager.js";
import { assertNoOAuthSecretRefPolicyViolations } from "./policy.js";
import { suggestOAuthProfileIdForLegacyDefault } from "./repair.js";
import { loadAuthProfileStoreForSecretsRuntime } from "./store.js";
import type { AuthProfileStore, OAuthCredential } from "./types.js";

function listOAuthProviderIds(): string[] {
  if (typeof getOAuthProviders !== "function") {
    return [];
  }
  const providers = getOAuthProviders();
  if (!Array.isArray(providers)) {
    return [];
  }
  return providers
    .map((provider) =>
      provider &&
      typeof provider === "object" &&
      "id" in provider &&
      typeof provider.id === "string"
        ? provider.id
        : undefined,
    )
    .filter((providerId): providerId is string => typeof providerId === "string");
}

const OAUTH_PROVIDER_IDS = new Set<string>(listOAuthProviderIds());

const isOAuthProvider = (provider: string): provider is OAuthProvider =>
  OAUTH_PROVIDER_IDS.has(provider);

const resolveOAuthProvider = (provider: string): OAuthProvider | null =>
  isOAuthProvider(provider) ? provider : null;

/** Bearer-token auth modes that are interchangeable (oauth tokens and raw tokens). */
const BEARER_AUTH_MODES = new Set(["oauth", "token"]);

const isCompatibleModeType = (mode: string | undefined, type: string | undefined): boolean => {
  if (!mode || !type) {
    return false;
  }
  if (mode === type) {
    return true;
  }
  // Both token and oauth represent bearer-token auth paths — allow bidirectional compat.
  return BEARER_AUTH_MODES.has(mode) && BEARER_AUTH_MODES.has(type);
};

function isProfileConfigCompatible(params: {
  cfg?: OpenClawConfig;
  profileId: string;
  provider: string;
  mode: "api_key" | "token" | "oauth";
  allowOAuthTokenCompatibility?: boolean;
}): boolean {
  const profileConfig = params.cfg?.auth?.profiles?.[params.profileId];
  if (profileConfig && profileConfig.provider !== params.provider) {
    return false;
  }
  if (profileConfig && !isCompatibleModeType(profileConfig.mode, params.mode)) {
    return false;
  }
  return true;
}

async function buildOAuthApiKey(provider: string, credentials: OAuthCredential): Promise<string> {
  const formatted = await formatProviderAuthProfileApiKeyWithPlugin({
    provider,
    context: credentials,
  });
  return typeof formatted === "string" && formatted.length > 0 ? formatted : credentials.access;
}

function buildApiKeyProfileResult(params: { apiKey: string; provider: string; email?: string }) {
  return {
    apiKey: params.apiKey,
    provider: params.provider,
    email: params.email,
  };
}

function extractErrorMessage(error: unknown): string {
  return formatErrorMessage(error);
}

export function isRefreshTokenReusedError(error: unknown): boolean {
  const message = normalizeLowercaseStringOrEmpty(extractErrorMessage(error));
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
};

type SecretDefaults = NonNullable<OpenClawConfig["secrets"]>["defaults"];
export function normalizeAuthIdentityToken(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function normalizeAuthEmailToken(value: string | undefined): string | undefined {
  return normalizeAuthIdentityToken(value)?.toLowerCase();
}

/**
 * Returns true if `existing` and `incoming` provably belong to the same
 * account. Used to gate cross-agent credential mirroring.
 *
 * The rule is intentionally strict to satisfy the CWE-284 model:
 *   1. If one side carries identity metadata (accountId or email) and the
 *      other does not, refuse — we have no evidence they match.
 *   2. If both sides carry identity, a shared field must match (accountId
 *      wins over email when both present). If the two sides carry identity
 *      in non-overlapping fields (one has only accountId, the other only
 *      email), refuse.
 *   3. If neither side carries identity, return true: no evidence of
 *      mismatch and provider equality is checked separately by the caller.
 *
 * The previous permissive behaviour (fall back to `true` whenever a strict
 * comparison could not be made) was unsafe: a sub-agent whose refreshed
 * credential lacked identity metadata could overwrite a known-account main
 * credential that had it, allowing cross-account poisoning through the
 * mirror path.
 */
export function isSameOAuthIdentity(
  existing: Pick<OAuthCredential, "accountId" | "email">,
  incoming: Pick<OAuthCredential, "accountId" | "email">,
): boolean {
  const aAcct = normalizeAuthIdentityToken(existing.accountId);
  const bAcct = normalizeAuthIdentityToken(incoming.accountId);
  const aEmail = normalizeAuthEmailToken(existing.email);
  const bEmail = normalizeAuthEmailToken(incoming.email);
  const aHasIdentity = aAcct !== undefined || aEmail !== undefined;
  const bHasIdentity = bAcct !== undefined || bEmail !== undefined;

  // Asymmetric identity evidence — refuse. We cannot prove the two
  // credentials belong to the same account.
  if (aHasIdentity !== bHasIdentity) {
    return false;
  }

  // Both sides carry identity — require a positive match on a shared field.
  if (aHasIdentity) {
    if (aAcct !== undefined && bAcct !== undefined) {
      return aAcct === bAcct;
    }
    if (aEmail !== undefined && bEmail !== undefined) {
      return aEmail === bEmail;
    }
    // Identity metadata is present on both sides but in non-overlapping
    // fields (one has accountId, the other has only email, or vice versa).
    // No shared field to compare — refuse rather than guess.
    return false;
  }

  // Neither side carries identity metadata — provider equality is checked
  // separately by the caller; no evidence of mismatch here.
  return true;
}

/**
 * Identity gate used for both directions of credential copy:
 *   - mirror (sub-agent refresh -> main agent store)
 *   - adopt (main agent store -> sub-agent store)
 *
 * Rule: allow the copy iff
 *   1. no positive identity mismatch — if both sides expose the same
 *      identity field (accountId or email), the values must match, AND
 *   2. the incoming credential carries at least as much identity
 *      evidence as the existing one — if existing has accountId/email,
 *      incoming must carry the same field, AND
 *   3. when both sides carry identity but in non-overlapping fields
 *      (existing has only accountId, incoming has only email, or vice
 *      versa) we cannot positively prove the same account and the copy
 *      is refused.
 *
 * Accepts:
 *   - matching accountId (positive match on strongest field)
 *   - matching email when accountId is absent on both sides
 *   - neither side carries identity (no evidence of mismatch)
 *   - existing has no identity, incoming has identity (UPGRADE: adds
 *     the marker without dropping anything)
 *
 * Refuses:
 *   - mismatching accountId or email on a shared field (CWE-284 core)
 *   - incoming drops an identity field present on existing (regression
 *     that would later let a wrong-account peer pass this gate)
 *   - non-overlapping fields (no comparable positive match)
 *
 * Design note: this is a single unified rule for both copy directions.
 * The rule is deliberately one-sided because "existing" is whatever is
 * about to be overwritten and "incoming" is the new data — the
 * constraint is the same regardless of whether existing is main or sub.
 */
export function isSafeToCopyOAuthIdentity(
  existing: Pick<OAuthCredential, "accountId" | "email">,
  incoming: Pick<OAuthCredential, "accountId" | "email">,
): boolean {
  const aAcct = normalizeAuthIdentityToken(existing.accountId);
  const bAcct = normalizeAuthIdentityToken(incoming.accountId);
  const aEmail = normalizeAuthEmailToken(existing.email);
  const bEmail = normalizeAuthEmailToken(incoming.email);

  // (1) Positive match on a shared field, if one exists.
  if (aAcct !== undefined && bAcct !== undefined) {
    return aAcct === bAcct;
  }
  if (aEmail !== undefined && bEmail !== undefined) {
    return aEmail === bEmail;
  }

  // No shared comparable field beyond this point.
  const aHasIdentity = aAcct !== undefined || aEmail !== undefined;

  // (2) Refuse if existing has any identity evidence that incoming lacks.
  //     That covers both the "drop" case (incoming has nothing) and the
  //     "non-overlapping fields" case (existing has accountId only,
  //     incoming has email only, or vice versa).
  if (aHasIdentity) {
    return false;
  }

  // (3) Existing has no identity. Either incoming has none either
  //     (allowed: no evidence of mismatch) or incoming adds identity
  //     (allowed: pure upgrade, no loss).
  return true;
}

async function refreshOAuthCredential(
  credential: OAuthCredential,
): Promise<OAuthCredentials | null> {
  const pluginRefreshed = await refreshProviderOAuthCredentialWithPlugin({
    provider: credential.provider,
    context: credential,
  });
  if (pluginRefreshed) {
    return pluginRefreshed;
  }

  if (credential.provider === "chutes") {
    return await refreshChutesTokens({ credential });
  }

  const oauthProvider = resolveOAuthProvider(credential.provider);
  if (!oauthProvider || typeof getOAuthApiKey !== "function") {
    return null;
  }
  const result = await getOAuthApiKey(oauthProvider, {
    [credential.provider]: credential,
  });
  return result?.newCredentials ?? null;
}

const oauthManager = createOAuthManager({
  buildApiKey: buildOAuthApiKey,
  refreshCredential: refreshOAuthCredential,
  readBootstrapCredential: ({ profileId, credential }) =>
    readManagedExternalCliCredential({
      profileId,
      credential,
    }),
  isRefreshTokenReusedError,
});

export function resetOAuthRefreshQueuesForTest(): void {
  oauthManager.resetRefreshQueuesForTest();
}

async function tryResolveOAuthProfile(
  params: ResolveApiKeyForProfileParams,
): Promise<{ apiKey: string; provider: string; email?: string } | null> {
  const { cfg, store, profileId } = params;
  const cred = store.profiles[profileId];
  if (!cred || cred.type !== "oauth") {
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

  const resolved = await oauthManager.resolveOAuthAccess({
    store,
    profileId,
    credential: cred,
    agentDir: params.agentDir,
  });
  if (!resolved) {
    return null;
  }
  return buildApiKeyProfileResult({
    apiKey: resolved.apiKey,
    provider: resolved.credential.provider,
    email: resolved.credential.email ?? cred.email,
  });
}

async function resolveProfileSecretString(params: {
  profileId: string;
  provider: string;
  value: string | undefined;
  valueRef: unknown;
  refDefaults: SecretDefaults | undefined;
  configForRefResolution: OpenClawConfig;
  cache: SecretRefResolveCache;
  inlineFailureMessage: string;
  refFailureMessage: string;
}): Promise<string | undefined> {
  let resolvedValue = params.value?.trim();
  if (resolvedValue) {
    const inlineRef = coerceSecretRef(resolvedValue, params.refDefaults);
    if (inlineRef) {
      try {
        resolvedValue = await resolveSecretRefString(inlineRef, {
          config: params.configForRefResolution,
          env: process.env,
          cache: params.cache,
        });
      } catch (err) {
        log.debug(params.inlineFailureMessage, {
          profileId: params.profileId,
          provider: params.provider,
          error: formatErrorMessage(err),
        });
      }
    }
  }

  const explicitRef = coerceSecretRef(params.valueRef, params.refDefaults);
  if (!resolvedValue && explicitRef) {
    try {
      resolvedValue = await resolveSecretRefString(explicitRef, {
        config: params.configForRefResolution,
        env: process.env,
        cache: params.cache,
      });
    } catch (err) {
      log.debug(params.refFailureMessage, {
        profileId: params.profileId,
        provider: params.provider,
        error: formatErrorMessage(err),
      });
    }
  }

  return resolvedValue;
}

export async function resolveApiKeyForProfile(
  params: ResolveApiKeyForProfileParams,
): Promise<{ apiKey: string; provider: string; email?: string } | null> {
  const { cfg, store, profileId } = params;
  const cred = store.profiles[profileId];
  if (!cred) {
    return null;
  }
  if (
    !isProfileConfigCompatible({
      cfg,
      profileId,
      provider: cred.provider,
      mode: cred.type,
      // Compatibility: treat "oauth" config as compatible with stored token profiles.
      allowOAuthTokenCompatibility: true,
    })
  ) {
    return null;
  }

  const refResolveCache: SecretRefResolveCache = {};
  const configForRefResolution = cfg ?? loadConfig();
  const refDefaults = configForRefResolution.secrets?.defaults;
  assertNoOAuthSecretRefPolicyViolations({
    store,
    cfg: configForRefResolution,
    profileIds: [profileId],
    context: `auth profile ${profileId}`,
  });

  if (cred.type === "api_key") {
    const key = await resolveProfileSecretString({
      profileId,
      provider: cred.provider,
      value: cred.key,
      valueRef: cred.keyRef,
      refDefaults,
      configForRefResolution,
      cache: refResolveCache,
      inlineFailureMessage: "failed to resolve inline auth profile api_key ref",
      refFailureMessage: "failed to resolve auth profile api_key ref",
    });
    if (!key) {
      return null;
    }
    return buildApiKeyProfileResult({ apiKey: key, provider: cred.provider, email: cred.email });
  }
  if (cred.type === "token") {
    const expiryState = resolveTokenExpiryState(cred.expires);
    if (expiryState === "expired" || expiryState === "invalid_expires") {
      return null;
    }
    const token = await resolveProfileSecretString({
      profileId,
      provider: cred.provider,
      value: cred.token,
      valueRef: cred.tokenRef,
      refDefaults,
      configForRefResolution,
      cache: refResolveCache,
      inlineFailureMessage: "failed to resolve inline auth profile token ref",
      refFailureMessage: "failed to resolve auth profile token ref",
    });
    if (!token) {
      return null;
    }
    return buildApiKeyProfileResult({ apiKey: token, provider: cred.provider, email: cred.email });
  }

  try {
    const resolved = await oauthManager.resolveOAuthAccess({
      store,
      agentDir: params.agentDir,
      profileId,
      credential: cred,
    });
    if (!resolved) {
      return null;
    }
    return buildApiKeyProfileResult({
      apiKey: resolved.apiKey,
      provider: resolved.credential.provider,
      email: resolved.credential.email ?? cred.email,
    });
  } catch (error) {
    const refreshedStore =
      error instanceof OAuthManagerRefreshError
        ? error.getRefreshedStore()
        : loadAuthProfileStoreForSecretsRuntime(params.agentDir);
    const surfacedCause =
      error instanceof OAuthManagerRefreshError && error.cause ? error.cause : error;
    const surfacedMessageError =
      error instanceof OAuthManagerRefreshError && error.code === "refresh_contention"
        ? error
        : surfacedCause;
    const fallbackProfileId = suggestOAuthProfileIdForLegacyDefault({
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
        });
        if (fallbackResolved) {
          return fallbackResolved;
        }
      } catch {
        // keep original error
      }
    }

    const message = extractErrorMessage(surfacedMessageError);
    const hint = await formatAuthDoctorHint({
      cfg,
      store: refreshedStore,
      provider: cred.provider,
      profileId,
    });
    throw new Error(
      `OAuth token refresh failed for ${cred.provider}: ${message}. ` +
        "Please try again or re-authenticate." +
        (hint ? `\n\n${hint}` : ""),
      { cause: error },
    );
  }
}
