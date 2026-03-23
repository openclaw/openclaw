/**
 * Account resolution: reads config from channels.synology-chat,
 * merges per-account overrides, falls back to environment variables.
 */

import {
  DEFAULT_ACCOUNT_ID,
  listCombinedAccountIds,
  resolveMergedAccountConfig,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/account-resolution";
import { resolveDangerousNameMatchingEnabled } from "openclaw/plugin-sdk/config-runtime";
import type { SynologyChatChannelConfig, ResolvedSynologyChatAccount } from "./types.js";

/** Extract the channel config from the full OpenClaw config object. */
function getChannelConfig(cfg: OpenClawConfig): SynologyChatChannelConfig | undefined {
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

function parseRateLimitPerMinute(raw: string | undefined): number {
  if (raw == null) {
    return 30;
  }
  const trimmed = raw.trim();
  if (!/^-?\d+$/.test(trimmed)) {
    return 30;
  }
  return Number.parseInt(trimmed, 10);
}

/**
 * List all configured account IDs for this channel.
 * Returns ["default"] if there's a base config, plus any named accounts.
 */
export function listAccountIds(cfg: OpenClawConfig): string[] {
  const channelCfg = getChannelConfig(cfg);
  if (!channelCfg) {
    return [];
  }

  // If base config has a token, there's a "default" account
  const hasBaseToken = channelCfg.token || process.env.SYNOLOGY_CHAT_TOKEN;
  return listCombinedAccountIds({
    configuredAccountIds: Object.keys(channelCfg.accounts ?? {}),
    implicitAccountId: hasBaseToken ? DEFAULT_ACCOUNT_ID : undefined,
  });
}

/**
 * Resolve a specific account by ID with full defaults applied.
 * Falls back to env vars for the "default" account.
 */
export function resolveAccount(
  cfg: OpenClawConfig,
  accountId?: string | null,
): ResolvedSynologyChatAccount {
  const channelCfg = getChannelConfig(cfg) ?? {};
  const id = accountId || DEFAULT_ACCOUNT_ID;
  const accountOverrides =
    id === DEFAULT_ACCOUNT_ID ? undefined : (channelCfg.accounts?.[id] ?? undefined);
  const merged = resolveMergedAccountConfig<Record<string, unknown> & SynologyChatChannelConfig>({
    channelConfig: channelCfg as Record<string, unknown> & SynologyChatChannelConfig,
    accounts: channelCfg.accounts as
      | Record<string, Partial<Record<string, unknown> & SynologyChatChannelConfig>>
      | undefined,
    accountId: id,
  });

  // Env var fallbacks (primarily for the "default" account)
  const envToken = process.env.SYNOLOGY_CHAT_TOKEN ?? "";
  const envIncomingUrl = process.env.SYNOLOGY_CHAT_INCOMING_URL ?? "";
  const envNasHost = process.env.SYNOLOGY_NAS_HOST ?? "localhost";
  const envAllowedUserIds = process.env.SYNOLOGY_ALLOWED_USER_IDS ?? "";
  const envRateLimitValue = parseRateLimitPerMinute(process.env.SYNOLOGY_RATE_LIMIT);
  const envBotName = process.env.OPENCLAW_BOT_NAME ?? "OpenClaw";

  // Merge: account override > base channel config > env var
  return {
    accountId: id,
    enabled: merged.enabled ?? true,
    token: merged.token ?? envToken,
    incomingUrl: merged.incomingUrl ?? envIncomingUrl,
    nasHost: merged.nasHost ?? envNasHost,
    webhookPath: merged.webhookPath ?? "/webhook/synology",
    dangerouslyAllowNameMatching: resolveDangerousNameMatchingEnabled({
      providerConfig: channelCfg,
      accountConfig: accountOverrides,
    }),
    dmPolicy: merged.dmPolicy ?? "allowlist",
    allowedUserIds: parseAllowedUserIds(merged.allowedUserIds ?? envAllowedUserIds),
    rateLimitPerMinute: merged.rateLimitPerMinute ?? envRateLimitValue,
    botName: merged.botName ?? envBotName,
    allowInsecureSsl: merged.allowInsecureSsl ?? false,
  };
}
