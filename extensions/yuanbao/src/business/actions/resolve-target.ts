/**
 * Action 目标解析模块
 *
 * 统一解析 action 投递目标，Compatible with two sources:
 * 1. channel.ts sendText/sendMedia 直传：顶层 to + text
 * 2. Agent tool call 传入：params.message / params.to / params.__sessionKey / params.__agentId + toolContext
 */

import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import { parseTarget } from "../messaging/targets.js";

// ============ 类型定义 ============

/**
 * 框架传入的 Action 参数结构
 *
 * Compatible with two sources:
 * 1. channel.ts sendText/sendMedia 直传：顶层 to + text
 * 2. Agent tool call 传入：params.message / params.to / params.__sessionKey / params.__agentId + toolContext
 */
export interface ActionParams {
  cfg: OpenClawConfig;
  to?: string;
  text?: string;
  accountId?: string | null;
  params?: {
    action?: string;
    channel?: string;
    message?: string;
    to?: string;
    target?: string;
    mediaUrl?: string;
    mediaUrls?: string[];
    sticker_id?: string;
    stickerId?: string;
    __sessionKey?: string;
    __agentId?: string;
    [key: string]: unknown;
  };
  toolContext?: {
    currentChannelId?: string;
    currentChannelProvider?: string;
    currentMessageId?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

/** resolveActionTarget 的返回值 */
export interface ResolvedTarget {
  isGroup: boolean;
  target: string;
  groupCode?: string;
  sessionKey?: string;
  agentId?: string;
}

// ============ 辅助函数 ============

/**
 * 从 toolContext.currentChannelId 中Extract群 groupCode
 *
 * 格式示例：`yuanbao:group:585003747`
 * 匹配 `yuanbao:group:` 前缀后取剩余部分作为 groupCode。
 *
 * @returns groupCode 或 undefined
 */
export function extractGroupFromChannelId(channelId?: string): string | undefined {
  if (!channelId) {
    return undefined;
  }
  const prefix = "yuanbao:group:";
  if (channelId.startsWith(prefix)) {
    return channelId.slice(prefix.length);
  }
  return undefined;
}

// ============ 核心解析 ============

/**
 * 统一解析 action 目标
 *
 * Priority:
 * 1. params.to / params.target（Agent tool call 显式指定）
 * 2. 顶层 to（channel.ts sendText/sendMedia 直传）
 * 3. toolContext.currentChannelId 回退（从当前会话上下文推断）
 */
export function resolveActionTarget(input: ActionParams): ResolvedTarget {
  const { params, toolContext } = input;

  // 从 params 或顶层取 raw target
  const rawTo = params?.to ?? params?.target ?? input.to ?? "";

  // 从 toolContext Extract发起上下文的群
  const contextGroupCode = extractGroupFromChannelId(toolContext?.currentChannelId);

  if (!rawTo && contextGroupCode) {
    return {
      isGroup: true,
      target: contextGroupCode,
      groupCode: contextGroupCode,
      sessionKey: params?.__sessionKey,
      agentId: params?.__agentId,
    };
  }

  if (!rawTo) {
    throw new Error(
      "[resolveActionTarget] 无法确定投递目标：to / params.to / toolContext.currentChannelId 均为空",
    );
  }

  // 使用 parseTarget 统一解析 user:xxx / direct:xxx / group:xxx / 纯 ID
  const { isGroup, target } = parseTarget(rawTo);

  return {
    isGroup,
    target,
    // 群聊取 parsed.target，非群聊回退到 toolContext 中的群（可能为 undefined）
    groupCode: contextGroupCode,
    sessionKey: params?.__sessionKey,
    agentId: params?.__agentId,
  };
}
