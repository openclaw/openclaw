/**
 * 企业微信公共工具函数
 */

import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import { DEFAULT_ACCOUNT_ID } from "./openclaw-compat.js";
import { CHANNEL_ID } from "./const.js";
import type { ResolvedAgentAccount } from "./types/account.js";
import type { WecomAgentConfig, WecomNetworkConfig, WecomMediaConfig, WecomDynamicAgentsConfig } from "./types/config.js";

// ============================================================================
// 配置类型定义
// ============================================================================

/**
 * 企业微信群组配置
 */
export interface WeComGroupConfig {
  /** 群组内发送者白名单（仅列表中的成员消息会被处理） */
  allowFrom?: Array<string | number>;
}

/**
 * 企业微信配置类型
 */
export interface WeComConfig {
  enabled?: boolean;
  websocketUrl?: string;
  botId?: string;
  secret?: string;
  name?: string;
  allowFrom?: Array<string | number>;
  dmPolicy?: "open" | "allowlist" | "pairing" | "disabled";
  /** 群组访问策略："open" = 允许所有群组（默认），"allowlist" = 仅允许 groupAllowFrom 中的群组，"disabled" = 禁用群组消息 */
  groupPolicy?: "open" | "allowlist" | "disabled";
  /** 群组白名单（仅 groupPolicy="allowlist" 时生效） */
  groupAllowFrom?: Array<string | number>;
  /** 每个群组的详细配置（如群组内发送者白名单） */
  groups?: Record<string, WeComGroupConfig>;
  /** 是否发送"思考中"消息，默认为 true */
  sendThinkingMessage?: boolean;
  /** 额外允许访问的本地媒体路径白名单（支持 ~ 表示 home 目录），如 ["~/Downloads", "~/Documents"] */
  mediaLocalRoots?: string[];
  /** Agent 模式配置（自建应用） */
  agent?: WecomAgentConfig;
  /** 网络配置 */
  network?: WecomNetworkConfig;
  /** 媒体处理配置 */
  media?: WecomMediaConfig;
  /** 动态 Agent 配置 */
  dynamicAgents?: WecomDynamicAgentsConfig;

  // ── Webhook 模式扩展字段 ──────────────────────────────────────────
  /** 连接模式：webhook | websocket（默认 websocket） */
  connectionMode?: "webhook" | "websocket";
  /** Webhook 验证 token */
  token?: string;
  /** AES 加密密钥（43 字符 Base64） */
  encodingAESKey?: string;
  /** 接收方 ID */
  receiveId?: string;
  /** enter_chat 欢迎消息 */
  welcomeText?: string;
  /** 流式占位符提示内容 */
  streamPlaceholderContent?: string;
}

/**
 * 单个企业微信账号的配置类型（用于 accounts 字段下的每个账号）。
 * 与 WeComConfig 字段完全一致，账号级字段会覆盖顶层同名字段。
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
  /** 是否发送"思考中"消息，默认为 true */
  sendThinkingMessage: boolean;
  config: WeComConfig;
  /** Agent 模式能力（自建应用） */
  agent?: ResolvedAgentAccount;
  /** Webhook 模式配置 */
  token?: string;
  encodingAESKey?: string;
  receiveId?: string,
}

/**
 * 解析企业微信账户配置
 */
export function resolveWeComAccount(cfg: OpenClawConfig): ResolvedWeComAccount {
  const wecomConfig = (cfg.channels?.[CHANNEL_ID] ?? {}) as WeComConfig;

  return {
    accountId: DEFAULT_ACCOUNT_ID,
    name: wecomConfig.name ?? "企业微信",
    enabled: wecomConfig.enabled !== false,
    websocketUrl: wecomConfig.websocketUrl || DefaultWsUrl,
    botId: wecomConfig.botId ?? "",
    secret: wecomConfig.secret ?? "",
    sendThinkingMessage: wecomConfig.sendThinkingMessage ?? true,
    config: wecomConfig,
  };
}

/**
 * 设置企业微信账户配置
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
    // 以下字段仅在已有配置值或显式传入时才写入，onboarding 时不主动生成
    ...(account.websocketUrl || existing?.websocketUrl
      ? { websocketUrl: account.websocketUrl ?? existing?.websocketUrl }
      : {}),
    ...(account.name || existing?.name
      ? { name: account.name ?? existing?.name }
      : {}),
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
 * 解析出口代理 URL（对齐原版 resolveWecomEgressProxyUrl）
 *
 * 优先级：
 * 1. config.channels.wecom.network.egressProxyUrl
 * 2. 环境变量：OPENCLAW_WECOM_EGRESS_PROXY_URL → WECOM_EGRESS_PROXY_URL → HTTPS_PROXY → ALL_PROXY → HTTP_PROXY
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
