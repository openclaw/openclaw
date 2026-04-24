import {
  ensureAuthProfileStore,
  loadAuthProfileStoreForSecretsRuntime,
  resolveApiKeyForProfile,
  saveAuthProfileStore,
  type AuthProfileCredential,
  type OAuthCredential,
} from "openclaw/plugin-sdk/agent-runtime";
import type { CodexAppServerClient } from "./client.js";
import type { CodexAppServerStartOptions } from "./config.js";
import type { ChatgptAuthTokensRefreshResponse } from "./protocol-generated/typescript/v2/ChatgptAuthTokensRefreshResponse.js";
import type { LoginAccountParams } from "./protocol-generated/typescript/v2/LoginAccountParams.js";

export async function bridgeCodexAppServerStartOptions(params: {
  startOptions: CodexAppServerStartOptions;
  agentDir: string;
  authProfileId?: string;
}): Promise<CodexAppServerStartOptions> {
  void params.agentDir;
  void params.authProfileId;
  return params.startOptions;
}

export async function applyCodexAppServerAuthProfile(params: {
  client: CodexAppServerClient;
  agentDir: string;
  authProfileId?: string;
}): Promise<void> {
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
}): Promise<LoginAccountParams | undefined> {
  const profileId = params.authProfileId?.trim();
  if (!profileId) {
    return undefined;
  }
  const store = ensureAuthProfileStore(params.agentDir, { allowKeychainPrompt: false });
  const credential = store.profiles[profileId];
  if (!credential) {
    throw new Error(`Codex app-server auth profile "${profileId}" was not found.`);
  }
  if (credential.provider !== "openai-codex") {
    throw new Error(
      `Codex app-server auth profile "${profileId}" must belong to provider "openai-codex".`,
    );
  }
  const loginParams = await resolveLoginParamsForCredential(profileId, credential, {
    agentDir: params.agentDir,
    forceOAuthRefresh: params.forceOAuthRefresh === true,
  });
  if (!loginParams) {
    throw new Error(
      `Codex app-server auth profile "${profileId}" does not contain usable inline credentials.`,
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
    const apiKey = credential.key?.trim();
    return apiKey ? { type: "apiKey", apiKey } : undefined;
  }
  if (credential.type === "token") {
    const accessToken = credential.token?.trim();
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
  const candidate =
    refreshed?.type === "oauth" && refreshed.provider === credential.provider
      ? refreshed
      : store.profiles[profileId]?.type === "oauth" &&
          store.profiles[profileId]?.provider === credential.provider
        ? store.profiles[profileId]
        : credential;
  return resolved?.apiKey ? { ...candidate, access: resolved.apiKey } : candidate;
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
    chatgptPlanType: null,
  };
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
