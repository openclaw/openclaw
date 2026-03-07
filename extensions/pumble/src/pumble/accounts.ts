import type { OpenClawConfig } from "openclaw/plugin-sdk";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "openclaw/plugin-sdk/account-id";
import type { PumbleAccountConfig, PumbleChatMode } from "../types.js";

export type PumbleCredentialSource = "env" | "config" | "none";

export type ResolvedPumbleAccount = {
  accountId: string;
  enabled: boolean;
  name?: string;
  appId?: string;
  appKey?: string;
  clientSecret?: string;
  signingSecret?: string;
  botToken?: string;
  workspaceId?: string;
  appIdSource: PumbleCredentialSource;
  config: PumbleAccountConfig;
  requireMention?: boolean;
  channelAllowlist?: string[];
  textChunkLimit?: number;
  blockStreaming?: boolean;
  blockStreamingCoalesce?: PumbleAccountConfig["blockStreamingCoalesce"];
  chatmode?: PumbleChatMode;
  oncharPrefixes?: string[];
};

function listConfiguredAccountIds(cfg: OpenClawConfig): string[] {
  const accounts = cfg.channels?.pumble?.accounts;
  if (!accounts || typeof accounts !== "object") {
    return [];
  }
  return Object.keys(accounts).filter(Boolean);
}

export function listPumbleAccountIds(cfg: OpenClawConfig): string[] {
  const ids = listConfiguredAccountIds(cfg);
  if (ids.length === 0) {
    return [DEFAULT_ACCOUNT_ID];
  }
  return ids.toSorted((a, b) => a.localeCompare(b));
}

export function resolveDefaultPumbleAccountId(cfg: OpenClawConfig): string {
  const ids = listPumbleAccountIds(cfg);
  if (ids.includes(DEFAULT_ACCOUNT_ID)) {
    return DEFAULT_ACCOUNT_ID;
  }
  return ids[0] ?? DEFAULT_ACCOUNT_ID;
}

function resolveAccountConfig(
  cfg: OpenClawConfig,
  accountId: string,
): PumbleAccountConfig | undefined {
  const accounts = cfg.channels?.pumble?.accounts;
  if (!accounts || typeof accounts !== "object") {
    return undefined;
  }
  return accounts[accountId] as PumbleAccountConfig | undefined;
}

function mergePumbleAccountConfig(cfg: OpenClawConfig, accountId: string): PumbleAccountConfig {
  const { accounts: _ignored, ...base } = (cfg.channels?.pumble ?? {}) as PumbleAccountConfig & {
    accounts?: unknown;
  };
  const account = resolveAccountConfig(cfg, accountId) ?? {};
  return { ...base, ...account };
}

export function resolvePumbleAccount(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): ResolvedPumbleAccount {
  const accountId = normalizeAccountId(params.accountId);
  const baseEnabled = params.cfg.channels?.pumble?.enabled !== false;
  const merged = mergePumbleAccountConfig(params.cfg, accountId);
  const accountEnabled = merged.enabled !== false;
  const enabled = baseEnabled && accountEnabled;

  const allowEnv = accountId === DEFAULT_ACCOUNT_ID;
  const envAppId = allowEnv ? process.env.PUMBLE_APP_ID?.trim() : undefined;
  const envAppKey = allowEnv ? process.env.PUMBLE_APP_KEY?.trim() : undefined;
  const envClientSecret = allowEnv ? process.env.PUMBLE_APP_CLIENT_SECRET?.trim() : undefined;
  const envSigningSecret = allowEnv ? process.env.PUMBLE_APP_SIGNING_SECRET?.trim() : undefined;
  const envBotToken = allowEnv ? process.env.PUMBLE_BOT_TOKEN?.trim() : undefined;

  const configAppId = merged.appId?.trim();
  const configAppKey = merged.appKey?.trim();
  const configClientSecret = merged.clientSecret?.trim();
  const configSigningSecret = merged.signingSecret?.trim();
  const configBotToken = merged.botToken?.trim();

  const appId = configAppId || envAppId;
  const appKey = configAppKey || envAppKey;
  const clientSecret = configClientSecret || envClientSecret;
  const signingSecret = configSigningSecret || envSigningSecret;
  const botToken = configBotToken || envBotToken;
  const appIdSource: PumbleCredentialSource = configAppId ? "config" : envAppId ? "env" : "none";

  return {
    accountId,
    enabled,
    name: merged.name?.trim() || undefined,
    appId,
    appKey,
    clientSecret,
    signingSecret,
    botToken,
    workspaceId: merged.workspaceId?.trim() || undefined,
    appIdSource,
    config: merged,
    requireMention: merged.requireMention,
    channelAllowlist: merged.channelAllowlist,
    textChunkLimit: merged.textChunkLimit,
    blockStreaming: merged.blockStreaming,
    blockStreamingCoalesce: merged.blockStreamingCoalesce,
    chatmode: merged.chatmode,
    oncharPrefixes: merged.oncharPrefixes,
  };
}

export function listEnabledPumbleAccounts(cfg: OpenClawConfig): ResolvedPumbleAccount[] {
  return listPumbleAccountIds(cfg)
    .map((accountId) => resolvePumbleAccount({ cfg, accountId }))
    .filter((account) => account.enabled);
}
