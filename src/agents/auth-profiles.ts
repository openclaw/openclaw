import fs from "node:fs";
import path from "node:path";

import {
  getOAuthApiKey,
  type OAuthCredentials,
  type OAuthProvider,
} from "@mariozechner/pi-ai";
import lockfile from "proper-lockfile";

import type { ClawdbotConfig } from "../config/config.js";
import { resolveOAuthPath } from "../config/paths.js";
import { resolveUserPath } from "../utils.js";
import { resolveClawdbotAgentDir } from "./agent-paths.js";

const AUTH_STORE_VERSION = 1;
const AUTH_PROFILE_FILENAME = "auth-profiles.json";
const LEGACY_AUTH_FILENAME = "auth.json";

export type ApiKeyCredential = {
  type: "api_key";
  provider: string;
  key: string;
  email?: string;
};

export type OAuthCredential = OAuthCredentials & {
  type: "oauth";
  provider: OAuthProvider;
  email?: string;
};

export type AuthProfileCredential = ApiKeyCredential | OAuthCredential;

export type AuthProfileStore = {
  version: number;
  profiles: Record<string, AuthProfileCredential>;
  lastGood?: Record<string, string>;
};

type LegacyAuthStore = Record<string, AuthProfileCredential>;

function resolveAuthStorePath(): string {
  const agentDir = resolveClawdbotAgentDir();
  return path.join(agentDir, AUTH_PROFILE_FILENAME);
}

function resolveLegacyAuthStorePath(): string {
  const agentDir = resolveClawdbotAgentDir();
  return path.join(agentDir, LEGACY_AUTH_FILENAME);
}

