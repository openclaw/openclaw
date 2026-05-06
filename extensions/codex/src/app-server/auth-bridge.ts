import fs from "node:fs/promises";
import path from "node:path";
import {
  ensureAuthProfileStore,
  loadAuthProfileStoreForSecretsRuntime,
  resolveAuthProfileOrder,
  resolveProviderIdForAuth,
  resolveApiKeyForProfile,
  resolveDefaultAgentDir,
  resolvePersistedAuthProfileOwnerAgentDir,
  saveAuthProfileStore,
  type AuthProfileCredential,
  type OAuthCredential,
} from "openclaw/plugin-sdk/agent-runtime";
import type { CodexAppServerClient } from "./client.js";
import type { CodexAppServerStartOptions } from "./config.js";
import type { ChatgptAuthTokensRefreshResponse } from "./protocol-generated/typescript/v2/ChatgptAuthTokensRefreshResponse.js";
import type { GetAccountResponse } from "./protocol-generated/typescript/v2/GetAccountResponse.js";
import type { LoginAccountParams } from "./protocol-generated/typescript/v2/LoginAccountParams.js";
import { resolveCodexAppServerSpawnEnv } from "./transport-stdio.js";

const CODEX_APP_SERVER_AUTH_PROVIDER = "openai-codex";
const OPENAI_CODEX_DEFAULT_PROFILE_ID = "openai-codex:default";
const CODEX_HOME_ENV_VAR = "CODEX_HOME";
const HOME_ENV_VAR = "HOME";
const CODEX_APP_SERVER_HOME_DIRNAME = "codex-home";
const CODEX_APP_SERVER_NATIVE_HOME_DIRNAME = "home";
const CODEX_APP_SERVER_CONFIG_FILENAME = "config.toml";
const CODEX_API_KEY_ENV_VAR = "CODEX_API_KEY";
const OPENAI_API_KEY_ENV_VAR = "OPENAI_API_KEY";
const CODEX_APP_SERVER_API_KEY_ENV_VARS = [CODEX_API_KEY_ENV_VAR, OPENAI_API_KEY_ENV_VAR];
const CODEX_APP_SERVER_ISOLATION_ENV_VARS = [CODEX_HOME_ENV_VAR, HOME_ENV_VAR];

type AuthProfileOrderConfig = Parameters<typeof resolveAuthProfileOrder>[0]["cfg"];

export async function bridgeCodexAppServerStartOptions(params: {
  startOptions: CodexAppServerStartOptions;
  agentDir: string;
  authProfileId?: string;
  config?: AuthProfileOrderConfig;
}): Promise<CodexAppServerStartOptions> {
  if (params.startOptions.transport !== "stdio") {
    return params.startOptions;
  }
  const isolatedStartOptions = await withAgentCodexHomeEnvironment(
    params.startOptions,
    params.agentDir,
  );
  const store = ensureAuthProfileStore(params.agentDir, { allowKeychainPrompt: false });
  const authProfileId = resolveCodexAppServerAuthProfileId({
    authProfileId: params.authProfileId,
    store,
    config: params.config,
  });
  const shouldClearInheritedOpenAiApiKey = shouldClearOpenAiApiKeyForCodexAuthProfile({
    store,
    authProfileId,
    config: params.config,
  });
  return shouldClearInheritedOpenAiApiKey
    ? withClearedEnvironmentVariables(isolatedStartOptions, CODEX_APP_SERVER_API_KEY_ENV_VARS)
    : isolatedStartOptions;
}

export function resolveCodexAppServerAuthProfileId(params: {
  authProfileId?: string;
  store: ReturnType<typeof ensureAuthProfileStore>;
  config?: AuthProfileOrderConfig;
}): string | undefined {
  const requested = params.authProfileId?.trim();
  if (requested) {
    return requested;
  }
  return resolveAuthProfileOrder({
    cfg: params.config,
    store: params.store,
    provider: CODEX_APP_SERVER_AUTH_PROVIDER,
  })[0]?.trim();
}

