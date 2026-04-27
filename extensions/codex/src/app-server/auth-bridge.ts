import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { mkdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import {
  ensureAuthProfileStore,
  loadAuthProfileStoreForSecretsRuntime,
  resolveProviderIdForAuth,
  resolveApiKeyForProfile,
  saveAuthProfileStore,
  type AuthProfileCredential,
  type AuthProfileStore,
  type OAuthCredential,
} from "openclaw/plugin-sdk/agent-runtime";
import type { CodexAppServerClient } from "./client.js";
import type { CodexAppServerStartOptions } from "./config.js";
import type { ChatgptAuthTokensRefreshResponse } from "./protocol-generated/typescript/v2/ChatgptAuthTokensRefreshResponse.js";
import type { LoginAccountParams } from "./protocol-generated/typescript/v2/LoginAccountParams.js";

const CODEX_APP_SERVER_AUTH_PROVIDER = "openai-codex";
const CODEX_APP_SERVER_API_KEY_ENV_VARS = [
  "OPENAI_API_KEY",
  "OPENAI_API_KEYS",
  "OPENAI_API_KEY_1",
  "OPENAI_API_KEY_2",
  "CODEX_API_KEY",
  "ACPX_AUTH_OPENAI_API_KEY",
  "ACPX_AUTH_CODEX_API_KEY",
];

export async function bridgeCodexAppServerStartOptions(params: {
  startOptions: CodexAppServerStartOptions;
  agentDir: string;
  authProfileId?: string;
}): Promise<CodexAppServerStartOptions> {
  const authProfileId = normalizeAuthProfileId(params.authProfileId);
  if (!authProfileId) {
    return params.startOptions;
  }
  const store = loadAuthProfileStoreForSecretsRuntime(params.agentDir);
  getCodexAppServerProfileCredential(store, authProfileId);

  const codexHome = resolveCodexAppServerCodexHome(params.agentDir, authProfileId);
  await mkdir(codexHome, { recursive: true });
  return {
    ...params.startOptions,
    env: {
      ...params.startOptions.env,
      CODEX_HOME: codexHome,
    },
    clearEnv: appendUnique(params.startOptions.clearEnv, CODEX_APP_SERVER_API_KEY_ENV_VARS),
  };
}

export async function applyCodexAppServerAuthProfile(params: {
  client: CodexAppServerClient;
  agentDir: string;
  authProfileId?: string;
}): Promise<void> {
  await syncCodexAppServerAuthProfileFromCodexHome({
    agentDir: params.agentDir,
    authProfileId: params.authProfileId,
  });
  const loginParams = await resolveCodexAppServerAuthProfileLoginParams({
    agentDir: params.agentDir,
    authProfileId: params.authProfileId,
  });
  if (!loginParams) {
    return;
  }
  await params.client.request("account/login/start", loginParams);
}

export function resolveCodexAppServerAuthProfileLoginParams(params: {
  agentDir: string;
  authProfileId?: string;
}): Promise<LoginAccountParams | undefined> {
  return resolveCodexAppServerAuthProfileLoginParamsInternal(params);
}

export async function refreshCodexAppServerAuthTokens(params: {
  agentDir: string;
  authProfileId?: string;
}): Promise<ChatgptAuthTokensRefreshResponse> {
  await syncCodexAppServerAuthProfileFromCodexHome({
    agentDir: params.agentDir,
    authProfileId: params.authProfileId,
  });
  const loginParams = await resolveCodexAppServerAuthProfileLoginParamsInternal({
    ...params,
    forceOAuthRefresh: true,
  });
  if (!loginParams || loginParams.type !== "chatgptAuthTokens") {
    throw new Error("Codex app-server ChatGPT token refresh requires an OAuth auth profile.");
  }
  return {
    accessToken: loginParams.accessToken,
    chatgptAccountId: loginParams.chatgptAccountId,
    chatgptPlanType: loginParams.chatgptPlanType ?? null,
  };
}

function normalizeAuthProfileId(authProfileId: string | undefined): string | undefined {
  return authProfileId?.trim() || undefined;
}

function resolveCodexAppServerCodexHome(agentDir: string, authProfileId: string): string {
  const digest = createHash("sha256").update(authProfileId).digest("hex").slice(0, 16);
  return path.join(agentDir, "harness-auth", "codex", "profiles", digest);
}

function appendUnique(base: readonly string[] | undefined, additions: readonly string[]): string[] {
  return [...new Set([...(base ?? []), ...additions])];
}

async function resolveCodexAppServerAuthProfileLoginParamsInternal(params: {
  agentDir: string;
  authProfileId?: string;
  forceOAuthRefresh?: boolean;
}): Promise<LoginAccountParams | undefined> {
  const profileId = normalizeAuthProfileId(params.authProfileId);
  if (!profileId) {
    return undefined;
  }
  const store = ensureAuthProfileStore(params.agentDir, { allowKeychainPrompt: false });
  const credential = getCodexAppServerProfileCredential(store, profileId);
  const loginParams = await resolveLoginParamsForCredential(profileId, credential, {
    agentDir: params.agentDir,
    forceOAuthRefresh: params.forceOAuthRefresh === true,
  });
  if (!loginParams) {
    throw new Error(
      `Codex app-server auth profile "${profileId}" does not contain usable credentials.`,
    );
  }
  return loginParams;
}

async function resolveLoginParamsForCredential(
  profileId: string,
  credential: AuthProfileCredential,
  params: { agentDir: string; forceOAuthRefresh: boolean },
): Promise<LoginAccountParams | undefined> {
  if (credential.type === "api_key") {
    const resolved = await resolveApiKeyForProfile({
      store: ensureAuthProfileStore(params.agentDir, { allowKeychainPrompt: false }),
      profileId,
      agentDir: params.agentDir,
    });
    const apiKey = resolved?.apiKey?.trim();
    return apiKey ? { type: "apiKey", apiKey } : undefined;
  }
  if (credential.type === "token") {
    const resolved = await resolveApiKeyForProfile({
      store: ensureAuthProfileStore(params.agentDir, { allowKeychainPrompt: false }),
      profileId,
      agentDir: params.agentDir,
    });
    const accessToken = resolved?.apiKey?.trim();
    return accessToken
      ? buildChatgptAuthTokensParams(profileId, credential, accessToken)
      : undefined;
  }
  const resolvedCredential = await resolveOAuthCredentialForCodexAppServer(profileId, credential, {
    agentDir: params.agentDir,
    forceRefresh: params.forceOAuthRefresh,
  });
  const accessToken = resolvedCredential.access?.trim();
  return accessToken
    ? buildChatgptAuthTokensParams(profileId, resolvedCredential, accessToken)
    : undefined;
}

async function resolveOAuthCredentialForCodexAppServer(
  profileId: string,
  credential: OAuthCredential,
  params: { agentDir: string; forceRefresh: boolean },
): Promise<OAuthCredential> {
  const store = ensureAuthProfileStore(params.agentDir, { allowKeychainPrompt: false });
  if (params.forceRefresh) {
    store.profiles[profileId] = { ...credential, expires: 0 };
    saveAuthProfileStore(store, params.agentDir);
  }
  const resolved = await resolveApiKeyForProfile({
    store,
    profileId,
    agentDir: params.agentDir,
  });
  const refreshed = loadAuthProfileStoreForSecretsRuntime(params.agentDir).profiles[profileId];
  const storedCredential = store.profiles[profileId];
  const candidate =
    refreshed?.type === "oauth" && isCodexAppServerAuthProvider(refreshed.provider)
      ? refreshed
      : storedCredential?.type === "oauth" &&
          isCodexAppServerAuthProvider(storedCredential.provider)
        ? storedCredential
        : credential;
  return resolved?.apiKey ? { ...candidate, access: resolved.apiKey } : candidate;
}

async function syncCodexAppServerAuthProfileFromCodexHome(params: {
  agentDir: string;
  authProfileId?: string;
}): Promise<void> {
  const profileId = normalizeAuthProfileId(params.authProfileId);
  if (!profileId) {
    return;
  }

  const codexHome = resolveCodexAppServerCodexHome(params.agentDir, profileId);
  const codexCredential = await readCodexHomeOAuthCredential(codexHome);
  if (!codexCredential) {
    return;
  }

  const store = loadAuthProfileStoreForSecretsRuntime(params.agentDir);
  const credential = getCodexAppServerProfileCredential(store, profileId);
  if (credential.type !== "oauth") {
    return;
  }

  const existingAccountId = credential.accountId?.trim();
  const codexAccountId = codexCredential.accountId?.trim();
  if (existingAccountId && codexAccountId && existingAccountId !== codexAccountId) {
    throw new Error(
      `Codex app-server CODEX_HOME auth for profile "${profileId}" belongs to a different account.`,
    );
  }

  const nextCredential: OAuthCredential = {
    ...credential,
    access: codexCredential.access,
    refresh: codexCredential.refresh,
    expires: codexCredential.expires,
    accountId: codexCredential.accountId ?? credential.accountId,
    idToken: codexCredential.idToken ?? credential.idToken,
  };
  if (credentialsMatch(credential, nextCredential)) {
    return;
  }

  store.profiles[profileId] = nextCredential;
  saveAuthProfileStore(store, params.agentDir);
}

function getCodexAppServerProfileCredential(
  store: AuthProfileStore,
  profileId: string,
): AuthProfileCredential {
  const credential = store.profiles[profileId];
  if (!credential) {
    throw new Error(`Codex app-server auth profile "${profileId}" was not found.`);
  }
  if (!isCodexAppServerAuthProvider(credential.provider)) {
    throw new Error(
      `Codex app-server auth profile "${profileId}" must belong to provider "openai-codex" or a supported alias.`,
    );
  }
  return credential;
}

function isCodexAppServerAuthProvider(provider: string): boolean {
  return resolveProviderIdForAuth(provider) === CODEX_APP_SERVER_AUTH_PROVIDER;
}

type CodexHomeOAuthCredential = {
  access: string;
  refresh: string;
  expires: number;
  accountId?: string;
  idToken?: string;
};

async function readCodexHomeOAuthCredential(
  codexHome: string,
): Promise<CodexHomeOAuthCredential | undefined> {
  const authPath = path.join(codexHome, "auth.json");
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(authPath, "utf8"));
  } catch (error) {
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? String((error as { code?: unknown }).code)
        : "";
    if (code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
  if (!isRecord(parsed)) {
    return undefined;
  }

  const tokens = isRecord(parsed.tokens) ? parsed.tokens : undefined;
  const access = stringFromCandidates(
    tokens?.access_token,
    tokens?.accessToken,
    parsed.access_token,
    parsed.accessToken,
  );
  const refresh = stringFromCandidates(
    tokens?.refresh_token,
    tokens?.refreshToken,
    parsed.refresh_token,
    parsed.refreshToken,
  );
  if (!access || !refresh) {
    return undefined;
  }

  return {
    access,
    refresh,
    expires:
      numericFromCandidates(
        tokens?.expires_at,
        tokens?.expiresAt,
        parsed.expires_at,
        parsed.expiresAt,
      ) ??
      decodeJwtExpiryMs(access) ??
      (await resolveCodexHomeAuthFallbackExpiry(authPath, parsed)),
    accountId: stringFromCandidates(
      tokens?.account_id,
      tokens?.accountId,
      parsed.account_id,
      parsed.accountId,
    ),
    idToken: stringFromCandidates(
      tokens?.id_token,
      tokens?.idToken,
      parsed.id_token,
      parsed.idToken,
    ),
  };
}

async function resolveCodexHomeAuthFallbackExpiry(
  authPath: string,
  parsed: Record<string, unknown>,
): Promise<number> {
  const lastRefreshRaw = parsed.last_refresh;
  const lastRefresh =
    typeof lastRefreshRaw === "string" || typeof lastRefreshRaw === "number"
      ? new Date(lastRefreshRaw).getTime()
      : Number.NaN;
  if (Number.isFinite(lastRefresh)) {
    return lastRefresh + 60 * 60_000;
  }
  try {
    const authStat = await stat(authPath);
    return authStat.mtimeMs + 60 * 60_000;
  } catch {
    return Date.now() + 60 * 60_000;
  }
}

function credentialsMatch(current: OAuthCredential, next: OAuthCredential): boolean {
  return (
    current.type === next.type &&
    current.access === next.access &&
    current.refresh === next.refresh &&
    current.expires === next.expires &&
    current.accountId === next.accountId &&
    current.idToken === next.idToken
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringFromCandidates(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value !== "string") {
      continue;
    }
    const trimmed = value.trim();
    if (trimmed) {
      return trimmed;
    }
  }
  return undefined;
}

function numericFromCandidates(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === "string" && value.trim()) {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
  }
  return undefined;
}

