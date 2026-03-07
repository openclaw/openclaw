/**
 * 企业微信公共工具函数
 */

import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk";
import type { OpenClawConfig } from "openclaw/plugin-sdk";
import { CHANNEL_ID } from "./const.ts";

// ============================================================================
// 配置类型定义
// ============================================================================

/**
 * 企业微信配置类型
 */
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
}

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
}

/**
 * 解析企业微信账户配置
 */
export function resolveWeComAccount(cfg: OpenClawConfig): ResolvedWeComAccount {
  const wecomConfig = (cfg.channels?.[CHANNEL_ID] ?? {}) as WeComConfig;

  return {
    accountId: DEFAULT_ACCOUNT_ID,
    name: wecomConfig.name ?? "企业微信",
    enabled: wecomConfig.enabled ?? false,
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
 * 生成随机字符串
 */
function generateRandomString(length: number = 9): string {
  return Math.random().toString(36).substr(2, length);
}

/**
 * 生成企业微信请求 ID
 * @param prefix - 请求类型前缀（subscribe, ping, response 等）
 * @returns 格式化的请求 ID
 */
export function generateReqId(prefix: string): string {
  const timestamp = Date.now();
  const random = generateRandomString();
  return `${prefix}_${timestamp}_${random}`;
}

/**
 * 判断 req_id 的类型
 * @param reqId - 请求 ID
 * @returns 请求类型（subscribe, ping, response 等）
 */
export function getReqIdType(reqId: string): string | null {
  const match = reqId.match(/^([^_]+)_/);
  return match ? match[1] : null;
}

/**
 * 检查 req_id 是否为指定类型
 * @param reqId - 请求 ID
 * @param type - 请求类型
 * @returns 是否匹配
 */
export function isReqIdType(reqId: string, type: string): boolean {
  return reqId.startsWith(`${type}_`);
}

/**
 * 检查 Buffer 是否是有效的图片格式
 */
function isValidImageFormat(data: Buffer): boolean {
  if (data.length < 4) return false;

  // JPEG: FF D8 FF
  if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) {
    return true;
  }

  // PNG: 89 50 4E 47
  if (data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47) {
    return true;
  }

  // GIF: 47 49 46 38
  if (data[0] === 0x47 && data[1] === 0x49 && data[2] === 0x46 && data[3] === 0x38) {
    return true;
  }

  // WebP: 52 49 46 46 ... 57 45 42 50
  if (
    data[0] === 0x52 &&
    data[1] === 0x49 &&
    data[2] === 0x46 &&
    data[3] === 0x46 &&
    data.length > 11
  ) {
    if (data[8] === 0x57 && data[9] === 0x45 && data[10] === 0x42 && data[11] === 0x50) {
      return true;
    }
  }

  // BMP: 42 4D
  if (data[0] === 0x42 && data[1] === 0x4d) {
    return true;
  }

  return false;
}