export function resolveCodexAppServerAuthProfileIdForAgent(params: {
  authProfileId?: string;
  agentDir?: string;
  config?: AuthProfileOrderConfig;
}): string | undefined {
  const agentDir = params.agentDir?.trim() || resolveDefaultAgentDir(params.config ?? {});
  const store = ensureAuthProfileStore(agentDir, { allowKeychainPrompt: false });
  return resolveCodexAppServerAuthProfileId({
    authProfileId: params.authProfileId,
    store,
    config: params.config,
  });
}

export function resolveCodexAppServerHomeDir(agentDir: string): string {
  return path.join(path.resolve(agentDir), CODEX_APP_SERVER_HOME_DIRNAME);
}

export function resolveCodexAppServerNativeHomeDir(agentDir: string): string {
  return path.join(resolveCodexAppServerHomeDir(agentDir), CODEX_APP_SERVER_NATIVE_HOME_DIRNAME);
}

async function withAgentCodexHomeEnvironment(
  startOptions: CodexAppServerStartOptions,
  agentDir: string,
): Promise<CodexAppServerStartOptions> {
  const codexHome = startOptions.env?.[CODEX_HOME_ENV_VAR]?.trim()
    ? startOptions.env[CODEX_HOME_ENV_VAR]
    : resolveCodexAppServerHomeDir(agentDir);
  const nativeHome = startOptions.env?.[HOME_ENV_VAR]?.trim()
    ? startOptions.env[HOME_ENV_VAR]
    : path.join(codexHome, CODEX_APP_SERVER_NATIVE_HOME_DIRNAME);
  await fs.mkdir(codexHome, { recursive: true });
  await fs.mkdir(nativeHome, { recursive: true });
  await ensureCodexAppServerAppsConfig(codexHome);
  const nextStartOptions: CodexAppServerStartOptions = {
    ...startOptions,
    env: {
      ...startOptions.env,
      [CODEX_HOME_ENV_VAR]: codexHome,
      [HOME_ENV_VAR]: nativeHome,
    },
  };
  const clearEnv = withoutClearedCodexIsolationEnv(startOptions.clearEnv);
  if (clearEnv) {
    nextStartOptions.clearEnv = clearEnv;
  } else {
    delete nextStartOptions.clearEnv;
  }
  return nextStartOptions;
}

async function ensureCodexAppServerAppsConfig(codexHome: string): Promise<void> {
  const configPath = path.join(codexHome, CODEX_APP_SERVER_CONFIG_FILENAME);
  let current = "";
  try {
    current = await fs.readFile(configPath, "utf8");
  } catch (error) {
    if (!isNodeErrorCode(error, "ENOENT")) {
      throw error;
    }
  }
  const next = upsertTomlBoolean(
    upsertTomlBoolean(current, "features", "apps"),
    "apps._default",
    "enabled",
  );
  if (next !== current) {
    await fs.writeFile(configPath, next, "utf8");
  }
}

function upsertTomlBoolean(content: string, section: string, key: string): string {
  const lines = content.split(/\r?\n/);
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  const sectionHeader = `[${section}]`;
  const sectionStart = lines.findIndex((line) => line.trim() === sectionHeader);
  if (sectionStart === -1) {
    const nextLines = [...lines];
    if (nextLines.length > 0) {
      nextLines.push("");
    }
    nextLines.push(sectionHeader, `${key} = true`);
    return `${nextLines.join("\n")}\n`;
  }

  const sectionEnd = findTomlSectionEnd(lines, sectionStart + 1);
  const keyIndex = findTomlKey(lines, key, sectionStart + 1, sectionEnd);
  const nextLines = [...lines];
  if (keyIndex === -1) {
    nextLines.splice(sectionEnd, 0, `${key} = true`);
  } else if (nextLines[keyIndex] !== `${key} = true`) {
    nextLines[keyIndex] = `${key} = true`;
  }
  return `${nextLines.join("\n")}\n`;
}

function findTomlSectionEnd(lines: string[], start: number): number {
  for (let index = start; index < lines.length; index += 1) {
    if (/^\s*\[[^\]]+\]\s*$/.test(lines[index])) {
      return index;
    }
  }
  return lines.length;
}

