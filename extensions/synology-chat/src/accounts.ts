/**
 * Account resolution: reads config from channels.synology-chat,
 * merges per-account overrides, falls back to environment variables.
 */

import type { SynologyChatChannelConfig, ResolvedSynologyChatAccount } from "./types.js";

/** Extract the channel config from the full OpenClaw config object. */
function getChannelConfig(cfg: any): SynologyChatChannelConfig | undefined {
  return cfg?.channels?.["synology-chat"];
}

/** Parse allowedUserIds from string or array to string[]. */
function parseAllowedUserIds(raw: string | string[] | undefined): string[] {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw.filter(Boolean);
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * List all configured account IDs for this channel.
 * Returns ["default"] if there's a base config, plus any named accounts.
 */
export function listAccountIds(cfg: any): string[] {
  const channelCfg = getChannelConfig(cfg);
  if (!channelCfg) return [];

  const ids = new Set<string>();

  // If base config has a token, there's a "default" account
  const hasBaseToken = channelCfg.token || process.env.SYNOLOGY_CHAT_TOKEN;
  if (hasBaseToken) {
    ids.add("default");
  }

  // Named accounts
  if (channelCfg.accounts) {
    for (const id of Object.keys(channelCfg.accounts)) {
      ids.add(id);
    }
  }

  return Array.from(ids);
}

/**
 * Resolve a specific account by ID with full defaults applied.
 * Falls back to env vars for the "default" account.
 */
export function resolveAccount(cfg: any, accountId?: string | null): ResolvedSynologyChatAccount {
  const channelCfg = getChannelConfig(cfg) ?? {};
  const id = accountId || "default";

  // Account-specific overrides (if named account exists)
  const accountOverride = channelCfg.accounts?.[id] ?? {};

  // Env var fallbacks (primarily for the "default" account)
  const envToken = process.env.SYNOLOGY_CHAT_TOKEN ?? "";
  const envIncomingUrl = process.env.SYNOLOGY_CHAT_INCOMING_URL ?? "";
  const envNasHost = process.env.SYNOLOGY_NAS_HOST ?? "localhost";
  const envAllowedUserIds = process.env.SYNOLOGY_ALLOWED_USER_IDS ?? "";
  const envRateLimit = process.env.SYNOLOGY_RATE_LIMIT;
  const envBotName = process.env.OPENCLAW_BOT_NAME ?? "OpenClaw";

  // Merge: account override > base channel config > env var
  return {
    accountId: id,
    enabled: accountOverride.enabled ?? channelCfg.enabled ?? true,
    token: accountOverride.token ?? channelCfg.token ?? envToken,
    incomingUrl: accountOverride.incomingUrl ?? channelCfg.incomingUrl ?? envIncomingUrl,
    nasHost: accountOverride.nasHost ?? channelCfg.nasHost ?? envNasHost,
    webhookPath: accountOverride.webhookPath ?? channelCfg.webhookPath ?? "/webhook/synology",
    dmPolicy: accountOverride.dmPolicy ?? channelCfg.dmPolicy ?? "allowlist",
    allowedUserIds: parseAllowedUserIds(
      accountOverride.allowedUserIds ?? channelCfg.allowedUserIds ?? envAllowedUserIds,
    ),
    rateLimitPerMinute:
      accountOverride.rateLimitPerMinute ??
      channelCfg.rateLimitPerMinute ??
      (envRateLimit ? parseInt(envRateLimit, 10) || 30 : 30),
    botName: accountOverride.botName ?? channelCfg.botName ?? envBotName,
    allowInsecureSsl: accountOverride.allowInsecureSsl ?? channelCfg.allowInsecureSsl ?? false,
  };
}
