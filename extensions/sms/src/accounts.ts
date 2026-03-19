/**
 * Account resolution: reads config from channels.sms,
 * merges per-account overrides.
 *
 * Note: Quo API credentials live on the hub. The instance plugin
 * does not need apiKey/phoneNumberId/fromNumber.
 */

import type { SmsChannelConfig, ResolvedSmsAccount } from "./types.js";

/** Extract the channel config from the full OpenClaw config object. */
function getChannelConfig(cfg: any): SmsChannelConfig | undefined {
  return cfg?.channels?.sms;
}

/** Parse allowedPhones from string or array to string[]. */
function parseAllowedPhones(raw: string | string[] | undefined): string[] {
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

  // Always have a default account if channel config exists
  ids.add("default");

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
 */
export function resolveAccount(cfg: any, accountId?: string | null): ResolvedSmsAccount {
  const channelCfg = getChannelConfig(cfg) ?? {};
  const id = accountId || "default";

  // Account-specific overrides (if named account exists)
  const accountOverride = channelCfg.accounts?.[id] ?? {};

  return {
    accountId: id,
    enabled: accountOverride.enabled ?? channelCfg.enabled ?? true,
    webhookPath: accountOverride.webhookPath ?? channelCfg.webhookPath ?? "/sms/events",
    dmPolicy: accountOverride.dmPolicy ?? channelCfg.dmPolicy ?? "open",
    allowedPhones: parseAllowedPhones(
      accountOverride.allowedPhones ?? channelCfg.allowedPhones,
    ),
  };
}