function findTomlKey(lines: string[], key: string, start: number, end: number): number {
  const keyPattern = new RegExp(`^\\s*${escapeRegExp(key)}\\s*=`);
  for (let index = start; index < end; index += 1) {
    const line = lines[index];
    if (line.trimStart().startsWith("#")) {
      continue;
    }
    if (keyPattern.test(line)) {
      return index;
    }
  }
  return -1;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isNodeErrorCode(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === code);
}

function withoutClearedCodexIsolationEnv(clearEnv: string[] | undefined): string[] | undefined {
  if (!clearEnv) {
    return undefined;
  }
  const reserved = new Set(CODEX_APP_SERVER_ISOLATION_ENV_VARS);
  const filtered = clearEnv.filter((envVar) => !reserved.has(envVar.trim().toUpperCase()));
  return filtered.length === clearEnv.length ? clearEnv : filtered;
}

export async function applyCodexAppServerAuthProfile(params: {
  client: CodexAppServerClient;
  agentDir: string;
  authProfileId?: string;
  startOptions?: CodexAppServerStartOptions;
  config?: AuthProfileOrderConfig;
}): Promise<void> {
  const loginParams = await resolveCodexAppServerAuthProfileLoginParams({
    agentDir: params.agentDir,
    authProfileId: params.authProfileId,
    config: params.config,
  });
  if (!loginParams) {
    if (params.startOptions?.transport !== "stdio") {
      return;
    }
    const env = resolveCodexAppServerSpawnEnv(params.startOptions, process.env);
    const fallbackLoginParams = await resolveCodexAppServerEnvApiKeyLoginParams({
      client: params.client,
      env,
    });
    if (fallbackLoginParams) {
      await params.client.request("account/login/start", fallbackLoginParams);
    }
    return;
  }
  await params.client.request("account/login/start", loginParams);
}

function resolveCodexAppServerAuthProfileLoginParams(params: {
  agentDir: string;
  authProfileId?: string;
  config?: AuthProfileOrderConfig;
}): Promise<LoginAccountParams | undefined> {
  return resolveCodexAppServerAuthProfileLoginParamsInternal(params);
}

export async function refreshCodexAppServerAuthTokens(params: {
  agentDir: string;
  authProfileId?: string;
  config?: AuthProfileOrderConfig;
}): Promise<ChatgptAuthTokensRefreshResponse> {
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

async function resolveCodexAppServerAuthProfileLoginParamsInternal(params: {
  agentDir: string;
  authProfileId?: string;
  forceOAuthRefresh?: boolean;
  config?: AuthProfileOrderConfig;
}): Promise<LoginAccountParams | undefined> {
  const store = ensureAuthProfileStore(params.agentDir, { allowKeychainPrompt: false });
  const profileId = resolveCodexAppServerAuthProfileId({
    authProfileId: params.authProfileId,
    store,
    config: params.config,
  });
  if (!profileId) {
    return undefined;
  }
  const credential = store.profiles[profileId];
  if (!credential) {
    throw new Error(`Codex app-server auth profile "${profileId}" was not found.`);
  }
  if (!isCodexAppServerAuthProvider(credential.provider, params.config)) {
    throw new Error(
      `Codex app-server auth profile "${profileId}" must belong to provider "openai-codex" or a supported alias.`,
    );
  }
  const loginParams = await resolveLoginParamsForCredential(profileId, credential, {
    agentDir: params.agentDir,
    forceOAuthRefresh: params.forceOAuthRefresh === true,
    config: params.config,
  });
  if (!loginParams) {
    throw new Error(
      `Codex app-server auth profile "${profileId}" does not contain usable credentials.`,
    );
  }
  return loginParams;
}

async function resolveCodexAppServerEnvApiKeyLoginParams(params: {
  client: CodexAppServerClient;
  env: NodeJS.ProcessEnv;
}): Promise<LoginAccountParams | undefined> {
  const apiKey = readFirstNonEmptyEnv(params.env, CODEX_APP_SERVER_API_KEY_ENV_VARS);
  if (!apiKey) {
    return undefined;
  }
  const response = await params.client.request<GetAccountResponse>("account/read", {
    refreshToken: false,
  });
  if (response.account || !response.requiresOpenaiAuth) {
    return undefined;
  }
  return { type: "apiKey", apiKey };
}

async function resolveLoginParamsForCredential(
  profileId: string,
  credential: AuthProfileCredential,
  params: { agentDir: string; forceOAuthRefresh: boolean; config?: AuthProfileOrderConfig },
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
    config: params.config,
  });
  const accessToken = resolvedCredential.access?.trim();
  return accessToken
    ? buildChatgptAuthTokensParams(profileId, resolvedCredential, accessToken)
    : undefined;
}