function loadJsonFile(pathname: string): unknown {
  try {
    if (!fs.existsSync(pathname)) return undefined;
    const raw = fs.readFileSync(pathname, "utf8");
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}

function saveJsonFile(pathname: string, data: unknown) {
  const dir = path.dirname(pathname);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  fs.writeFileSync(pathname, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  fs.chmodSync(pathname, 0o600);
}

function ensureAuthStoreFile(pathname: string) {
  if (fs.existsSync(pathname)) return;
  const payload: AuthProfileStore = {
    version: AUTH_STORE_VERSION,
    profiles: {},
  };
  saveJsonFile(pathname, payload);
}

function buildOAuthApiKey(
  provider: OAuthProvider,
  credentials: OAuthCredentials,
): string {
  const needsProjectId =
    provider === "google-gemini-cli" || provider === "google-antigravity";
  return needsProjectId
    ? JSON.stringify({
        token: credentials.access,
        projectId: credentials.projectId,
      })
    : credentials.access;
}

async function refreshOAuthTokenWithLock(params: {
  profileId: string;
  provider: OAuthProvider;
}): Promise<{ apiKey: string; newCredentials: OAuthCredentials } | null> {
  const authPath = resolveAuthStorePath();
  ensureAuthStoreFile(authPath);

  let release: (() => Promise<void>) | undefined;
  try {
    release = await lockfile.lock(authPath, {
      retries: {
        retries: 10,
        factor: 2,
        minTimeout: 100,
        maxTimeout: 10_000,
        randomize: true,
      },
      stale: 30_000,
    });

    const store = ensureAuthProfileStore();
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
    const result = await getOAuthApiKey(cred.provider, oauthCreds);
    if (!result) return null;
    store.profiles[params.profileId] = {
      ...cred,
      ...result.newCredentials,
      type: "oauth",
    };
    saveAuthProfileStore(store);
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

function coerceLegacyStore(raw: unknown): LegacyAuthStore | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  if ("profiles" in record) return null;
  const entries: LegacyAuthStore = {};
  for (const [key, value] of Object.entries(record)) {
    if (!value || typeof value !== "object") continue;
    const typed = value as Partial<AuthProfileCredential>;
    if (typed.type !== "api_key" && typed.type !== "oauth") continue;
    entries[key] = {
      ...typed,
      provider: typed.provider ?? (key as OAuthProvider),
    } as AuthProfileCredential;
  }
  return Object.keys(entries).length > 0 ? entries : null;
}

function coerceAuthStore(raw: unknown): AuthProfileStore | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  if (!record.profiles || typeof record.profiles !== "object") return null;
  const profiles = record.profiles as Record<string, unknown>;
  const normalized: Record<string, AuthProfileCredential> = {};
  for (const [key, value] of Object.entries(profiles)) {
    if (!value || typeof value !== "object") continue;
    const typed = value as Partial<AuthProfileCredential>;
    if (typed.type !== "api_key" && typed.type !== "oauth") continue;
    if (!typed.provider) continue;
    normalized[key] = typed as AuthProfileCredential;
  }
  return {
    version: Number(record.version ?? AUTH_STORE_VERSION),
    profiles: normalized,
    lastGood:
      record.lastGood && typeof record.lastGood === "object"
        ? (record.lastGood as Record<string, string>)
        : undefined,
  };
}

function mergeOAuthFileIntoStore(store: AuthProfileStore): boolean {
  const oauthPath = resolveOAuthPath();
  const oauthRaw = loadJsonFile(oauthPath);
  if (!oauthRaw || typeof oauthRaw !== "object") return false;
  const oauthEntries = oauthRaw as Record<string, OAuthCredentials>;
  let mutated = false;
  for (const [provider, creds] of Object.entries(oauthEntries)) {
    if (!creds || typeof creds !== "object") continue;
    const profileId = `${provider}:default`;
    if (store.profiles[profileId]) continue;
    store.profiles[profileId] = {
      type: "oauth",
      provider: provider as OAuthProvider,
      ...creds,
    };
    mutated = true;
  }
  return mutated;
}

export function loadAuthProfileStore(): AuthProfileStore {
  const authPath = resolveAuthStorePath();
  const raw = loadJsonFile(authPath);
  const asStore = coerceAuthStore(raw);
  if (asStore) return asStore;

  const legacyRaw = loadJsonFile(resolveLegacyAuthStorePath());
  const legacy = coerceLegacyStore(legacyRaw);
  if (legacy) {
    const store: AuthProfileStore = {
      version: AUTH_STORE_VERSION,
      profiles: {},
    };
    for (const [provider, cred] of Object.entries(legacy)) {
      const profileId = `${provider}:default`;
      if (cred.type === "api_key") {
        store.profiles[profileId] = {
          type: "api_key",
          provider: cred.provider ?? (provider as OAuthProvider),
          key: cred.key,
          ...(cred.email ? { email: cred.email } : {}),
        };
      } else {
        store.profiles[profileId] = {
          type: "oauth",
          provider: cred.provider ?? (provider as OAuthProvider),
          access: cred.access,
          refresh: cred.refresh,
          expires: cred.expires,
          ...(cred.enterpriseUrl ? { enterpriseUrl: cred.enterpriseUrl } : {}),
          ...(cred.projectId ? { projectId: cred.projectId } : {}),
          ...(cred.accountId ? { accountId: cred.accountId } : {}),
          ...(cred.email ? { email: cred.email } : {}),
        };
      }
    }
    return store;
  }

  return { version: AUTH_STORE_VERSION, profiles: {} };
}

export function ensureAuthProfileStore(): AuthProfileStore {
  const authPath = resolveAuthStorePath();
  const raw = loadJsonFile(authPath);
  const asStore = coerceAuthStore(raw);
  if (asStore) return asStore;

  const legacyRaw = loadJsonFile(resolveLegacyAuthStorePath());
  const legacy = coerceLegacyStore(legacyRaw);
  const store: AuthProfileStore = {
    version: AUTH_STORE_VERSION,
    profiles: {},
  };
  if (legacy) {
    for (const [provider, cred] of Object.entries(legacy)) {
      const profileId = `${provider}:default`;
      if (cred.type === "api_key") {
        store.profiles[profileId] = {
          type: "api_key",
          provider: cred.provider ?? (provider as OAuthProvider),
          key: cred.key,
          ...(cred.email ? { email: cred.email } : {}),
        };
      } else {
        store.profiles[profileId] = {
          type: "oauth",
          provider: cred.provider ?? (provider as OAuthProvider),
          access: cred.access,
          refresh: cred.refresh,
          expires: cred.expires,
          ...(cred.enterpriseUrl ? { enterpriseUrl: cred.enterpriseUrl } : {}),
          ...(cred.projectId ? { projectId: cred.projectId } : {}),
          ...(cred.accountId ? { accountId: cred.accountId } : {}),
          ...(cred.email ? { email: cred.email } : {}),
        };
      }
    }
  }

  const mergedOAuth = mergeOAuthFileIntoStore(store);
  const shouldWrite = legacy !== null || mergedOAuth;
  if (shouldWrite) {
    saveJsonFile(authPath, store);
  }
  return store;
}

export function saveAuthProfileStore(store: AuthProfileStore): void {
  const authPath = resolveAuthStorePath();
  const payload = {
    version: AUTH_STORE_VERSION,
    profiles: store.profiles,
    lastGood: store.lastGood ?? undefined,
  } satisfies AuthProfileStore;
  saveJsonFile(authPath, payload);
}

export function upsertAuthProfile(params: {
  profileId: string;
  credential: AuthProfileCredential;
}): void {
  const store = ensureAuthProfileStore();
  store.profiles[params.profileId] = params.credential;
  saveAuthProfileStore(store);
}

export function listProfilesForProvider(
  store: AuthProfileStore,
  provider: string,
): string[] {
  return Object.entries(store.profiles)
    .filter(([, cred]) => cred.provider === provider)
    .map(([id]) => id);
}

export function resolveAuthProfileOrder(params: {
  cfg?: ClawdbotConfig;
  store: AuthProfileStore;
  provider: string;
  preferredProfile?: string;
}): string[] {
  const { cfg, store, provider, preferredProfile } = params;
  const configuredOrder = cfg?.auth?.order?.[provider];
  const explicitProfiles = cfg?.auth?.profiles
    ? Object.entries(cfg.auth.profiles)
        .filter(([, profile]) => profile.provider === provider)
        .map(([profileId]) => profileId)
    : [];
  const lastGood = store.lastGood?.[provider];
  const baseOrder =
    configuredOrder ??
    (explicitProfiles.length > 0
      ? explicitProfiles
      : listProfilesForProvider(store, provider));
  if (baseOrder.length === 0) return [];
  const order =
    configuredOrder && configuredOrder.length > 0
      ? baseOrder
      : orderProfilesByMode(baseOrder, store);

  const filtered = order.filter((profileId) => {
    const cred = store.profiles[profileId];
    return cred ? cred.provider === provider : true;
  });
  const deduped: string[] = [];
  for (const entry of filtered) {
    if (!deduped.includes(entry)) deduped.push(entry);
  }
  if (preferredProfile && deduped.includes(preferredProfile)) {
    const rest = deduped.filter((entry) => entry !== preferredProfile);
    if (lastGood && rest.includes(lastGood)) {
      return [
        preferredProfile,
        lastGood,
        ...rest.filter((entry) => entry !== lastGood),
      ];
    }
    return [preferredProfile, ...rest];
  }
  if (lastGood && deduped.includes(lastGood)) {
    return [lastGood, ...deduped.filter((entry) => entry !== lastGood)];
  }
  return deduped;
}

function orderProfilesByMode(
  order: string[],
  store: AuthProfileStore,
): string[] {
  const scored = order.map((profileId) => {
    const type = store.profiles[profileId]?.type;
    const score = type === "oauth" ? 0 : type === "api_key" ? 1 : 2;
    return { profileId, score };
  });
  return scored
    .sort((a, b) => a.score - b.score)
    .map((entry) => entry.profileId);
}

export async function resolveApiKeyForProfile(params: {
  cfg?: ClawdbotConfig;
  store: AuthProfileStore;
  profileId: string;
}): Promise<{ apiKey: string; provider: string; email?: string } | null> {
  const { cfg, store, profileId } = params;
  const cred = store.profiles[profileId];
  if (!cred) return null;
  const profileConfig = cfg?.auth?.profiles?.[profileId];
  if (profileConfig && profileConfig.provider !== cred.provider) return null;
  if (profileConfig && profileConfig.mode !== cred.type) return null;

  if (cred.type === "api_key") {
    return { apiKey: cred.key, provider: cred.provider, email: cred.email };
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
      provider: cred.provider,
    });
    if (!result) return null;
    return {
      apiKey: result.apiKey,
      provider: cred.provider,
      email: cred.email,
    };
  } catch (error) {
    const refreshedStore = ensureAuthProfileStore();
    const refreshed = refreshedStore.profiles[profileId];
    if (refreshed?.type === "oauth" && Date.now() < refreshed.expires) {
      return {
        apiKey: buildOAuthApiKey(refreshed.provider, refreshed),
        provider: refreshed.provider,
        email: refreshed.email ?? cred.email,
      };
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `OAuth token refresh failed for ${cred.provider}: ${message}. ` +
        "Please try again or re-authenticate.",
    );
  }
}

export function markAuthProfileGood(params: {
  store: AuthProfileStore;
  provider: string;
  profileId: string;
}): void {
  const { store, provider, profileId } = params;
  const profile = store.profiles[profileId];
  if (!profile || profile.provider !== provider) return;
  store.lastGood = { ...store.lastGood, [provider]: profileId };
  saveAuthProfileStore(store);
}

export function resolveAuthStorePathForDisplay(): string {
  const pathname = resolveAuthStorePath();
  return pathname.startsWith("~") ? pathname : resolveUserPath(pathname);
}

export function resolveAuthProfileDisplayLabel(params: {
  cfg?: ClawdbotConfig;
  store: AuthProfileStore;
  profileId: string;
}): string {
  const { cfg, store, profileId } = params;
  const profile = store.profiles[profileId];
  const configEmail = cfg?.auth?.profiles?.[profileId]?.email?.trim();
  const email = configEmail || profile?.email?.trim();
  if (email) return `${profileId} (${email})`;
  return profileId;
}
