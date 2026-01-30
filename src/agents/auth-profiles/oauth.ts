import { getOAuthApiKey, type OAuthCredentials, type OAuthProvider } from "@mariozechner/pi-ai";
import lockfile from "proper-lockfile";

import type { OpenClawConfig } from "../../config/config.js";
import { refreshChutesTokens } from "../chutes-oauth.js";
import { refreshQwenPortalCredentials } from "../../providers/qwen-portal-oauth.js";
import { AUTH_STORE_LOCK_OPTIONS, log } from "./constants.js";
import { formatAuthDoctorHint } from "./doctor.js";
import { ensureAuthStoreFile, resolveAuthStorePath } from "./paths.js";
import { suggestOAuthProfileIdForLegacyDefault } from "./repair.js";
import { ensureAuthProfileStore, saveAuthProfileStore } from "./store.js";
import type { AuthProfileStore, OAuthCredential } from "./types.js";

function buildOAuthApiKey(provider: string, credentials: OAuthCredentials): string {
  const needsProjectId = provider === "google-gemini-cli" || provider === "google-antigravity";
  return needsProjectId
    ? JSON.stringify({
        token: credentials.access,
        projectId: credentials.projectId,
      })
    : credentials.access;
}

/**
 * Refresh Google Gemini CLI (Code Assist) OAuth token using stored credentials.
 * The clientId and clientSecret must match those used during login.
 */