async function resolveOAuthCredentialForCodexAppServer(
  profileId: string,
  credential: OAuthCredential,
  params: { agentDir: string; forceRefresh: boolean; config?: AuthProfileOrderConfig },
): Promise<OAuthCredential> {
  const ownerAgentDir = resolvePersistedAuthProfileOwnerAgentDir({
    agentDir: params.agentDir,
    profileId,
  });
  const store = ensureAuthProfileStore(ownerAgentDir, { allowKeychainPrompt: false });
  const ownerCredential = store.profiles[profileId];
  const credentialForOwner =
    ownerCredential?.type === "oauth" &&
    isCodexAppServerAuthProvider(ownerCredential.provider, params.config)
      ? ownerCredential
      : credential;
  if (params.forceRefresh) {
    store.profiles[profileId] = { ...credentialForOwner, expires: 0 };
    saveAuthProfileStore(store, ownerAgentDir);
  }
  const resolved = await resolveApiKeyForProfile({
    store,
    profileId,
    agentDir: ownerAgentDir,
  });
  const refreshed = loadAuthProfileStoreForSecretsRuntime(ownerAgentDir).profiles[profileId];
  const storedCredential = store.profiles[profileId];
  const candidate =
    refreshed?.type === "oauth" && isCodexAppServerAuthProvider(refreshed.provider, params.config)
      ? refreshed
      : storedCredential?.type === "oauth" &&
          isCodexAppServerAuthProvider(storedCredential.provider, params.config)
        ? storedCredential
        : credential;
  return resolved?.apiKey ? { ...candidate, access: resolved.apiKey } : candidate;
}

function isCodexAppServerAuthProvider(provider: string, config?: AuthProfileOrderConfig): boolean {
  return resolveProviderIdForAuth(provider, { config }) === CODEX_APP_SERVER_AUTH_PROVIDER;
}

function shouldClearOpenAiApiKeyForCodexAuthProfile(params: {
  store: ReturnType<typeof ensureAuthProfileStore>;
  authProfileId?: string;
  config?: AuthProfileOrderConfig;
}): boolean {
  const profileId = params.authProfileId?.trim();
  const credential = profileId
    ? params.store.profiles[profileId]
    : params.store.profiles[OPENAI_CODEX_DEFAULT_PROFILE_ID];
  return isCodexSubscriptionCredential(credential, params.config);
}

function isCodexSubscriptionCredential(
  credential: AuthProfileCredential | undefined,
  config?: AuthProfileOrderConfig,
): boolean {
  if (!credential || !isCodexAppServerAuthProvider(credential.provider, config)) {
    return false;
  }
  return credential.type === "oauth" || credential.type === "token";
}

function withClearedEnvironmentVariables(
  startOptions: CodexAppServerStartOptions,
  envVars: readonly string[],
): CodexAppServerStartOptions {
  const clearEnv = startOptions.clearEnv ?? [];
  const missingEnvVars = envVars.filter((envVar) => !clearEnv.includes(envVar));
  if (missingEnvVars.length === 0) {
    return startOptions;
  }
  return {
    ...startOptions,
    clearEnv: [...clearEnv, ...missingEnvVars],
  };
}

function readFirstNonEmptyEnv(env: NodeJS.ProcessEnv, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = env[key]?.trim();
    if (value) {
      return value;
    }
  }
  return undefined;
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
