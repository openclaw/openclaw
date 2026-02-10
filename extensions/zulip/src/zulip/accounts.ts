import type { OpenClawConfig } from "openclaw/plugin-sdk";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "openclaw/plugin-sdk";
import type { ZulipAccountConfig, ZulipChatMode, ZulipConfig } from "../types.js";
import { normalizeZulipBaseUrl } from "./client.js";

export type ZulipTokenSource = "env" | "config" | "none";
export type ZulipEmailSource = "env" | "config" | "none";
export type ZulipBaseUrlSource = "env" | "config" | "none";

export type ResolvedZulipAccount = {
  accountId: string;
  enabled: boolean;
  name?: string;
  apiKey?: string;
  email?: string;
  baseUrl?: string;
  apiKeySource: ZulipTokenSource;
  emailSource: ZulipEmailSource;
  baseUrlSource: ZulipBaseUrlSource;
  // Aliases for OpenClaw status display (maps apiKey → token)
  token?: string;
  tokenSource: ZulipTokenSource;
  config: ZulipAccountConfig;
  enableAdminActions?: boolean;
  chatmode?: ZulipChatMode;
  oncharPrefixes?: string[];
  requireMention?: boolean;
  textChunkLimit?: number;
  blockStreaming?: boolean;
  blockStreamingCoalesce?: ZulipAccountConfig["blockStreamingCoalesce"];
  streams?: string[];
};

function resolveZulipSection(cfg: OpenClawConfig): ZulipConfig | undefined {
  return cfg.channels?.zulip as ZulipConfig | undefined;
}

function listConfiguredAccountIds(cfg: OpenClawConfig): string[] {
  const accounts = resolveZulipSection(cfg)?.accounts;
  if (!accounts || typeof accounts !== "object") {
    return [];
  }
  return Object.keys(accounts).filter(Boolean);
}

export function listZulipAccountIds(cfg: OpenClawConfig): string[] {
  const ids = listConfiguredAccountIds(cfg);
  if (ids.length === 0) {
    return [DEFAULT_ACCOUNT_ID];
  }
  return ids.toSorted((a, b) => a.localeCompare(b));
}

export function resolveDefaultZulipAccountId(cfg: OpenClawConfig): string {
  const ids = listZulipAccountIds(cfg);
  if (ids.includes(DEFAULT_ACCOUNT_ID)) {
    return DEFAULT_ACCOUNT_ID;
  }
  return ids[0] ?? DEFAULT_ACCOUNT_ID;
}

function resolveAccountConfig(
  cfg: OpenClawConfig,
  accountId: string,
): ZulipAccountConfig | undefined {
  const accounts = resolveZulipSection(cfg)?.accounts;
  if (!accounts || typeof accounts !== "object") {
    return undefined;
  }
  return accounts[accountId] as ZulipAccountConfig | undefined;
}

function resolveZulipRequireMention(config: ZulipAccountConfig): boolean | undefined {
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

export function resolveZulipAccount(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): ResolvedZulipAccount {
  const accountId = normalizeAccountId(params.accountId);
  const zulipSection = resolveZulipSection(params.cfg);
  const baseEnabled = zulipSection?.enabled !== false;
  const { accounts: _ignored, ...baseConfig } = (zulipSection ?? {}) as ZulipConfig;
  const accountConfig = resolveAccountConfig(params.cfg, accountId) ?? {};
  const merged = { ...baseConfig, ...accountConfig };
  const accountEnabled = merged.enabled !== false;
  const enabled = baseEnabled && accountEnabled;

  const allowEnv = accountId === DEFAULT_ACCOUNT_ID;
  const envApiKey = allowEnv ? process.env.ZULIP_API_KEY?.trim() : undefined;
  const envEmail = allowEnv ? process.env.ZULIP_EMAIL?.trim() : undefined;
  const envUrl = allowEnv ? process.env.ZULIP_URL?.trim() : undefined;
  const envSite = allowEnv ? process.env.ZULIP_SITE?.trim() : undefined;
  const envRealm = allowEnv ? process.env.ZULIP_REALM?.trim() : undefined;
  const configApiKey = merged.apiKey?.trim();
  const configEmail = merged.email?.trim();
  const configUrl =
    accountConfig.url ??
    accountConfig.site ??
    accountConfig.realm ??
    baseConfig.url ??
    baseConfig.site ??
    baseConfig.realm;
  const configUrlTrimmed = configUrl?.trim();
  const apiKey = configApiKey || envApiKey;
  const email = configEmail || envEmail;
  const baseUrl = normalizeZulipBaseUrl(
    configUrlTrimmed || envUrl || envSite || envRealm,
  );
  const requireMention = resolveZulipRequireMention(merged);

  const apiKeySource: ZulipTokenSource = configApiKey ? "config" : envApiKey ? "env" : "none";
  const emailSource: ZulipEmailSource = configEmail ? "config" : envEmail ? "env" : "none";
  const baseUrlSource: ZulipBaseUrlSource =
    configUrlTrimmed ? "config" : envUrl || envSite || envRealm ? "env" : "none";

  return {
    accountId,
    enabled,
    name: merged.name?.trim() || undefined,
    apiKey,
    email,
    baseUrl,
    apiKeySource,
    emailSource,
    baseUrlSource,
    // Expose token/tokenSource aliases for OpenClaw status display
    token: apiKey,
    tokenSource: apiKeySource,
    config: merged,
    enableAdminActions: merged.enableAdminActions,
    chatmode: merged.chatmode,
    oncharPrefixes: merged.oncharPrefixes,
    requireMention,
    textChunkLimit: merged.textChunkLimit,
    blockStreaming: merged.blockStreaming,
    blockStreamingCoalesce: merged.blockStreamingCoalesce,
    streams: merged.streams,
  };
}

export function listEnabledZulipAccounts(cfg: OpenClawConfig): ResolvedZulipAccount[] {
  return listZulipAccountIds(cfg)
    .map((accountId) => resolveZulipAccount({ cfg, accountId }))
    .filter((account) => account.enabled);
}
