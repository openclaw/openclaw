/**
 * Target 解析模块
 *
 * Parse various user-input target formats into standardized send targets.
 * Also provides target string normalization, message tool hints, and other helper functions.
 */

import { resolveUsername } from "./directory.js";

// ============ ID 检测 ============

/**
 * 检查原始字符串是否看起来像平台User ID。
 *
 * 元宝平台User ID 有两种格式：
 *   1. 纯数字 ID（IM 账号格式），如 "123456789"
 *   2. 32 位以上字母数字混合 ID（Base64 编码格式），如 "xqfNihe1yIVQyNwb..."
 *
 * @param raw - 待检查的 ID 字符串
 * @returns 如果字符串看起来像平台 ID 则返回 true
 */
export function looksLikeYuanbaoId(raw: string): boolean {
  const trimmed = raw.trim();

  // UserID 格式验证（按 Base64 格式推测）

  // 长度至少24字符
  if (trimmed.length < 24) {
    return false;
  }

  // 必须同时包含大写、小写和数字
  // 仅允许 Base64 字符集 A-Z a-z 0-9 + / =
  // = 仅允许出现在末尾，且最多 2 个
  if (!/^(?=.*[A-Z])(?=.*[a-z])(?=.*\d)(?!.*=.+)[A-Za-z0-9+/]+={0,2}$/.test(trimmed)) {
    return false;
  }

  return true;
}

// ============ 类型定义 ============

export interface MessagingTarget {
  isGroup: boolean;
  target: string;
  sessionKey: string;
}

// ============ 解析函数 ============

/**
 * 将原始目标字符串解析为标准化的 MessagingTarget。
 *
 * Supported formats:
 *   "<userId>"
 *   "group:<groupId>"
 *
 * @param to - 来自 LLM tool call 的原始目标字符串
 * @returns MessagingTarget
 */
export function parseTarget(to: string, accountId = "default", groupCode = ""): MessagingTarget {
  to = to.trim().replace(/^yuanbao:/, "");

  if (to.startsWith("group:")) {
    return { isGroup: true, target: to.slice("group:".length), sessionKey: to };
  }

  to = to.replace(/^user:/, "").replace(/^direct:/, "");

  if (!looksLikeYuanbaoId(to)) {
    const { userId } = resolveUsername(to, accountId, groupCode) || { userId: to };
    return { isGroup: false, target: userId, sessionKey: `direct:${userId}` };
  }

  return { isGroup: false, target: to, sessionKey: `direct:${to}` };
}

// ============ 目标规范化 ============

/**
 * Normalize Yuanbao message target string.
 *
 * 去除 "yuanbao:" 前缀并 trim，返回清理后的目标字符串。
 * 空字符串返回 undefined。
 *
 * @param raw - 原始目标字符串
 * @returns 规范化后的目标字符串，或 undefined
 */
export function normalizeTarget(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (!trimmed) {
    return undefined;
  }
  return trimmed.replace(/^(yuanbao):/i, "").trim() || undefined;
}

// ============ 消息工具提示 ============

/**
 * 构建注入 Agent 系统提示的元宝频道消息工具说明。
 *
 * 用于约束模型在发文件/Image与表情时的行为（显式：表情=sticker=贴纸表情；media 发文件；避免 Unicode 表情字符），
 * 与同模块注册的 message actions 能力对齐。
 *
 * @returns 供 `agentPrompt.messageToolHints` 使用的提示字符串列表
 */
export function buildMessageToolHints(): string[] {
  return [
    // ── Sticker 流程（独立闭环，to 参数由下方 Target routing 统一管理） ──
    "react = sticker = 发贴纸 (NOT a message reaction). Flow: sticker-search → pick sticker_id → call sticker/react with sticker_id. No bare Unicode emoji.",
    // ── 文件/Image发送 ──
    "File/image: use media/mediaUrls with real URLs or absolute paths (e.g. /tmp/file.md). Never use relative paths.",
    // ── 私信/DM 路由（仅群聊中用户明确要求发私信时才需要 to） ──
    'DM/私信: set `to="<userId>"` only when the user explicitly asks to send a DM/私信/direct message in a group chat. ' +
      "To resolve a userId, call query_session_members first. If the recipient is ambiguous, ask for clarification.",
  ];
}
