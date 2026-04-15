/**
 * 入站处理 — 平台特定的 mention Extract
 *
 * 从消息实体中Extract @mentioned 用户（非机器人）。
 * 机器人 mention 检测由框架的 matchesMentionPatterns() API 处理；
 * 本模块仅负责Extract目标用户的 mention（如 @张三）。
 */

import type { YuanbaoMsgBodyElement } from "../../types.js";

// ============ 类型定义 ============

/** 消息中被提及的用户信息（非机器人） */
export interface MentionedUser {
  /** 原始文本形式（如 "@张三"） */
  raw: string;
  /** 平台User ID（如果可从消息实体中Extract） */
  platformId?: string;
  /** 展示名称 */
  displayName?: string;
}

/** 用于过滤机器人 mention 的机器人标识 */
export interface BotIdentifiers {
  botId?: string;
  botUsername?: string;
}

// ============ Extract逻辑 ============

/**
 * 从元宝Message body中Extract目标用户的 mention（非机器人）。
 *
 * 元宝使用 TIMCustomElem + elem_type=1002 表示 @ mention。
 * 本函数解析这些元素并返回被提及的用户，排除机器人自身的 mention。
 *
 * @param msgBody - Message body元素数组
 * @param botIdentifiers - 机器人自身的标识（用于排除）
 * @returns 被提及的用户数组（排除机器人）
 */
export function extractTargetMentions(
  msgBody: YuanbaoMsgBodyElement[] | undefined,
  botIdentifiers: BotIdentifiers,
): MentionedUser[] {
  if (!msgBody || !Array.isArray(msgBody)) {
    return [];
  }

  const mentionedUsers: MentionedUser[] = [];

  for (const elem of msgBody) {
    if (elem.msg_type !== "TIMCustomElem") {
      continue;
    }

    const rawData = elem.msg_content?.data;
    if (!rawData || typeof rawData !== "string") {
      continue;
    }

    try {
      const customContent = JSON.parse(rawData);
      if (customContent?.elem_type !== 1002) {
        continue;
      }

      const userId: string | undefined = customContent.user_id;
      const { text } = customContent;

      // 跳过机器人自身的 mention
      if (userId && botIdentifiers.botId && userId === botIdentifiers.botId) {
        continue;
      }

      if (userId || text) {
        mentionedUsers.push({
          raw: text ?? `@${userId}`,
          platformId: userId,
          displayName: text?.replace(/^@/, "") ?? userId,
        });
      }
    } catch {
      // 忽略格式错误的 JSON
    }
  }

  return mentionedUsers;
}

/**
 * 使用正则兜底从原始文本中Extract目标用户的 mention。
 *
 * Used when the message entity is unavailable or incomplete.
 *
 * @param messageText - 原始消息文本
 * @param botIdentifiers - 机器人自身的标识（用于排除）
 * @returns 被提及的用户数组（排除机器人）
 */
export function extractTargetMentionsFromText(
  messageText: string,
  botIdentifiers: BotIdentifiers,
): MentionedUser[] {
  const mentionedUsers: MentionedUser[] = [];
  const mentionRegex = /@(\S+)/g;
  let match;

  while ((match = mentionRegex.exec(messageText)) !== null) {
    const handle = match[1];

    // 跳过机器人 mention
    if (
      botIdentifiers.botUsername &&
      handle.toLowerCase() === botIdentifiers.botUsername.toLowerCase()
    ) {
      continue;
    }
    if (botIdentifiers.botId && handle === botIdentifiers.botId) {
      continue;
    }

    mentionedUsers.push({
      raw: match[0],
      displayName: handle,
    });
  }

  return mentionedUsers;
}

/**
 * 检测隐式 mention（在群聊中回复机器人消息）。
 *
 * In Yuanbao, if a user replies to the bot's message in a group chat,
 * 应被视为对机器人的隐式 mention。
 *
 * @param replyToAuthorId - 被引用/回复消息的作者 ID
 * @param botId - 机器人的User ID
 * @param isDirectMessage - 是否为私信（1 对 1 消息）
 * @returns 如果是对机器人的隐式 mention 则返回 true
 */
export function detectImplicitMention(
  replyToAuthorId: string | undefined,
  botId: string | undefined,
  isDirectMessage: boolean,
): boolean {
  if (isDirectMessage) {
    return false;
  }
  if (!replyToAuthorId || !botId) {
    return false;
  }
  return replyToAuthorId === botId;
}
