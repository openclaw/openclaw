import {
  getOAuthApiKey,
  getOAuthProviders,
  type OAuthCredentials,
  type OAuthProvider,
} from "@mariozechner/pi-ai/oauth";
import { loadConfig, type OpenClawConfig } from "../../config/config.js";
import { coerceSecretRef } from "../../config/types.secrets.js";
import { withFileLock } from "../../infra/file-lock.js";
import {
  formatProviderAuthProfileApiKeyWithPlugin,
  refreshProviderOAuthCredentialWithPlugin,
} from "../../plugins/provider-runtime.runtime.js";
import { resolveSecretRefString, type SecretRefResolveCache } from "../../secrets/resolve.js";
import { refreshChutesTokens } from "../chutes-oauth.js";
import { OAUTH_REFRESH_LOCK_OPTIONS, log } from "./constants.js";
import { resolveTokenExpiryState } from "./credential-state.js";
import { formatAuthDoctorHint } from "./doctor.js";
import { ensureAuthStoreFile, resolveAuthStorePath, resolveOAuthRefreshLockPath } from "./paths.js";
import { suggestOAuthProfileIdForLegacyDefault } from "./repair.js";
import {
  ensureAuthProfileStore,
  loadAuthProfileStoreForAgent,
  loadAuthProfileStoreForRuntime,
  updateAuthProfileStoreWithLock,
} from "./store.js";
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

async function buildOAuthProfileResult(params: {
  provider: string;
  credentials: OAuthCredential;
  email?: string;
}) {
  return buildApiKeyProfileResult({
    apiKey: await buildOAuthApiKey(params.provider, params.credentials),
    provider: params.provider,
    email: params.email,
  });
}

function extractErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRefreshTokenReusedError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /refresh_token_reused/i.test(message);
}

/**
 * Cross-agent credential sharing needs positive identity evidence. Providers
 * without stable account metadata may reuse the same profile id across distinct
 * accounts, so provider-only matches are not enough to safely copy tokens.
 */
