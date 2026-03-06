/**
 * Account resolution: reads config from channels.magicform,
 * merges per-account overrides, falls back to environment variables.
 */

import type { MagicFormChannelConfig, ResolvedMagicFormAccount } from "./types.js";

/** Extract the channel config from the full OpenClaw config object. */
function getChannelConfig(cfg: any): MagicFormChannelConfig | undefined {
  return cfg?.channels?.magicform;
}

/** Parse allow_from from string or array to string[]. */
function parseAllowFrom(raw: string | string[] | undefined): string[] {
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

  const hasBaseToken = channelCfg.api_token || process.env.MAGICFORM_API_TOKEN;
  if (hasBaseToken) {
    ids.add("default");
  }

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
export function resolveAccount(cfg: any, accountId?: string | null): ResolvedMagicFormAccount {
  const channelCfg = getChannelConfig(cfg) ?? {};
  const id = accountId || "default";

  const accountOverride = channelCfg.accounts?.[id] ?? {};

  const envApiToken = process.env.MAGICFORM_API_TOKEN ?? "";
  const envBackendUrl = process.env.MAGICFORM_BACKEND_URL ?? "";
  const envRateLimit = process.env.MAGICFORM_RATE_LIMIT;

  return {
    accountId: id,
    enabled: accountOverride.enabled ?? channelCfg.enabled ?? true,
    backendUrl: accountOverride.backend_url ?? channelCfg.backend_url ?? envBackendUrl,
    apiToken: accountOverride.api_token ?? channelCfg.api_token ?? envApiToken,
    callbackPath: accountOverride.callback_path ?? channelCfg.callback_path ?? "/claw-agent/callback",
    webhookPath: accountOverride.webhookPath ?? channelCfg.webhookPath ?? "/webhook/magicform",
    dmPolicy: accountOverride.dmPolicy ?? channelCfg.dmPolicy ?? "open",
    allowFrom: parseAllowFrom(
      accountOverride.allow_from ?? channelCfg.allow_from,
    ),
    rateLimitPerMinute:
      accountOverride.rateLimitPerMinute ??
      channelCfg.rateLimitPerMinute ??
      (envRateLimit ? parseInt(envRateLimit, 10) || 60 : 60),
  };
}
