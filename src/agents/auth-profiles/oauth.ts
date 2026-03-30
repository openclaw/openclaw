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
import { resolveProcessScopedMap } from "../../shared/process-scoped-map.js";
import { refreshChutesTokens } from "../chutes-oauth.js";
import { AUTH_STORE_LOCK_OPTIONS, log } from "./constants.js";
import { resolveTokenExpiryState } from "./credential-state.js";
import { formatAuthDoctorHint } from "./doctor.js";
import { ensureAuthStoreFile, resolveAuthStorePath } from "./paths.js";
import { suggestOAuthProfileIdForLegacyDefault } from "./repair.js";
import {
  ensureAuthProfileStore,
  loadAuthProfileStoreForSecretsRuntime,
  saveAuthProfileStore,
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

type OAuthRefreshResult = {
  apiKey: string;
  newCredentials: OAuthCredentials;
  originAgentDir?: string;
};

const OAUTH_REFRESH_IN_FLIGHT_KEY = Symbol.for("openclaw.authProfiles.oauthRefreshInFlight");
const oauthRefreshInFlight = resolveProcessScopedMap<Promise<OAuthRefreshResult | null>>(
  OAUTH_REFRESH_IN_FLIGHT_KEY,
);

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
  const message = extractErrorMessage(error).toLowerCase();
  return (
    message.includes("refresh_token_reused") ||
    message.includes("refresh token has already been used") ||
    message.includes("already been used to generate a new access token")
  );
}

function buildOAuthRefreshMutexKey(params: {
  profileId: string;
  provider: string;
  agentDir?: string;
}): string {
  return `${params.provider}:${params.profileId}:${resolveAuthStorePath(params.agentDir)}`;
}

function hasOAuthCredentialChanged(
  previous: Pick<OAuthCredential, "access" | "refresh" | "expires">,
  current: Pick<OAuthCredential, "access" | "refresh" | "expires">,
): boolean {
  return (
    previous.access !== current.access ||
    previous.refresh !== current.refresh ||
    previous.expires !== current.expires
  );
}

async function syncOAuthCredentialToStore(params: {
  profileId: string;
  agentDir?: string;
  provider: string;
  email?: string;
  newCredentials: OAuthCredentials;
}): Promise<void> {
  await updateAuthProfileStoreWithLock({
    agentDir: params.agentDir,
    updater: (store) => {
      const current = store.profiles[params.profileId];
      if (current && current.type !== "oauth") {
        return false;
      }
      if (current?.type === "oauth" && current.provider !== params.provider) {
        return false;
      }
      const nextCredential = {
        ...(current?.type === "oauth" ? current : {}),
        ...params.newCredentials,
        type: "oauth" as const,
        provider: params.provider,
        email: params.email ?? (current?.type === "oauth" ? current.email : undefined),
      };
      if (
        current?.type === "oauth" &&
        current.provider === nextCredential.provider &&
        current.access === nextCredential.access &&
        current.refresh === nextCredential.refresh &&
        current.expires === nextCredential.expires &&
        current.email === nextCredential.email
      ) {
        return false;
      }
      store.profiles[params.profileId] = nextCredential;
      return true;
    },
  });
}

async function loadFreshStoredOAuthCredential(params: {
  profileId: string;
  agentDir?: string;
  provider: string;
  email?: string;
  previous?: Pick<OAuthCredential, "access" | "refresh" | "expires">;
  requireChange?: boolean;
}): Promise<OAuthRefreshResult | null> {
  const reloadedStore = loadAuthProfileStoreForSecretsRuntime(params.agentDir);
  const reloaded = reloadedStore.profiles[params.profileId];
  if (reloaded?.type !== "oauth" || reloaded.provider !== params.provider) {
    return null;
  }
  if (Date.now() >= reloaded.expires) {
    return null;
  }
  if (
    params.requireChange &&
    params.previous &&
    !hasOAuthCredentialChanged(params.previous, reloaded)
  ) {
    return null;
  }
  if (params.agentDir) {
    await syncOAuthCredentialToStore({
      profileId: params.profileId,
      agentDir: params.agentDir,
      provider: reloaded.provider,
      email: reloaded.email ?? params.email,
      newCredentials: reloaded,
    });
  }
  return {
    apiKey: await buildOAuthApiKey(reloaded.provider, reloaded),
    newCredentials: reloaded,
    originAgentDir: params.agentDir,
  };
}

async function awaitOAuthRefreshResult(
  refreshPromise: Promise<OAuthRefreshResult | null>,
  params: { profileId: string; agentDir?: string; provider: string; email?: string },
): Promise<OAuthRefreshResult | null> {
  const result = await refreshPromise;
  if (
    result &&
    params.agentDir &&
    (!result.originAgentDir || result.originAgentDir !== params.agentDir)
  ) {
    await syncOAuthCredentialToStore({
      profileId: params.profileId,
      agentDir: params.agentDir,
      provider: params.provider,
      email: params.email,
      newCredentials: result.newCredentials,
    });
  }
  return result;
}

type ResolveApiKeyForProfileParams = {
  cfg?: OpenClawConfig;
  store: AuthProfileStore;
  profileId: string;
  agentDir?: string;
};

type SecretDefaults = NonNullable<OpenClawConfig["secrets"]>["defaults"];

