/**
 * 企业微信群组访问控制模块
 *
 * 负责群组策略检查（groupPolicy、群组白名单、群内发送者白名单）
 */

import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { CHANNEL_ID } from "./const.js";
import type { ResolvedWeComAccount, WeComConfig, WeComGroupConfig } from "./utils.js";

// ============================================================================
// 检查结果类型
// ============================================================================

/**
 * 群组策略检查结果
 */
export interface GroupPolicyCheckResult {
  /** 是否允许继续处理消息 */
  allowed: boolean;
}

// ============================================================================
// 内部辅助函数
// ============================================================================

/**
 * 解析企业微信群组配置
 */
function resolveWeComGroupConfig(params: {
  cfg?: WeComConfig;
  groupId?: string | null;
}): WeComGroupConfig | undefined {
  const groups = params.cfg?.groups ?? {};
  const wildcard = groups["*"];
  const groupId = params.groupId?.trim();
  if (!groupId) {
    return undefined;
  }

  const direct = groups[groupId];
  if (direct) {
    return direct;
  }

  const lowered = groupId.toLowerCase();
  const matchKey = Object.keys(groups).find((key) => key.toLowerCase() === lowered);
  if (matchKey) {
    return groups[matchKey];
  }
  return wildcard;
}

/**
 * 检查群组是否在允许列表中
 */
function isWeComGroupAllowed(params: {
  groupPolicy: "open" | "allowlist" | "disabled";
  allowFrom: Array<string | number>;
  groupId: string;
}): boolean {
  const { groupPolicy } = params;
  if (groupPolicy === "disabled") {
    return false;
  }
  if (groupPolicy === "open") {
    return true;
  }
  // allowlist 模式：检查群组是否在允许列表中
  const normalizedAllowFrom = params.allowFrom.map((entry) =>
    String(entry).replace(new RegExp(`^${CHANNEL_ID}:`, "i"), "").trim()
  );
  if (normalizedAllowFrom.includes("*")) {
    return true;
  }
  const normalizedGroupId = params.groupId.trim();
  return normalizedAllowFrom.some(
    (entry) => entry === normalizedGroupId || entry.toLowerCase() === normalizedGroupId.toLowerCase()
  );
}

/**
 * 检查群组内发送者是否在允许列表中
 */
function isGroupSenderAllowed(params: {
  senderId: string;
  groupId: string;
  wecomConfig: WeComConfig;
}): boolean {
  const { senderId, groupId, wecomConfig } = params;

  const groupConfig = resolveWeComGroupConfig({
    cfg: wecomConfig,
    groupId,
  });

  const perGroupSenderAllowFrom = (groupConfig?.allowFrom ?? []).map((v) => String(v));

  if (perGroupSenderAllowFrom.length === 0) {
    return true;
  }

  if (perGroupSenderAllowFrom.includes("*")) {
    return true;
  }

  return perGroupSenderAllowFrom.some((entry) => {
    const normalized = entry.replace(new RegExp(`^${CHANNEL_ID}:`, "i"), "").trim();
    return normalized === senderId || normalized === `user:${senderId}`;
  });
}

// ============================================================================
// 公开 API
// ============================================================================

/**
 * 检查群组策略访问控制
 * @returns 检查结果，包含是否允许继续处理
 */
export function checkGroupPolicy(params: {
  chatId: string;
  senderId: string;
  account: ResolvedWeComAccount;
  config: OpenClawConfig;
  runtime: RuntimeEnv;
}): GroupPolicyCheckResult {
  const { chatId, senderId, account, runtime } = params;
  // 使用 account.config（已经过多账号合并），而非顶层 config.channels.wecom
  // 避免多账户模式下 groupAllowFrom / groups 等字段取不到账号级配置
  const wecomConfig = account.config;

  const groupPolicy = wecomConfig.groupPolicy ?? "open"

  const groupAllowFrom = wecomConfig.groupAllowFrom ?? [];
  const groupAllowed = isWeComGroupAllowed({
    groupPolicy,
    allowFrom: groupAllowFrom,
    groupId: chatId,
  });

  if (!groupAllowed) {
    runtime.log?.(
      `[WeCom] Group ${chatId} not allowed (groupPolicy=${groupPolicy})`,
    );
    return { allowed: false };
  }

  const senderAllowed = isGroupSenderAllowed({
    senderId,
    groupId: chatId,
    wecomConfig,
  });

  if (!senderAllowed) {
    runtime.log?.(
      `[WeCom] Sender ${senderId} not in group ${chatId} sender allowlist`,
    );
    return { allowed: false };
  }

  return { allowed: true };
}

/**
 * 检查发送者是否在允许列表中（通用）
 */
export function isSenderAllowed(senderId: string, allowFrom: string[]): boolean {
  if (allowFrom.includes("*")) {
    return true;
  }
  return allowFrom.some((entry) => {
    const normalized = entry.replace(new RegExp(`^${CHANNEL_ID}:`, "i"), "").trim();
    return normalized === senderId || normalized === `user:${senderId}`;
  });
}
