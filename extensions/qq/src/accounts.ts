/**
 * Account resolution for QQ channel.
 */

import type { ResolvedQQAccount, QQChannelConfig, QQAccountRaw, QQDmPolicy } from "./types.js";

const CHANNEL_ID = "qq";

function getChannelConfig(cfg: unknown): QQChannelConfig | undefined {
  const c = cfg as { channels?: Record<string, unknown> };
  return c?.channels?.[CHANNEL_ID] as QQChannelConfig | undefined;
}

function parseAllowFrom(raw: string[] | number[] | undefined): string[] {
  if (!raw || !Array.isArray(raw)) return [];
  return raw.map((x) => String(x)).filter(Boolean);
}

export function listAccountIds(cfg: unknown): string[] {
  const channelCfg = getChannelConfig(cfg);
  if (!channelCfg) return [];
  const ids = new Set<string>();
  const hasBase =
    channelCfg.appId ||
    channelCfg.clientSecret ||
    process.env.QQ_APP_ID ||
    process.env.QQ_CLIENT_SECRET;
  if (hasBase) ids.add("default");
  if (channelCfg.accounts && typeof channelCfg.accounts === "object") {
    for (const id of Object.keys(channelCfg.accounts)) {
      ids.add(id);
    }
  }
  return Array.from(ids);
}

export function resolveAccount(cfg: unknown, accountId?: string | null): ResolvedQQAccount {
  const channelCfg = getChannelConfig(cfg) ?? {};
  const id = accountId ?? "default";
  const accountOverride: QQAccountRaw =
    (channelCfg.accounts as Record<string, QQAccountRaw> | undefined)?.[id] ?? {};

  const appId = (accountOverride.appId ?? channelCfg.appId ?? process.env.QQ_APP_ID)?.trim() ?? "";
  const clientSecret =
    (
      accountOverride.clientSecret ??
      channelCfg.clientSecret ??
      process.env.QQ_CLIENT_SECRET
    )?.trim() ?? "";
  const webhookPath =
    (accountOverride.webhookPath ?? channelCfg.webhookPath ?? "/webhook/qq").trim() ||
    "/webhook/qq";
  const rateLimitPerMinute =
    accountOverride.rateLimitPerMinute ?? channelCfg.rateLimitPerMinute ?? 30;
  const dmPolicy: QQDmPolicy = (accountOverride.dmPolicy ??
    channelCfg.dmPolicy ??
    "allowlist") as QQDmPolicy;
  const allowFrom = parseAllowFrom(
    accountOverride.allowFrom ??
      channelCfg.allowFrom ??
      process.env.QQ_ALLOW_FROM?.split(",")
        .map((s) => s.trim())
        .filter(Boolean),
  );

  return {
    accountId: id,
    enabled: (accountOverride.enabled ?? channelCfg.enabled ?? true) as boolean,
    appId,
    clientSecret,
    webhookPath,
    rateLimitPerMinute,
    dmPolicy,
    allowFrom,
  };
}