function adoptNewerMainOAuthCredential(params: {
  store: AuthProfileStore;
  profileId: string;
  agentDir?: string;
  cred: OAuthCredentials & { type: "oauth"; provider: string; email?: string };
}): (OAuthCredentials & { type: "oauth"; provider: string; email?: string }) | null {
  if (!params.agentDir) {
    return null;
  }
  try {
    const mainStore = ensureAuthProfileStore(undefined);
    const mainCred = mainStore.profiles[params.profileId];
    if (
      mainCred?.type === "oauth" &&
      mainCred.provider === params.cred.provider &&
      Number.isFinite(mainCred.expires) &&
      (!Number.isFinite(params.cred.expires) || mainCred.expires > params.cred.expires)
    ) {
      params.store.profiles[params.profileId] = { ...mainCred };
      saveAuthProfileStore(params.store, params.agentDir);
      log.info("adopted newer OAuth credentials from main agent", {
        profileId: params.profileId,
        agentDir: params.agentDir,
        expires: new Date(mainCred.expires).toISOString(),
      });
      return mainCred;
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

async function refreshOAuthTokenFromStoreWithLock(params: {
  profileId: string;
  agentDir?: string;
}): Promise<OAuthRefreshResult | null> {
  const authPath = resolveAuthStorePath(params.agentDir);
  ensureAuthStoreFile(authPath);

  return await withFileLock(authPath, AUTH_STORE_LOCK_OPTIONS, async () => {
    const store = ensureAuthProfileStore(params.agentDir);
    const cred = store.profiles[params.profileId];
    if (!cred || cred.type !== "oauth") {
      return null;
    }

    if (Date.now() < cred.expires) {
      return {
        apiKey: await buildOAuthApiKey(cred.provider, cred),
        newCredentials: cred,
        originAgentDir: params.agentDir,
      };
    }

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
    const result =
      String(cred.provider) === "chutes"
        ? await (async () => {
            const newCredentials = await refreshChutesTokens({
              credential: cred,
            });
            return { apiKey: newCredentials.access, newCredentials };
          })()
        : await (async () => {
            const oauthProvider = resolveOAuthProvider(cred.provider);
            if (!oauthProvider) {
              return null;
            }
            if (typeof getOAuthApiKey !== "function") {
              return null;
            }
            return await getOAuthApiKey(oauthProvider, oauthCreds);
          })();
    if (!result) {
      return null;
    }
    store.profiles[params.profileId] = {
      ...cred,
      ...result.newCredentials,
      type: "oauth",
    };
    saveAuthProfileStore(store, params.agentDir);

    return {
      ...result,
      originAgentDir: params.agentDir,
    };
  });
}

async function refreshOAuthTokenWithLock(params: {
  profileId: string;
  agentDir?: string;
  provider: string;
  email?: string;
  currentCredentials: OAuthCredential;
}): Promise<OAuthRefreshResult | null> {
  const mutexKey = buildOAuthRefreshMutexKey({
    profileId: params.profileId,
    provider: params.provider,
    agentDir: params.agentDir,
  });
  const inFlight = oauthRefreshInFlight.get(mutexKey);
  if (inFlight) {
    return await awaitOAuthRefreshResult(inFlight, params);
  }

  const refreshPromise = (async () => {
    const freshStored = await loadFreshStoredOAuthCredential({
      profileId: params.profileId,
      agentDir: params.agentDir,
      provider: params.provider,
      email: params.email,
    });
    if (freshStored) {
      return freshStored;
    }

    try {
      return await refreshOAuthTokenFromStoreWithLock({
        profileId: params.profileId,
        agentDir: params.agentDir,
      });
    } catch (error) {
      if (isRefreshTokenReusedError(error)) {
        const recovered = await loadFreshStoredOAuthCredential({
          profileId: params.profileId,
          agentDir: params.agentDir,
          provider: params.provider,
          email: params.email,
          previous: params.currentCredentials,
          requireChange: true,
        });
        if (recovered) {
          return recovered;
        }

        // Retry once after a hard reload in case another process already rotated
        // the refresh token but the stored access token is still expired.
        return await refreshOAuthTokenFromStoreWithLock({
          profileId: params.profileId,
          agentDir: params.agentDir,
        });
      }
      throw error;
    }
  })();
  oauthRefreshInFlight.set(mutexKey, refreshPromise);

  try {
    return await awaitOAuthRefreshResult(refreshPromise, params);
  } finally {
    if (oauthRefreshInFlight.get(mutexKey) === refreshPromise) {
      oauthRefreshInFlight.delete(mutexKey);
    }
  }
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
    provider: cred.provider,
    email: cred.email,
    currentCredentials: cred,
  });
  if (!refreshed) {
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
    adoptNewerMainOAuthCredential({
      store,
      profileId,
      agentDir: params.agentDir,
      cred,
    }) ?? cred;

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
      provider: cred.provider,
      email: cred.email,
      currentCredentials: cred,
    });
    if (!result) {
      return null;
    }
    return buildApiKeyProfileResult({
      apiKey: result.apiKey,
      provider: cred.provider,
      email: cred.email,
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
        if (mainCred?.type === "oauth" && Date.now() < mainCred.expires) {
          // Main agent has fresh credentials - copy them to this agent and use them
          refreshedStore.profiles[profileId] = { ...mainCred };
          saveAuthProfileStore(refreshedStore, params.agentDir);
          log.info("inherited fresh OAuth credentials from main agent", {
            profileId,
            agentDir: params.agentDir,
            expires: new Date(mainCred.expires).toISOString(),
          });
          return await buildOAuthProfileResult({
            provider: mainCred.provider,
            credentials: mainCred,
            email: mainCred.email,
          });
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
