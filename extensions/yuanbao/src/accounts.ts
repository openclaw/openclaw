import {
  createAccountListHelpers,
  resolveMergedAccountConfig,
} from "openclaw/plugin-sdk/account-helpers";
import { normalizeAccountId } from "openclaw/plugin-sdk/account-id";
import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import { getCachedBotId } from "./access/http/request.js";
import { createLog } from "./logger.js";
import type {
  ResolvedYuanbaoAccount,
  YuanbaoAccountConfig,
  YuanbaoOverflowPolicy,
  YuanbaoReplyToMode,
  YuanbaoConfig,
} from "./types.js";

const DEFAULT_API_DOMAIN = "bot.yuanbao.tencent.com";
const DEFAULT_WS_GATEWAY_URL = "wss://bot-wss.yuanbao.tencent.com/wss/connection";

const { listAccountIds, resolveDefaultAccountId } = createAccountListHelpers("yuanbao");

export function listYuanbaoAccountIds(cfg: OpenClawConfig): string[] {
  return listAccountIds(cfg);
}

export function resolveDefaultYuanbaoAccountId(cfg: OpenClawConfig): string {
  return resolveDefaultAccountId(cfg);
}

function resolveOverflowPolicy(raw: string | undefined): YuanbaoOverflowPolicy {
  return raw === "stop" ? "stop" : "split";
}

function resolveReplyToMode(raw: string | undefined): YuanbaoReplyToMode {
  if (raw === "off" || raw === "all") {
    return raw;
  }
  return "first";
}

function warnIncompleteConfig(appKey: string | undefined, appSecret: string | undefined): void {
  const missing: string[] = [];
  if (!appKey) {
    missing.push("appKey");
  }
  if (!appSecret) {
    missing.push("appSecret");
  }
  if (missing.length > 0) {
    createLog("accounts").warn("incomplete config", { missing: missing.join(", ") });
  }
}

export function resolveYuanbaoAccount(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): ResolvedYuanbaoAccount {
  const accountId = normalizeAccountId(params.accountId);
  const yuanbaoConfig = params.cfg.channels?.yuanbao as YuanbaoConfig | undefined;
  const baseEnabled = yuanbaoConfig?.enabled !== false;

  const merged = resolveMergedAccountConfig<YuanbaoAccountConfig>({
    channelConfig: yuanbaoConfig as YuanbaoAccountConfig | undefined,
    accounts: yuanbaoConfig?.accounts as Record<string, Partial<YuanbaoAccountConfig>> | undefined,
    accountId,
    omitKeys: ["defaultAccount"],
  });

  const enabled = baseEnabled && merged.enabled !== false;

  let appKey = merged.appKey?.trim() || undefined;
  let appSecret = merged.appSecret?.trim() || undefined;
  const apiDomain = merged.apiDomain?.trim() || DEFAULT_API_DOMAIN;
  let token = merged.token?.trim() || undefined;
  const overflowPolicy = resolveOverflowPolicy(merged.overflowPolicy);
  const replyToMode = resolveReplyToMode(merged.replyToMode);

  if ((!appKey || !appSecret) && token) {
    const colonIdx = token.indexOf(":");
    if (colonIdx > 0) {
      const parsedKey = token.slice(0, colonIdx).trim();
      const parsedSecret = token.slice(colonIdx + 1).trim();
      if (parsedKey && parsedSecret) {
        if (!appKey) {
          appKey = parsedKey;
        }
        if (!appSecret) {
          appSecret = parsedSecret;
        }
        token = undefined; // Parsed into appKey/appSecret; clear token to avoid being used as pre-signed WS token
      }
    }
  }

  const wsGatewayUrl = merged.wsUrl?.trim() || DEFAULT_WS_GATEWAY_URL;
  const wsHeartbeatInterval: number | undefined = undefined;
  const wsMaxReconnectAttempts = 100;
  const mediaMaxMb = merged.mediaMaxMb && merged.mediaMaxMb >= 1 ? merged.mediaMaxMb : 20;
  const historyLimit =
    merged.historyLimit !== undefined && merged.historyLimit >= 0 ? merged.historyLimit : 100;
  const disableBlockStreaming =
    merged.disableBlockStreaming !== undefined ? merged.disableBlockStreaming : false;
  const requireMention = merged.requireMention !== undefined ? merged.requireMention : true;
  const fallbackReply = merged.fallbackReply?.trim() || "暂时无法解答，你可以换个问题问问我哦";
  const markdownHintEnabled = merged.markdownHintEnabled !== false;
  const configured = Boolean(appKey && appSecret);

  if (!configured && Boolean(yuanbaoConfig)) {
    warnIncompleteConfig(appKey, appSecret);
  }

  return {
    accountId,
    name: merged.name?.trim() || undefined,
    enabled,
    configured,
    appKey,
    appSecret,
    botId: getCachedBotId(accountId) || undefined,
    apiDomain,
    ...(token ? { token } : {}),
    wsGatewayUrl,
    wsHeartbeatInterval,
    wsMaxReconnectAttempts,
    overflowPolicy,
    replyToMode,
    mediaMaxMb,
    historyLimit,
    disableBlockStreaming,
    requireMention,
    fallbackReply,
    markdownHintEnabled,
    config: merged,
  };
}

export function listEnabledYuanbaoAccounts(cfg: OpenClawConfig): ResolvedYuanbaoAccount[] {
  return listYuanbaoAccountIds(cfg)
    .map((accountId) => resolveYuanbaoAccount({ cfg, accountId }))
    .filter((account) => account.enabled);
}
