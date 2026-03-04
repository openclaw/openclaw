/**
 * Account resolution for WeChat MP (微信公众号).
 */

import type {
  ResolvedWeChatMPAccount,
  WeChatMPChannelConfig,
  WeChatMPAccountRaw,
  WeChatMPDmPolicy,
} from "./types.js";

const CHANNEL_ID = "wechat-mp";

function getChannelConfig(cfg: unknown): WeChatMPChannelConfig | undefined {
  const c = cfg as { channels?: Record<string, unknown> };
  return c?.channels?.[CHANNEL_ID] as WeChatMPChannelConfig | undefined;
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
    channelCfg.appSecret ||
    channelCfg.token ||
    process.env.WECHAT_MP_APP_ID ||
    process.env.WECHAT_MP_APP_SECRET;
  if (hasBase) ids.add("default");
  if (channelCfg.accounts && typeof channelCfg.accounts === "object") {
    for (const id of Object.keys(channelCfg.accounts)) {
      ids.add(id);
    }
  }
  return Array.from(ids);
}

export function resolveAccount(cfg: unknown, accountId?: string | null): ResolvedWeChatMPAccount {
  const channelCfg = getChannelConfig(cfg) ?? {};
  const id = accountId ?? "default";
  const accountOverride: WeChatMPAccountRaw =
    (channelCfg.accounts as Record<string, WeChatMPAccountRaw> | undefined)?.[id] ?? {};

  const appId =
    (accountOverride.appId ?? channelCfg.appId ?? process.env.WECHAT_MP_APP_ID)?.trim() ?? "";
  const appSecret =
    (
      accountOverride.appSecret ??
      channelCfg.appSecret ??
      process.env.WECHAT_MP_APP_SECRET
    )?.trim() ?? "";
  const token =
    (accountOverride.token ?? channelCfg.token ?? process.env.WECHAT_MP_TOKEN)?.trim() ?? "";
  const webhookPath =
    (accountOverride.webhookPath ?? channelCfg.webhookPath ?? "/webhook/wechat-mp").trim() ||
    "/webhook/wechat-mp";
  const rateLimitPerMinute =
    accountOverride.rateLimitPerMinute ?? channelCfg.rateLimitPerMinute ?? 30;
  const dmPolicy: WeChatMPDmPolicy = (accountOverride.dmPolicy ??
    channelCfg.dmPolicy ??
    "allowlist") as WeChatMPDmPolicy;
  const allowFrom = parseAllowFrom(
    accountOverride.allowFrom ??
      channelCfg.allowFrom ??
      process.env.WECHAT_MP_ALLOW_FROM?.split(",")
        .map((s) => s.trim())
        .filter(Boolean),
  );

  return {
    accountId: id,
    enabled: (accountOverride.enabled ?? channelCfg.enabled ?? true) as boolean,
    appId,
    appSecret,
    token,
    webhookPath,
    rateLimitPerMinute,
    dmPolicy,
    allowFrom,
  };
}