function decodeJwtExpiryMs(token: string): number | undefined {
  const [, payload] = token.split(".");
  if (!payload) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
      exp?: unknown;
    };
    return typeof parsed.exp === "number" && Number.isFinite(parsed.exp)
      ? parsed.exp * 1000
      : undefined;
  } catch {
    return undefined;
  }
}

function buildChatgptAuthTokensParams(
  profileId: string,
  credential: AuthProfileCredential,
  accessToken: string,
): LoginAccountParams {
  return {
    type: "chatgptAuthTokens",
    accessToken,
    chatgptAccountId: resolveChatgptAccountId(profileId, credential),
    chatgptPlanType: resolveChatgptPlanType(credential),
  };
}

function resolveChatgptPlanType(credential: AuthProfileCredential): string | null {
  const record = credential as Record<string, unknown>;
  const planType = record.chatgptPlanType ?? record.planType;
  return typeof planType === "string" && planType.trim() ? planType.trim() : null;
}

function resolveChatgptAccountId(profileId: string, credential: AuthProfileCredential): string {
  if ("accountId" in credential && typeof credential.accountId === "string") {
    const accountId = credential.accountId.trim();
    if (accountId) {
      return accountId;
    }
  }
  const email = credential.email?.trim();
  return email || profileId;
}
