/**
 * TIMCustomElem 消息处理器
 *
 * 自定义消息：识别 @ 消息并Extract文本，支持构造自定义Message body。
 */

import { createLog } from "../../../logger.js";
import type { ModuleLog } from "../../../logger.js";
import type { MessageHandlerContext } from "../context.js";
import type { MessageElemHandler, MsgBodyItemType, ExtractTextFromMsgBodyResult } from "./types.js";

/**
 * 构造 @ 用户的 TIMCustomElem Message body元素
 *
 * 生成一个 elem_type=1002 的自定义消息，用于在群消息回复中 @ 指定用户。
 *
 * @param userId - 被 @ 的User ID（收消息时的 from_account）
 * @param displayText - @ 的显示文本，Default "@用户"
 * @returns TIMCustomElem Message body元素
 */
export function buildAtUserMsgBodyItem(userId: string, senderNickname?: string): MsgBodyItemType {
  return {
    msg_type: "TIMCustomElem",
    msg_content: {
      data: JSON.stringify({ elem_type: 1002, text: `@${senderNickname ?? ""}`, user_id: userId }),
    },
  };
}

// TIMCustomElem 类型的Default文本
const FALLBACK_TEXT = "[custom]";

export const customHandler: MessageElemHandler = {
  msgType: "TIMCustomElem",

  /**
   * 解析自定义消息元素，识别 @ 消息并Extract文本
   *
   * 解析 msg_content.data 中的 JSON 数据，判断是否为 @ 类型（elem_type === 1002）。
   * 若 @ 的是机器人则标记 isAtBot，否则将 @ 对象的显示文本作为Message content返回。
   *
   * @param ctx - Message processing context，用于获取 botId 以判断是否 @ 机器人
   * @param elem - 原始 MsgBody 自定义消息元素，需包含 msg_content.data（JSON 字符串）
   * @param resData - Extract结果的可变引用，@ 机器人时会设置 resData.isAtBot = true
   * @returns @ 非机器人用户时返回 @ 文本；@ 机器人或解析失败时返回 undefined；非 @ 自定义消息返回 "[custom]"
   */
  extract(
    ctx: MessageHandlerContext,
    elem: MsgBodyItemType,
    resData: ExtractTextFromMsgBodyResult,
  ): string | undefined {
    // 复用模块级Logger instance
    const log: ModuleLog = createLog("custom", ctx.log);
    if (elem.msg_content?.data) {
      try {
        const customContent = JSON.parse(elem.msg_content?.data);

        if (customContent?.elem_type !== 1002) {
          return FALLBACK_TEXT;
        }

        const { botId } = ctx.account;
        const isAtBotSelf = customContent?.user_id === botId;
        if (!resData.isAtBot) {
          resData.isAtBot = isAtBotSelf;
        }

        log.info("@ message", {
          text: customContent?.text,
          userId: customContent?.user_id,
          isAtBot: resData.isAtBot,
        });

        // 保存被 @ 的用户信息（排除 @Bot 自己）
        if (!isAtBotSelf && customContent?.user_id) {
          resData.mentions.push({
            userId: customContent.user_id,
            text: customContent.text || "",
          });
        }

        // 只过滤 @Bot自己 的文本，保留 @其他人 的文本
        const result = !isAtBotSelf && customContent.text ? customContent.text : undefined;
        return result;
      } catch {
        // JSON 解析失败，降级为Default文本
        log.debug("TIMCustomElem data JSON parse failed", { data: elem.msg_content?.data });
      }
    }
    return FALLBACK_TEXT;
  },

  /**
   * 构造 TIMCustomElem Message body
   *
   * @param data - 需包含 data 字段（JSON 字符串或可序列化对象）
   * @returns TIMCustomElem Message body数组
   */
  buildMsgBody(data: Record<string, unknown>): MsgBodyItemType[] {
    const customData = typeof data.data === "string" ? data.data : JSON.stringify(data.data);
    return [
      {
        msg_type: "TIMCustomElem",
        msg_content: { data: customData },
      },
    ];
  },
};
