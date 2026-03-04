/**
 * Account resolution for DingTalk channel.
 * Reads channels.dingtalk and accounts.*, with env fallbacks for default account.
 */

import type {
  ResolvedDingTalkAccount,
  DingTalkChannelConfig,
  DingTalkAccountRaw,
  DingTalkDmPolicy,
} from "./types.js";

const CHANNEL_ID = "dingtalk";

function getChannelConfig(cfg: unknown): DingTalkChannelConfig | undefined {
  const c = cfg as { channels?: Record<string, unknown> };
  return c?.channels?.[CHANNEL_ID] as DingTalkChannelConfig | undefined;
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
    channelCfg.appKey ||
    channelCfg.appSecret ||
    process.env.DINGTALK_APP_KEY ||
    process.env.DINGTALK_APP_SECRET;
  if (hasBase) ids.add("default");
  if (channelCfg.accounts && typeof channelCfg.accounts === "object") {
    for (const id of Object.keys(channelCfg.accounts)) {
      ids.add(id);
    }
  }
  return Array.from(ids);
}

export function resolveAccount(cfg: unknown, accountId?: string | null): ResolvedDingTalkAccount {
  const channelCfg = getChannelConfig(cfg) ?? {};
  const id = accountId ?? "default";
  const accountOverride: DingTalkAccountRaw =
    (channelCfg.accounts as Record<string, DingTalkAccountRaw> | undefined)?.[id] ?? {};

  const appKey =
    (accountOverride.appKey ?? channelCfg.appKey ?? process.env.DINGTALK_APP_KEY)?.trim() ?? "";
  const appSecret =
    (
      accountOverride.appSecret ??
      channelCfg.appSecret ??
      process.env.DINGTALK_APP_SECRET
    )?.trim() ?? "";
  const corpId =
    (accountOverride.corpId ?? channelCfg.corpId ?? process.env.DINGTALK_CORP_ID)?.trim() ?? "";
  const webhookPath =
    (accountOverride.webhookPath ?? channelCfg.webhookPath ?? "/webhook/dingtalk").trim() ||
    "/webhook/dingtalk";
  const rateLimitPerMinute =
    accountOverride.rateLimitPerMinute ?? channelCfg.rateLimitPerMinute ?? 30;
  const dmPolicy: DingTalkDmPolicy = (accountOverride.dmPolicy ??
    channelCfg.dmPolicy ??
    "allowlist") as DingTalkDmPolicy;
  const allowFrom = parseAllowFrom(
    accountOverride.allowFrom ??
      channelCfg.allowFrom ??
      process.env.DINGTALK_ALLOW_FROM?.split(",")
        .map((s) => s.trim())
        .filter(Boolean),
  );

  return {
    accountId: id,
    enabled: (accountOverride.enabled ?? channelCfg.enabled ?? true) as boolean,
    appKey,
    appSecret,
    corpId,
    webhookPath,
    rateLimitPerMinute,
    dmPolicy,
    allowFrom,
  };
}