function normalizeOAuthIdentityValue(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function normalizeOAuthEmail(value: string | undefined): string | undefined {
  const normalized = normalizeOAuthIdentityValue(value);
  return normalized?.toLowerCase();
}

function areOAuthCredentialsEquivalent(a: OAuthCredential, b: OAuthCredential): boolean {
  return (
    a.provider === b.provider &&
    a.access === b.access &&
    a.refresh === b.refresh &&
    Object.is(a.expires, b.expires) &&
    a.email === b.email &&
    a.enterpriseUrl === b.enterpriseUrl &&
    a.projectId === b.projectId &&
    a.accountId === b.accountId
  );
}

function hasPositiveOAuthIdentityMatch(a: OAuthCredential, b: OAuthCredential): boolean {
  if (a.provider !== b.provider) {
    return false;
  }

  // accountId is the strongest identity signal (used by Codex CLI credentials).
  const aAcct = normalizeOAuthIdentityValue(a.accountId);
  const bAcct = normalizeOAuthIdentityValue(b.accountId);
  if (aAcct || bAcct) {
    return aAcct !== undefined && aAcct === bAcct;
  }

  const aEmail = normalizeOAuthEmail(a.email);
  const bEmail = normalizeOAuthEmail(b.email);
  if (aEmail || bEmail) {
    return aEmail !== undefined && aEmail === bEmail;
  }

  return false;
}

function canShareOAuthCredentialAcrossAgents(a: OAuthCredential, b: OAuthCredential): boolean {
  if (a.provider !== b.provider) {
    return false;
  }
  return hasPositiveOAuthIdentityMatch(a, b) || areOAuthCredentialsEquivalent(a, b);
}

function shouldOverwriteOAuthCredential(
  existing: OAuthCredential,
  incoming: OAuthCredential,
): boolean {
  if (areOAuthCredentialsEquivalent(existing, incoming)) {
    return false;
  }
  if (!Number.isFinite(existing.expires)) {
    return true;
  }
  if (!Number.isFinite(incoming.expires)) {
    return false;
  }
  if (existing.expires < incoming.expires) {
    return true;
  }
  return (
    existing.expires === incoming.expires &&
    (existing.access !== incoming.access || existing.refresh !== incoming.refresh)
  );
}

async function performOAuthRefresh(
  cred: OAuthCredential,
): Promise<{ apiKey: string; newCredentials: OAuthCredentials } | null> {
  const pluginRefreshed = await refreshProviderOAuthCredentialWithPlugin({
    provider: cred.provider,
    context: cred,
  });
  if (pluginRefreshed) {
    return {
      apiKey: await buildOAuthApiKey(cred.provider, pluginRefreshed),
      newCredentials: pluginRefreshed,
    };
  }

  const oauthCreds: Record<string, OAuthCredentials> = { [cred.provider]: cred };
  if (String(cred.provider) === "chutes") {
    const newCredentials = await refreshChutesTokens({ credential: cred });
    return { apiKey: newCredentials.access, newCredentials };
  }

  const oauthProvider = resolveOAuthProvider(cred.provider);
  if (!oauthProvider) {
    return null;
  }
  return await getOAuthApiKey(oauthProvider, oauthCreds);
}

type WriteOAuthCredentialResult =
  | { status: "written" | "kept_current"; current: OAuthCredential }
  | { status: "missing" | "conflict" | "lock_failed"; current: null | OAuthCredential };

async function writeCredentialToAgentStore(params: {
  agentDir: string | undefined;
  profileId: string;
  expectedCurrent: OAuthCredential;
  newCred: OAuthCredential;
}): Promise<WriteOAuthCredentialResult> {
  let result: WriteOAuthCredentialResult = { status: "lock_failed", current: null };
  try {
    const updatedStore = await updateAuthProfileStoreWithLock({
      agentDir: params.agentDir,
      updater: (store) => {
        const existing = store.profiles[params.profileId];
        if (!existing || existing.type !== "oauth") {
          result = { status: "missing", current: null };
          return false;
        }
        if (!areOAuthCredentialsEquivalent(existing, params.expectedCurrent)) {
          result = { status: "conflict", current: existing };
          return false;
        }
        if (!shouldOverwriteOAuthCredential(existing, params.newCred)) {
          result = { status: "kept_current", current: existing };
          return false;
        }

        store.profiles[params.profileId] = { ...params.newCred };
        const written = store.profiles[params.profileId];
        if (written.type === "oauth") {
          result = { status: "written", current: written };
          return true;
        }
        result = { status: "missing", current: null };
        return false;
      },
    });
    if (!updatedStore) {
      return result;
    }
    return result;
  } catch (err) {
    log.debug("writeCredentialToAgentStore failed", {
      profileId: params.profileId,
      agentDir: params.agentDir,
      error: err instanceof Error ? err.message : String(err),
    });
    return { status: "lock_failed", current: null };
  }
}

type ResolveApiKeyForProfileParams = {
  cfg?: OpenClawConfig;
  store: AuthProfileStore;
  profileId: string;
  agentDir?: string;
};

type SecretDefaults = NonNullable<OpenClawConfig["secrets"]>["defaults"];
const READ_ONLY_AUTH_STORE_OPTIONS = { readOnly: true, allowKeychainPrompt: false } as const;

function resolveOAuthRefreshWriteTarget(params: {
  agentDir?: string;
  profileId: string;
  currentCred: OAuthCredential;
}): { agentDir: string | undefined; expectedCurrent: OAuthCredential } {
  const localStore = loadAuthProfileStoreForAgent(params.agentDir, READ_ONLY_AUTH_STORE_OPTIONS);
  const localCred = localStore.profiles[params.profileId];
  if (localCred?.type === "oauth" && areOAuthCredentialsEquivalent(localCred, params.currentCred)) {
    return {
      agentDir: params.agentDir,
      expectedCurrent: localCred,
    };
  }

  if (params.agentDir) {
    const mainStore = loadAuthProfileStoreForAgent(undefined, READ_ONLY_AUTH_STORE_OPTIONS);
    const mainCred = mainStore.profiles[params.profileId];
    if (mainCred?.type === "oauth" && areOAuthCredentialsEquivalent(mainCred, params.currentCred)) {
      return {
        agentDir: undefined,
        expectedCurrent: mainCred,
      };
    }
  }

  return {
    agentDir: params.agentDir,
    expectedCurrent: params.currentCred,
  };
}

async function adoptNewerMainOAuthCredential(params: {
  store: AuthProfileStore;
  profileId: string;
  agentDir?: string;
  cred: OAuthCredentials & { type: "oauth"; provider: string; email?: string };
}): Promise<(OAuthCredentials & { type: "oauth"; provider: string; email?: string }) | null> {
  if (!params.agentDir) {
    return null;
  }
  try {
    const mainStore = ensureAuthProfileStore(undefined);
    const mainCred = mainStore.profiles[params.profileId];
    if (
      mainCred?.type === "oauth" &&
      canShareOAuthCredentialAcrossAgents(params.cred, mainCred) &&
      Number.isFinite(mainCred.expires) &&
      (!Number.isFinite(params.cred.expires) || mainCred.expires > params.cred.expires)
    ) {
      const writeResult = await writeCredentialToAgentStore({
        agentDir: params.agentDir,
        profileId: params.profileId,
        expectedCurrent: params.cred,
        newCred: mainCred,
      });
      const currentCred = writeResult.current;
      if (
        currentCred &&
        canShareOAuthCredentialAcrossAgents(params.cred, currentCred) &&
        Number.isFinite(currentCred.expires) &&
        (!Number.isFinite(params.cred.expires) || currentCred.expires > params.cred.expires)
      ) {
        params.store.profiles[params.profileId] = { ...currentCred };
        log.info("adopted newer OAuth credentials from main agent", {
          profileId: params.profileId,
          agentDir: params.agentDir,
          expires: new Date(currentCred.expires).toISOString(),
        });
        return currentCred;
      }
    }
  } catch (err) {
    // Best-effort: don't crash if main agent store is missing or unreadable.
    log.debug("adoptNewerMainOAuthCredential failed", {
      profileId: params.profileId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
  return null;
}

/**
 * In-process serialization: callers for the same profileId are chained so only
 * one enters doRefreshOAuthTokenWithLock at a time. This prevents the re-entrant
 * file lock (same PID) from allowing concurrent performOAuthRefresh calls.
 * Keyed by profileId (not agentDir) so shared-profile agents serialize correctly.
 */
const refreshQueues = new Map<string, Promise<unknown>>();

async function refreshOAuthTokenWithLock(params: {
  profileId: string;
  agentDir?: string;
}): Promise<{ apiKey: string; newCredentials: OAuthCredentials } | null> {
  const key = params.profileId;
  const prev = refreshQueues.get(key) ?? Promise.resolve();
  let resolve!: () => void;
  const gate = new Promise<void>((r) => {
    resolve = r;
  });
  refreshQueues.set(key, gate);
  try {
    await prev;
    return await doRefreshOAuthTokenWithLock(params);
  } finally {
    resolve();
    if (refreshQueues.get(key) === gate) {
      refreshQueues.delete(key);
    }
  }
}

async function doRefreshOAuthTokenWithLock(params: {
  profileId: string;
  agentDir?: string;
}): Promise<{ apiKey: string; newCredentials: OAuthCredentials } | null> {
  const authPath = resolveAuthStorePath(params.agentDir);
  ensureAuthStoreFile(authPath);
  const globalLockPath = resolveOAuthRefreshLockPath(params.profileId);

  return await withFileLock(globalLockPath, OAUTH_REFRESH_LOCK_OPTIONS, async () => {
    // Refresh holds the global OAuth lock, not the per-store auth lock. Keep
    // these lookups read-only so external CLI sync can't persist auth store
    // changes while we're only coordinating refresh.
    const store = loadAuthProfileStoreForRuntime(params.agentDir, READ_ONLY_AUTH_STORE_OPTIONS);
    const cred = store.profiles[params.profileId];
    if (!cred || cred.type !== "oauth") {
      return null;
    }

    // Token may have been refreshed between the caller's expiry check and lock acquisition.
    if (Date.now() < cred.expires) {
      return {
        apiKey: await buildOAuthApiKey(cred.provider, cred),
        newCredentials: cred,
      };
    }

    // Check if another process already refreshed (visible in the main store).
    // Only adopt if the main credential is provably the same shared profile.
    if (params.agentDir) {
      const mainStore = loadAuthProfileStoreForAgent(undefined, READ_ONLY_AUTH_STORE_OPTIONS);
      const mainCred = mainStore.profiles[params.profileId];
      if (
        mainCred?.type === "oauth" &&
        Date.now() < mainCred.expires &&
        canShareOAuthCredentialAcrossAgents(cred, mainCred)
      ) {
        const adopted = await writeCredentialToAgentStore({
          agentDir: params.agentDir,
          profileId: params.profileId,
          expectedCurrent: cred,
          newCred: mainCred,
        });
        if (adopted.current && Date.now() < adopted.current.expires) {
          log.info("adopted fresh OAuth credentials from main store (under global lock)", {
            profileId: params.profileId,
            agentDir: params.agentDir,
            expires: new Date(adopted.current.expires).toISOString(),
          });
          return {
            apiKey: await buildOAuthApiKey(adopted.current.provider, adopted.current),
            newCredentials: adopted.current,
          };
        }
      }
    }

    // Attempt actual OAuth refresh.
    let refreshResult: { apiKey: string; newCredentials: OAuthCredentials } | null;
    try {
      refreshResult = await performOAuthRefresh(cred);
    } catch (refreshError) {
      // Recovery: if refresh_token_reused, another process may have refreshed
      // outside the lock (different machine, stale lock, copied credentials).
      if (isRefreshTokenReusedError(refreshError) && params.agentDir) {
        const recoveryStore = loadAuthProfileStoreForAgent(undefined, READ_ONLY_AUTH_STORE_OPTIONS);
        const recoveryCred = recoveryStore.profiles[params.profileId];
        if (
          recoveryCred?.type === "oauth" &&
          Date.now() < recoveryCred.expires &&
          canShareOAuthCredentialAcrossAgents(cred, recoveryCred)
        ) {
          const recovered = await writeCredentialToAgentStore({
            agentDir: params.agentDir,
            profileId: params.profileId,
            expectedCurrent: cred,
            newCred: recoveryCred,
          });
          if (recovered.current && Date.now() < recovered.current.expires) {
            log.info("recovered from refresh_token_reused via main store", {
              profileId: params.profileId,
              expires: new Date(recovered.current.expires).toISOString(),
            });
            return {
              apiKey: await buildOAuthApiKey(recovered.current.provider, recovered.current),
              newCredentials: recovered.current,
            };
          }
        }
      }
      throw refreshError;
    }

    if (!refreshResult) {
      return null;
    }

    const refreshWriteTarget = resolveOAuthRefreshWriteTarget({
      agentDir: params.agentDir,
      profileId: params.profileId,
      currentCred: cred,
    });

    // Persist the refreshed token back to whichever store currently owns this
    // OAuth snapshot. Sub-agents can inherit shared profiles from main without
    // having a local oauth entry to overwrite.
    const mergedCred: OAuthCredential = {
      ...cred,
      ...refreshResult.newCredentials,
      type: "oauth",
    };
    const localWrite = await writeCredentialToAgentStore({
      agentDir: refreshWriteTarget.agentDir,
      profileId: params.profileId,
      expectedCurrent: refreshWriteTarget.expectedCurrent,
      newCred: mergedCred,
    });
    const effectiveCred = localWrite.current;
    if (!effectiveCred || Date.now() >= effectiveCred.expires) {
      if (areOAuthCredentialsEquivalent(mergedCred, cred)) {
        return refreshResult;
      }
      return null;
    }

    // Write-back to main agent store so other agents benefit — only if
    // the sub-agent and main agent share the same OAuth identity.
    if (params.agentDir) {
      const mainStore = loadAuthProfileStoreForAgent(undefined, READ_ONLY_AUTH_STORE_OPTIONS);
      const mainCred = mainStore.profiles[params.profileId];
      if (
        refreshWriteTarget.agentDir !== undefined &&
        (localWrite.status === "written" || localWrite.status === "kept_current") &&
        mainCred?.type === "oauth" &&
        canShareOAuthCredentialAcrossAgents(cred, mainCred)
      ) {
        await writeCredentialToAgentStore({
          agentDir: undefined,
          profileId: params.profileId,
          expectedCurrent: mainCred,
          newCred: effectiveCred,
        });
      }
    }

    return {
      apiKey: await buildOAuthApiKey(effectiveCred.provider, effectiveCred),
      newCredentials: effectiveCred,
    };
  });
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

  if (Date.now() < cred.expires) {
    return await buildOAuthProfileResult({
      provider: cred.provider,
      credentials: cred,
      email: cred.email,
    });
  }

  const refreshed = await refreshOAuthTokenWithLock({
    profileId,
    agentDir: params.agentDir,
  });
  if (!refreshed) {
    const refreshedStore = loadAuthProfileStoreForRuntime(
      params.agentDir,
      READ_ONLY_AUTH_STORE_OPTIONS,
    );
    const current = refreshedStore.profiles[profileId];
    if (current && (current.type !== "oauth" || !areOAuthCredentialsEquivalent(current, cred))) {
      return await resolveApiKeyForProfile({
        cfg,
        store: refreshedStore,
        profileId,
        agentDir: params.agentDir,
      });
    }
    return null;
  }
  return buildApiKeyProfileResult({
    apiKey: refreshed.apiKey,
    provider: cred.provider,
    email: cred.email,
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
          error: err instanceof Error ? err.message : String(err),
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
        error: err instanceof Error ? err.message : String(err),
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

  const oauthCred =
    (await adoptNewerMainOAuthCredential({
      store,
      profileId,
      agentDir: params.agentDir,
      cred,
    })) ?? cred;

  if (Date.now() < oauthCred.expires) {
    return await buildOAuthProfileResult({
      provider: oauthCred.provider,
      credentials: oauthCred,
      email: oauthCred.email,
    });
  }

  try {
    const result = await refreshOAuthTokenWithLock({
      profileId,
      agentDir: params.agentDir,
    });
    if (!result) {
      const refreshedStore = loadAuthProfileStoreForRuntime(
        params.agentDir,
        READ_ONLY_AUTH_STORE_OPTIONS,
      );
      const current = refreshedStore.profiles[profileId];
      if (
        current &&
        (current.type !== "oauth" || !areOAuthCredentialsEquivalent(current, oauthCred))
      ) {
        return await resolveApiKeyForProfile({
          cfg,
          store: refreshedStore,
          profileId,
          agentDir: params.agentDir,
        });
      }
      return null;
    }
    return buildApiKeyProfileResult({
      apiKey: result.apiKey,
      provider: oauthCred.provider,
      email: oauthCred.email,
    });
  } catch (error) {
    const refreshedStore = ensureAuthProfileStore(params.agentDir);
    const refreshed = refreshedStore.profiles[profileId];
    if (refreshed?.type === "oauth" && Date.now() < refreshed.expires) {
      return await buildOAuthProfileResult({
        provider: refreshed.provider,
        credentials: refreshed,
        email: refreshed.email ?? cred.email,
      });
    }
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

    // Fallback: if this is a secondary agent, try using the main agent's credentials
    if (params.agentDir) {
      try {
        const mainStore = ensureAuthProfileStore(undefined); // main agent (no agentDir)
        const mainCred = mainStore.profiles[profileId];
        if (
          mainCred?.type === "oauth" &&
          Date.now() < mainCred.expires &&
          canShareOAuthCredentialAcrossAgents(cred, mainCred)
        ) {
          const inherited = await writeCredentialToAgentStore({
            agentDir: params.agentDir,
            profileId,
            expectedCurrent: cred,
            newCred: mainCred,
          });
          if (inherited.current && Date.now() < inherited.current.expires) {
            log.info("inherited fresh OAuth credentials from main agent", {
              profileId,
              agentDir: params.agentDir,
              expires: new Date(inherited.current.expires).toISOString(),
            });
            return await buildOAuthProfileResult({
              provider: inherited.current.provider,
              credentials: inherited.current,
              email: inherited.current.email,
            });
          }
        }
      } catch {
        // keep original error if main agent fallback also fails
      }
    }

    const message = extractErrorMessage(error);
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
