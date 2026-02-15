import type { OpenClawConfig } from "openclaw/plugin-sdk";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "openclaw/plugin-sdk/account-id";
import type { RocketchatAccountConfig, RocketchatChatMode } from "../types.js";
import { normalizeRocketchatBaseUrl } from "./client.js";

export type RocketchatTokenSource = "env" | "config" | "none";
export type RocketchatBaseUrlSource = "env" | "config" | "none";

export type ResolvedRocketchatAccount = {
  accountId: string;
  enabled: boolean;
  name?: string;
  authToken?: string;
  userId?: string;
  baseUrl?: string;
  authTokenSource: RocketchatTokenSource;
  baseUrlSource: RocketchatBaseUrlSource;
  config: RocketchatAccountConfig;
  chatmode?: RocketchatChatMode;
  oncharPrefixes?: string[];
  requireMention?: boolean;
  textChunkLimit?: number;
  blockStreaming?: boolean;
  blockStreamingCoalesce?: RocketchatAccountConfig["blockStreamingCoalesce"];
};

function listConfiguredAccountIds(cfg: OpenClawConfig): string[] {
  const accounts = cfg.channels?.rocketchat?.accounts;
  if (!accounts || typeof accounts !== "object") {
    return [];
  }
  return Object.keys(accounts).filter(Boolean);
}

export function listRocketchatAccountIds(cfg: OpenClawConfig): string[] {
  const ids = listConfiguredAccountIds(cfg);
  if (ids.length === 0) {
    return [DEFAULT_ACCOUNT_ID];
  }
  return ids.toSorted((a, b) => a.localeCompare(b));
}

export function resolveDefaultRocketchatAccountId(cfg: OpenClawConfig): string {
  const ids = listRocketchatAccountIds(cfg);
  if (ids.includes(DEFAULT_ACCOUNT_ID)) {
    return DEFAULT_ACCOUNT_ID;
  }
  return ids[0] ?? DEFAULT_ACCOUNT_ID;
}

function resolveAccountConfig(
  cfg: OpenClawConfig,
  accountId: string,
): RocketchatAccountConfig | undefined {
  const accounts = cfg.channels?.rocketchat?.accounts;
  if (!accounts || typeof accounts !== "object") {
    return undefined;
  }
  return accounts[accountId] as RocketchatAccountConfig | undefined;
}

function mergeRocketchatAccountConfig(
  cfg: OpenClawConfig,
  accountId: string,
): RocketchatAccountConfig {
  const { accounts: _ignored, ...base } = (cfg.channels?.rocketchat ??
    {}) as RocketchatAccountConfig & { accounts?: unknown };
  const account = resolveAccountConfig(cfg, accountId) ?? {};
  return { ...base, ...account };
}

function resolveRocketchatRequireMention(config: RocketchatAccountConfig): boolean | undefined {
  if (config.chatmode === "oncall") {
    return true;
  }
  if (config.chatmode === "onmessage") {
    return false;
  }
  if (config.chatmode === "onchar") {
    return true;
  }
  return config.requireMention;
}

export function resolveRocketchatAccount(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): ResolvedRocketchatAccount {
  const accountId = normalizeAccountId(params.accountId);
  const baseEnabled = params.cfg.channels?.rocketchat?.enabled !== false;
  const merged = mergeRocketchatAccountConfig(params.cfg, accountId);
  const accountEnabled = merged.enabled !== false;
  const enabled = baseEnabled && accountEnabled;

  const allowEnv = accountId === DEFAULT_ACCOUNT_ID;
  const envToken = allowEnv ? process.env.ROCKETCHAT_AUTH_TOKEN?.trim() : undefined;
  const envUserId = allowEnv ? process.env.ROCKETCHAT_USER_ID?.trim() : undefined;
  const envUrl = allowEnv ? process.env.ROCKETCHAT_URL?.trim() : undefined;
  const configToken = merged.authToken?.trim();
  const configUserId = merged.userId?.trim();
  const configUrl = merged.baseUrl?.trim();
  const authToken = configToken || envToken;
  const rcUserId = configUserId || envUserId;
  const baseUrl = normalizeRocketchatBaseUrl(configUrl || envUrl);
  const requireMention = resolveRocketchatRequireMention(merged);

  const authTokenSource: RocketchatTokenSource = configToken ? "config" : envToken ? "env" : "none";
  const baseUrlSource: RocketchatBaseUrlSource = configUrl ? "config" : envUrl ? "env" : "none";

  return {
    accountId,
    enabled,
    name: merged.name?.trim() || undefined,
    authToken,
    userId: rcUserId,
    baseUrl,
    authTokenSource,
    baseUrlSource,
    config: merged,
    chatmode: merged.chatmode,
    oncharPrefixes: merged.oncharPrefixes,
    requireMention,
    textChunkLimit: merged.textChunkLimit,
    blockStreaming: merged.blockStreaming,
    blockStreamingCoalesce: merged.blockStreamingCoalesce,
  };
}

export function listEnabledRocketchatAccounts(cfg: OpenClawConfig): ResolvedRocketchatAccount[] {
  return listRocketchatAccountIds(cfg)
    .map((accountId) => resolveRocketchatAccount({ cfg, accountId }))
    .filter((account) => account.enabled);
}
