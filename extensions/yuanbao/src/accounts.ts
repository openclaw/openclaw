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
// const DEFAULT_API_DOMAIN = "bot-test.yuanbao.tencent.com";
// const DEFAULT_WS_GATEWAY_URL = "wss://bot-wss-test.yuanbao.tencent.com/wss/connection";

// Use SDK official API to generate account list and default account resolution functions
const { listAccountIds, resolveDefaultAccountId } = createAccountListHelpers("yuanbao");

/**
 * Get all Yuanbao account IDs from configuration
 * @param cfg - OpenClaw global configuration
 * @returns Array of account IDs; returns default account if none configured
 */
export function listYuanbaoAccountIds(cfg: OpenClawConfig): string[] {
  return listAccountIds(cfg);
}

/**
 * Resolve default Yuanbao account ID
 * @param cfg - OpenClaw global configuration
 * @returns Default account ID; prefers the configured defaultAccount
 */
export function resolveDefaultYuanbaoAccountId(cfg: OpenClawConfig): string {
  return resolveDefaultAccountId(cfg);
}

/** Resolve overflow policy config value */
function resolveOverflowPolicy(raw: string | undefined): YuanbaoOverflowPolicy {
  return raw === "stop" ? "stop" : "split";
}

/** Resolve reply-to mode config value */
function resolveReplyToMode(raw: string | undefined): YuanbaoReplyToMode {
  if (raw === "off" || raw === "all") {
    return raw;
  }
  return "first";
}

/** Log warning for incomplete configuration */
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

/**
 * Parse and return the complete account configuration object
 *
 * Core logic: merge top-level + sub-account config → extract fields and set defaults → determine configured status
 * configured condition: appKey + appSecret both present
 *
 * @param params - Contains global config and optional account ID
 * @returns Complete account configuration object with all required fields and defaults
 */
export function resolveYuanbaoAccount(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): ResolvedYuanbaoAccount {
  const accountId = normalizeAccountId(params.accountId);
  const yuanbaoConfig = params.cfg.channels?.yuanbao as YuanbaoConfig | undefined;
  const baseEnabled = yuanbaoConfig?.enabled !== false;

  // Use SDK official API to merge top-level + sub-account config
  const merged = resolveMergedAccountConfig<YuanbaoAccountConfig>({
    channelConfig: yuanbaoConfig as YuanbaoAccountConfig | undefined,
    accounts: yuanbaoConfig?.accounts as Record<string, Partial<YuanbaoAccountConfig>> | undefined,
    accountId,
    omitKeys: ["defaultAccount"],
  });

  const enabled = baseEnabled && merged.enabled !== false;

  // Extract fields from merged config
  let appKey = merged.appKey?.trim() || undefined;
  let appSecret = merged.appSecret?.trim() || undefined;
  const apiDomain = merged.apiDomain?.trim() || DEFAULT_API_DOMAIN;
  let token = merged.token?.trim() || undefined;
  const overflowPolicy = resolveOverflowPolicy(merged.overflowPolicy);
  const replyToMode = resolveReplyToMode(merged.replyToMode);

  // Compatibility: if appKey/appSecret missing but token is in "appKey:appSecret" format, auto-parse
  // After parsing, token must be cleared; otherwise gateway.ts will use "appKey:appSecret" as a pre-signed WS token for auth, causing disconnection
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

  // WebSocket configuration
  const wsGatewayUrl = merged.wsUrl?.trim() || DEFAULT_WS_GATEWAY_URL;
  const wsHeartbeatInterval: number | undefined = undefined;
  const wsMaxReconnectAttempts = 100;

  // Media configuration
  const mediaMaxMb = merged.mediaMaxMb && merged.mediaMaxMb >= 1 ? merged.mediaMaxMb : 20;

  // Group chat history context entries (default 100)
  const historyLimit =
    merged.historyLimit !== undefined && merged.historyLimit >= 0 ? merged.historyLimit : 100;

  // Whether to disable block streaming output (default false)
  const disableBlockStreaming =
    merged.disableBlockStreaming !== undefined ? merged.disableBlockStreaming : false;
  // Whether group chat requires @mention to reply (default true)
  const requireMention = merged.requireMention !== undefined ? merged.requireMention : true;
  // Fallback reply text (used when AI returns no reply)
  const fallbackReply = merged.fallbackReply?.trim() || "暂时无法解答，你可以换个问题问问我哦";
  // Whether to inject Markdown anti-wrapping instructions (default true)
  const markdownHintEnabled = merged.markdownHintEnabled !== false;

  // Configuration is complete when appKey + appSecret are both present
  const configured = Boolean(appKey && appSecret);

  // Log warning when configuration is incomplete
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
    // ⚠️ The token field is only included in the return object when it has a value!
    // The framework's status-all/channels.ts uses `"token" in rec` to check if a channel is token-based;
    // if this field exists (even with undefined value), the framework considers the channel as requiring a token,
    // then checks if rec.token is a non-empty string; empty value marks it as "no token" + SETUP.
    // Yuanbao channel uses appKey+appSecret ticket-signing auth, not a traditional token channel,
    // so this field is only exposed when the user explicitly configured a pre-signed token.
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

/**
 * Get all enabled Yuanbao account list
 * @param cfg - OpenClaw global configuration
 * @returns Array of enabled account configurations
 */
export function listEnabledYuanbaoAccounts(cfg: OpenClawConfig): ResolvedYuanbaoAccount[] {
  return listYuanbaoAccountIds(cfg)
    .map((accountId) => resolveYuanbaoAccount({ cfg, accountId }))
    .filter((account) => account.enabled);
}