async function refreshGeminiCliToken(
  cred: OAuthCredential,
): Promise<{ apiKey: string; newCredentials: OAuthCredentials }> {
  const clientId = cred.clientId;
  const clientSecret = cred.clientSecret;
  if (!clientId) {
    throw new Error(
      "Missing clientId for google-gemini-cli refresh. Re-login required: openclaw auth login google-gemini-cli",
    );
  }

  const body = new URLSearchParams({
    client_id: clientId,
    refresh_token: cred.refresh,
    grant_type: "refresh_token",
  });
  if (clientSecret) {
    body.set("client_secret", clientSecret);
  }

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Gemini CLI token refresh failed (${res.status}): ${text}`);
  }

  const data = (await res.json()) as {
    access_token: string;
    expires_in: number;
    refresh_token?: string;
  };

  const newCredentials: OAuthCredentials = {
    access: data.access_token,
    refresh: data.refresh_token ?? cred.refresh,
    expires: Date.now() + data.expires_in * 1000,
    projectId: cred.projectId,
  };

  return {
    apiKey: buildOAuthApiKey("google-gemini-cli", newCredentials),
    newCredentials: {
      ...newCredentials,
      // Preserve clientId/clientSecret for future refreshes (not part of OAuthCredentials)
    },
  };
}

async function refreshOAuthTokenWithLock(params: {
  profileId: string;
  agentDir?: string;
}): Promise<{ apiKey: string; newCredentials: OAuthCredentials } | null> {
  const authPath = resolveAuthStorePath(params.agentDir);
  ensureAuthStoreFile(authPath);

  let release: (() => Promise<void>) | undefined;
  try {
    release = await lockfile.lock(authPath, {
      ...AUTH_STORE_LOCK_OPTIONS,
    });

    const store = ensureAuthProfileStore(params.agentDir);
    const cred = store.profiles[params.profileId];
    if (!cred || cred.type !== "oauth") return null;

    if (Date.now() < cred.expires) {
      return {
        apiKey: buildOAuthApiKey(cred.provider, cred),
        newCredentials: cred,
      };
    }

    const oauthCreds: Record<string, OAuthCredentials> = {
      [cred.provider]: cred,
    };

    const result =
      String(cred.provider) === "chutes"
        ? await (async () => {
            const newCredentials = await refreshChutesTokens({
              credential: cred,
            });
            return { apiKey: newCredentials.access, newCredentials };
          })()
        : String(cred.provider) === "qwen-portal"
          ? await (async () => {
              const newCredentials = await refreshQwenPortalCredentials(cred);
              return { apiKey: newCredentials.access, newCredentials };
            })()
          : String(cred.provider) === "google-gemini-cli"
            ? await refreshGeminiCliToken(cred)
            : await getOAuthApiKey(cred.provider as OAuthProvider, oauthCreds);
    if (!result) return null;
    store.profiles[params.profileId] = {
      ...cred,
      ...result.newCredentials,
      type: "oauth",
    };
    saveAuthProfileStore(store, params.agentDir);

    return result;
  } finally {
    if (release) {
      try {
        await release();
      } catch {
        // ignore unlock errors
      }
    }
  }
}

async function tryResolveOAuthProfile(params: {
  cfg?: OpenClawConfig;
  store: AuthProfileStore;
  profileId: string;
  agentDir?: string;
}): Promise<{ apiKey: string; provider: string; email?: string } | null> {
  const { cfg, store, profileId } = params;
  const cred = store.profiles[profileId];
  if (!cred || cred.type !== "oauth") return null;
  const profileConfig = cfg?.auth?.profiles?.[profileId];
  if (profileConfig && profileConfig.provider !== cred.provider) return null;
  if (profileConfig && profileConfig.mode !== cred.type) return null;

  if (Date.now() < cred.expires) {
    return {
      apiKey: buildOAuthApiKey(cred.provider, cred),
      provider: cred.provider,
      email: cred.email,
    };
  }

  const refreshed = await refreshOAuthTokenWithLock({
    profileId,
    agentDir: params.agentDir,
  });
  if (!refreshed) return null;
  return {
    apiKey: refreshed.apiKey,
    provider: cred.provider,
    email: cred.email,
  };
}

export async function resolveApiKeyForProfile(params: {
  cfg?: OpenClawConfig;
  store: AuthProfileStore;
  profileId: string;
  agentDir?: string;
}): Promise<{ apiKey: string; provider: string; email?: string } | null> {
  const { cfg, store, profileId } = params;
  const cred = store.profiles[profileId];
  if (!cred) return null;
  const profileConfig = cfg?.auth?.profiles?.[profileId];
  if (profileConfig && profileConfig.provider !== cred.provider) return null;
  if (profileConfig && profileConfig.mode !== cred.type) {
    // Compatibility: treat "oauth" config as compatible with stored token profiles.
    if (!(profileConfig.mode === "oauth" && cred.type === "token")) return null;
  }

  if (cred.type === "api_key") {
    return { apiKey: cred.key, provider: cred.provider, email: cred.email };
  }
  if (cred.type === "token") {
    const token = cred.token?.trim();
    if (!token) return null;
    if (
      typeof cred.expires === "number" &&
      Number.isFinite(cred.expires) &&
      cred.expires > 0 &&
      Date.now() >= cred.expires
    ) {
      return null;
    }
    return { apiKey: token, provider: cred.provider, email: cred.email };
  }
  if (Date.now() < cred.expires) {
    return {
      apiKey: buildOAuthApiKey(cred.provider, cred),
      provider: cred.provider,
      email: cred.email,
    };
  }

  try {
    const result = await refreshOAuthTokenWithLock({
      profileId,
      agentDir: params.agentDir,
    });
    if (!result) return null;
    return {
      apiKey: result.apiKey,
      provider: cred.provider,
      email: cred.email,
    };
  } catch (error) {
    const refreshedStore = ensureAuthProfileStore(params.agentDir);
    const refreshed = refreshedStore.profiles[profileId];
    if (refreshed?.type === "oauth" && Date.now() < refreshed.expires) {
      return {
        apiKey: buildOAuthApiKey(refreshed.provider, refreshed),
        provider: refreshed.provider,
        email: refreshed.email ?? cred.email,
      };
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
        if (fallbackResolved) return fallbackResolved;
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
          return {
            apiKey: buildOAuthApiKey(mainCred.provider, mainCred),
            provider: mainCred.provider,
            email: mainCred.email,
          };
        }
      } catch {
        // keep original error if main agent fallback also fails
      }
    }

    const message = error instanceof Error ? error.message : String(error);
    const hint = formatAuthDoctorHint({
      cfg,
      store: refreshedStore,
      provider: cred.provider,
      profileId,
    });
    throw new Error(
      `OAuth token refresh failed for ${cred.provider}: ${message}. ` +
        "Please try again or re-authenticate." +
        (hint ? `\n\n${hint}` : ""),
    );
  }
}
