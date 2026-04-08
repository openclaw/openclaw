/**
 * Account resolution for the E-Claw channel plugin.
 *
 * Reads config from channels.eclaw, merges per-account overrides, and
 * falls back to environment variables for the default account.
 *
 * `listAccountIds` still returns `[DEFAULT_ACCOUNT_ID]` when
 * `channels.eclaw` is absent but the `ECLAW_API_KEY` env var is set,
 * so env-only setups start the default account without requiring a
 * placeholder config entry (see PR #62934 review round 2 codex P2).
 *
 * Doc references (OpenClaw repo):
 *   - docs/plugins/sdk-channel-plugins.md §"Config adapter" and
 *     §"Account resolution" — use
 *     `openclaw/plugin-sdk/account-resolution` helpers
 *     (`DEFAULT_ACCOUNT_ID`, `listCombinedAccountIds`,
 *     `resolveMergedAccountConfig`) rather than reaching into
 *     `cfg.channels[...]` by hand.
 *   - docs/plugins/architecture.md §"Plugin SDK import paths" —
 *     `account-resolution` is the stable cross-package subpath.
 */

import {
  DEFAULT_ACCOUNT_ID,
  listCombinedAccountIds,
  resolveMergedAccountConfig,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/account-resolution";
import type {
  EclawChannelConfig,
  ResolvedEclawAccount,
} from "./types.js";

const DEFAULT_API_BASE = "https://eclawbot.com";
const DEFAULT_BOT_NAME = "OpenClaw";

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

/** Extract the channel config from the full OpenClaw config object. */
function getChannelConfig(cfg: OpenClawConfig): EclawChannelConfig | undefined {
  return cfg?.channels?.eclaw as EclawChannelConfig | undefined;
}

function resolveImplicitAccountId(
  channelCfg: EclawChannelConfig,
): string | undefined {
  return channelCfg.apiKey || process.env.ECLAW_API_KEY
    ? DEFAULT_ACCOUNT_ID
    : undefined;
}

/**
 * List all configured account IDs for this channel.
 * Returns ["default"] if there's a base config, plus any named accounts.
 *
 * When `channels.eclaw` is missing entirely, still start a default account
 * from env vars (`ECLAW_API_KEY`) so env-only setups work.
 */
export function listAccountIds(cfg: OpenClawConfig): string[] {
  const channelCfg = getChannelConfig(cfg);
  if (!channelCfg) {
    return process.env.ECLAW_API_KEY ? [DEFAULT_ACCOUNT_ID] : [];
  }

  return listCombinedAccountIds({
    configuredAccountIds: Object.keys(channelCfg.accounts ?? {}),
    implicitAccountId: resolveImplicitAccountId(channelCfg),
  });
}

/**
 * Resolve a specific account by ID with full defaults applied.
 * Falls back to environment variables for the "default" account only.
 * Named accounts must have their credentials set explicitly in config;
 * env fallback is intentionally restricted to avoid silently wiring a
 * named account to the wrong API key (callback collision risk in
 * multi-account setups — see PR #62934 round 12 codex P2).
 */
export function resolveAccount(
  cfg: OpenClawConfig,
  accountId?: string | null,
): ResolvedEclawAccount {
  const channelCfg = getChannelConfig(cfg) ?? {};
  const id = accountId || DEFAULT_ACCOUNT_ID;
  const merged = resolveMergedAccountConfig<
    Record<string, unknown> & EclawChannelConfig
  >({
    channelConfig: channelCfg as Record<string, unknown> & EclawChannelConfig,
    accounts: channelCfg.accounts as
      | Record<string, Partial<Record<string, unknown> & EclawChannelConfig>>
      | undefined,
    accountId: id,
  });

  // Gate env fallback to the default account only.
  // Named accounts get explicit config values or built-in defaults.
  const isDefault = id === DEFAULT_ACCOUNT_ID;
  const envApiKey = isDefault ? (process.env.ECLAW_API_KEY ?? "") : "";
  const envApiBase = isDefault
    ? (process.env.ECLAW_API_BASE ?? DEFAULT_API_BASE)
    : DEFAULT_API_BASE;
  const envBotName = isDefault ? (process.env.ECLAW_BOT_NAME ?? DEFAULT_BOT_NAME) : DEFAULT_BOT_NAME;
  const envWebhookUrl = isDefault ? (process.env.ECLAW_WEBHOOK_URL ?? "") : "";

  return {
    accountId: id,
    enabled: merged.enabled ?? true,
    apiKey: (merged.apiKey ?? envApiKey) || "",
    apiBase: stripTrailingSlash(merged.apiBase ?? envApiBase),
    botName: merged.botName ?? envBotName,
    webhookUrl: stripTrailingSlash(merged.webhookUrl ?? envWebhookUrl),
  };
}
