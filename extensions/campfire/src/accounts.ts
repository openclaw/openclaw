import type { OpenClawConfig } from "openclaw/plugin-sdk";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "openclaw/plugin-sdk";
import type { CampfireAccountConfig } from "./types.js";

export type CampfireCredentialSource = "inline" | "env" | "none";

export type ResolvedCampfireAccount = {
  accountId: string;
  name?: string;
  enabled: boolean;
  config: CampfireAccountConfig;
  credentialSource: CampfireCredentialSource;
  /** Bot key in format {id}-{token} */
  botKey?: string;
  /** Base URL of the Campfire instance */
  baseUrl?: string;
};

const ENV_BOT_KEY = "CAMPFIRE_BOT_KEY";
const ENV_BASE_URL = "CAMPFIRE_BASE_URL";

function listConfiguredAccountIds(cfg: OpenClawConfig): string[] {
  const accounts = (
    cfg.channels?.["campfire"] as { accounts?: Record<string, unknown> } | undefined
  )?.accounts;
  if (!accounts || typeof accounts !== "object") {
    return [];
  }
  return Object.keys(accounts).filter(Boolean);
}

export function listCampfireAccountIds(cfg: OpenClawConfig): string[] {
  const ids = listConfiguredAccountIds(cfg);
  if (ids.length === 0) {
    return [DEFAULT_ACCOUNT_ID];
  }
  return ids.toSorted((a, b) => a.localeCompare(b));
}

export function resolveDefaultCampfireAccountId(cfg: OpenClawConfig): string {
  const channel = cfg.channels?.["campfire"] as { defaultAccount?: string } | undefined;
  if (channel?.defaultAccount?.trim()) {
    return channel.defaultAccount.trim();
  }
  const ids = listCampfireAccountIds(cfg);
  if (ids.includes(DEFAULT_ACCOUNT_ID)) {
    return DEFAULT_ACCOUNT_ID;
  }
  return ids[0] ?? DEFAULT_ACCOUNT_ID;
}

function resolveAccountConfig(
  cfg: OpenClawConfig,
  accountId: string,
): CampfireAccountConfig | undefined {
  const accounts = (
    cfg.channels?.["campfire"] as { accounts?: Record<string, CampfireAccountConfig> } | undefined
  )?.accounts;
  if (!accounts || typeof accounts !== "object") {
    return undefined;
  }
  return accounts[accountId];
}

function mergeCampfireAccountConfig(cfg: OpenClawConfig, accountId: string): CampfireAccountConfig {
  const raw = (cfg.channels?.["campfire"] ?? {}) as Record<string, unknown>;
  const { accounts: _ignored, defaultAccount: _ignored2, ...base } = raw;
  const account = resolveAccountConfig(cfg, accountId) ?? {};
  return { ...base, ...account } as CampfireAccountConfig;
}

function resolveCredentialsFromConfig(params: {
  accountId: string;
  account: CampfireAccountConfig;
}): {
  botKey?: string;
  baseUrl?: string;
  source: CampfireCredentialSource;
} {
  const { account, accountId } = params;

  // Check for inline configuration
  const inlineBotKey = account.botKey?.trim();
  const inlineBaseUrl = account.baseUrl?.trim();
  if (inlineBotKey && inlineBaseUrl) {
    return { botKey: inlineBotKey, baseUrl: inlineBaseUrl, source: "inline" };
  }

  // For default account, check environment variables
  if (accountId === DEFAULT_ACCOUNT_ID) {
    const envBotKey = process.env[ENV_BOT_KEY]?.trim();
    const envBaseUrl = process.env[ENV_BASE_URL]?.trim();
    if (envBotKey && envBaseUrl) {
      return { botKey: envBotKey, baseUrl: envBaseUrl, source: "env" };
    }
    // Allow partial config (some from inline, some from env)
    const botKey = inlineBotKey || envBotKey;
    const baseUrl = inlineBaseUrl || envBaseUrl;
    if (botKey && baseUrl) {
      return { botKey, baseUrl, source: inlineBotKey ? "inline" : "env" };
    }
  }

  // Partial inline config
  if (inlineBotKey || inlineBaseUrl) {
    return { botKey: inlineBotKey, baseUrl: inlineBaseUrl, source: "inline" };
  }

  return { source: "none" };
}

export function resolveCampfireAccount(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): ResolvedCampfireAccount {
  const accountId = normalizeAccountId(params.accountId);
  const baseEnabled =
    (params.cfg.channels?.["campfire"] as { enabled?: boolean } | undefined)?.enabled !== false;
  const merged = mergeCampfireAccountConfig(params.cfg, accountId);
  const accountEnabled = merged.enabled !== false;
  const enabled = baseEnabled && accountEnabled;
  const credentials = resolveCredentialsFromConfig({ accountId, account: merged });

  return {
    accountId,
    name: merged.name?.trim() || undefined,
    enabled,
    config: merged,
    credentialSource: credentials.source,
    botKey: credentials.botKey,
    baseUrl: credentials.baseUrl,
  };
}

export function listEnabledCampfireAccounts(cfg: OpenClawConfig): ResolvedCampfireAccount[] {
  return listCampfireAccountIds(cfg)
    .map((accountId) => resolveCampfireAccount({ cfg, accountId }))
    .filter((account) => account.enabled);
}

/**
 * Extract the bot ID from the bot key (format: {id}-{token}).
 */
export function extractBotId(botKey: string): string | null {
  const match = botKey.match(/^(\d+)-/);
  return match ? match[1] : null;
}

/**
 * Build the bot messages path for a room.
 */
export function buildBotMessagesPath(roomId: number, botKey: string): string {
  return `/rooms/${roomId}/${botKey}/messages`;
}
