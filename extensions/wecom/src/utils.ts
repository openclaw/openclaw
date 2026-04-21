/**
 * WeCom common utility functions
 */

import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import { type SecretInput, normalizeSecretInputString } from "openclaw/plugin-sdk/secret-input";
import { CHANNEL_ID } from "./const.js";
import { DEFAULT_ACCOUNT_ID } from "./openclaw-compat.js";
import type {
  WecomNetworkConfig,
  WecomMediaConfig,
  WecomDynamicAgentsConfig,
} from "./types/config.js";

// ============================================================================
// Configuration Type Definitions
// ============================================================================

/**
 * WeCom group configuration
 */
export interface WeComGroupConfig {
  /** Sender allowlist within the group (only messages from listed members will be processed) */
  allowFrom?: Array<string | number>;
}

/**
 * WeCom configuration type
 */
export interface WeComConfig {
  enabled?: boolean;
  websocketUrl?: string;
  botId?: string;
  /**
   * Bot secret. Accepts a plain string or a {@link SecretInput} (e.g. `{ source: "env", ... }`).
   * Consumers must go through {@link resolveWeComAccount} (or `accounts.ts::resolveWeComAccountMulti`)
   * to obtain a normalized `string` via `normalizeSecretInputString`.
   */
  secret?: SecretInput;
  name?: string;
  allowFrom?: Array<string | number>;
  dmPolicy?: "open" | "allowlist" | "pairing" | "disabled";
  /** Group access policy: "open" = allow all groups (default), "allowlist" = only allow groups in groupAllowFrom, "disabled" = disable group messages */
  groupPolicy?: "open" | "allowlist" | "disabled";
  /** Group allowlist (only effective when groupPolicy="allowlist") */
  groupAllowFrom?: Array<string | number>;
  /** Detailed configuration for each group (e.g. per-group sender allowlist) */
  groups?: Record<string, WeComGroupConfig>;
  /** Whether to send "thinking" messages, defaults to true */
  sendThinkingMessage?: boolean;
  /** Additional local media path allowlist (supports ~ for home directory), e.g. ["~/Downloads", "~/Documents"] */
  mediaLocalRoots?: string[];
  /** Network configuration */
  network?: WecomNetworkConfig;
  /** Media processing configuration */
  media?: WecomMediaConfig;
  /** Dynamic Agent configuration */
  dynamicAgents?: WecomDynamicAgentsConfig;
}

/**
 * Configuration type for a single WeCom account (used under the accounts field).
 * Fields are identical to WeComConfig; account-level fields override top-level fields with the same name.
 */
export type WeComAccountConfig = Partial<WeComConfig>;

export const DefaultWsUrl = "wss://openws.work.weixin.qq.com";

export interface ResolvedWeComAccount {
  accountId: string;
  name: string;
  enabled: boolean;
  websocketUrl: string;
  botId: string;
  secret: string;
  /** Whether to send "thinking" messages, defaults to true */
  sendThinkingMessage: boolean;
  config: WeComConfig;
}

/**
 * Resolves WeCom account configuration
 */
export function resolveWeComAccount(cfg: OpenClawConfig): ResolvedWeComAccount {
  const wecomConfig = (cfg.channels?.[CHANNEL_ID] ?? {}) as WeComConfig;

  return {
    accountId: DEFAULT_ACCOUNT_ID,
    name: wecomConfig.name ?? "企业微信",
    enabled: wecomConfig.enabled !== false,
    websocketUrl: wecomConfig.websocketUrl || DefaultWsUrl,
    botId: wecomConfig.botId ?? "",
    // Normalize SecretInput → string; unresolved SecretRef becomes "" (treated as "not available").
    secret: normalizeSecretInputString(wecomConfig.secret) ?? "",
    sendThinkingMessage: wecomConfig.sendThinkingMessage ?? true,
    config: wecomConfig,
  };
}

/**
 * Sets WeCom account configuration
 */
export function setWeComAccount(
  cfg: OpenClawConfig,
  account: Partial<WeComConfig>,
): OpenClawConfig {
  const existing = (cfg.channels?.[CHANNEL_ID] ?? {}) as WeComConfig;
  const merged: WeComConfig = {
    enabled: account.enabled ?? existing?.enabled ?? true,
    botId: account.botId ?? existing?.botId ?? "",
    secret: account.secret ?? existing?.secret ?? "",
    allowFrom: account.allowFrom ?? existing?.allowFrom,
    dmPolicy: account.dmPolicy ?? existing?.dmPolicy,
    // The following fields are only written when an existing config value exists or is explicitly provided;
    // they are not proactively generated during onboarding
    ...(account.websocketUrl || existing?.websocketUrl
      ? { websocketUrl: account.websocketUrl ?? existing?.websocketUrl }
      : {}),
    ...(account.name || existing?.name ? { name: account.name ?? existing?.name } : {}),
    ...(account.sendThinkingMessage !== undefined || existing?.sendThinkingMessage !== undefined
      ? { sendThinkingMessage: account.sendThinkingMessage ?? existing?.sendThinkingMessage }
      : {}),
  };

  return {
    ...cfg,
    channels: {
      ...cfg.channels,
      [CHANNEL_ID]: merged,
    },
  };
}

/**
 * Resolves the egress proxy URL (aligned with the original resolveWecomEgressProxyUrl)
 *
 * Priority:
 * 1. config.channels.wecom.network.egressProxyUrl
 * 2. Environment variables: OPENCLAW_WECOM_EGRESS_PROXY_URL -> WECOM_EGRESS_PROXY_URL -> HTTPS_PROXY -> ALL_PROXY -> HTTP_PROXY
 */
export function resolveWecomEgressProxyUrl(cfg: OpenClawConfig): string | undefined {
  const wecom = (cfg.channels?.[CHANNEL_ID] ?? {}) as WeComConfig;
  const proxyUrl =
    wecom.network?.egressProxyUrl ??
    process.env.OPENCLAW_WECOM_EGRESS_PROXY_URL ??
    process.env.WECOM_EGRESS_PROXY_URL ??
    process.env.HTTPS_PROXY ??
    process.env.ALL_PROXY ??
    process.env.HTTP_PROXY ??
    "";
  return proxyUrl.trim() || undefined;
}
