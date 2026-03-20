/**
 * Account resolution: reads config from channels.whatsapp-business,
 * merges per-account overrides.
 *
 * Note: Meta API credentials live on the hub. The instance plugin
 * does not need accessToken/phoneNumberId.
 */

import type { WhatsAppBusinessChannelConfig, ResolvedWhatsAppBusinessAccount } from "./types.js";

/** Extract the channel config from the full OpenClaw config object. */
function getChannelConfig(cfg: any): WhatsAppBusinessChannelConfig | undefined {
  return cfg?.channels?.["whatsapp-business"];
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
  ids.add("default");

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
export function resolveAccount(cfg: any, accountId?: string | null): ResolvedWhatsAppBusinessAccount {
  const channelCfg = getChannelConfig(cfg) ?? {};
  const id = accountId || "default";

  const accountOverride = channelCfg.accounts?.[id] ?? {};

  return {
    accountId: id,
    enabled: accountOverride.enabled ?? channelCfg.enabled ?? true,
    webhookPath: accountOverride.webhookPath ?? channelCfg.webhookPath ?? "/whatsapp-business/events",
    dmPolicy: accountOverride.dmPolicy ?? channelCfg.dmPolicy ?? "open",
    allowedPhones: parseAllowedPhones(
      accountOverride.allowedPhones ?? channelCfg.allowedPhones,
    ),
  };
}
