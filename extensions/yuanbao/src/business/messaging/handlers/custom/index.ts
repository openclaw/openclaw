/**
 * TIMCustomElem 消息处理器
 *
 * 自定义消息：按 elem_type 分发到子处理器（@消息、链接卡片等），支持构造自定义 Message body。
 */

import { createLog } from "../../../../logger.js";
import type { ModuleLog } from "../../../../logger.js";
import type { MessageHandlerContext } from "../../context.js";
import type {
  MessageElemHandler,
  MsgBodyItemType,
  ExtractTextFromMsgBodyResult,
} from "../types.js";
import { extractLinkCard, extractLinkCardUrls } from "./link-card.js";

/**
 * 构造 @ 用户的 TIMCustomElem Message body 元素
 *
 * 生成一个 elem_type=1002 的自定义消息，用于在群消息回复中 @ 指定用户。
 *
 * @param userId - 被 @ 的 User ID（收消息时的 from_account）
 * @param senderNickname - @ 的显示文本，Default "@用户"
 * @returns TIMCustomElem Message body 元素
 */
export function buildAtUserMsgBodyItem(userId: string, senderNickname?: string): MsgBodyItemType {
  return {
    msg_type: "TIMCustomElem",
    msg_content: {
      data: JSON.stringify({
        elem_type: 1002,
        text: `@${senderNickname ?? ""}`,
        user_id: userId,
      }),
    },
  };
}

// TIMCustomElem 未适配子类型的兜底文本
const FALLBACK_TEXT = "[当前消息暂不支持查看]";

export const customHandler: MessageElemHandler = {
  msgType: "TIMCustomElem",

  /**
   * 解析自定义消息元素，按 elem_type 分发到子处理器
   *
   * - 1002: @ 消息，识别 @机器人 / @其他用户
   * - 1010/1007: 链接卡片，格式化为 XML 文本并收集链接 URL
   * - 其他: 返回 "[当前消息暂不支持查看]" 占位符
   *
   * @param ctx - Message processing context，用于获取 botId 以判断是否 @ 机器人
   * @param elem - 原始 MsgBody 自定义消息元素，需包含 msg_content.data（JSON 字符串）
   * @param resData - Extract 结果的可变引用，@ 机器人时会设置 resData.isAtBot = true
   * @returns 元素的文本表示；返回 undefined 表示该元素不产生可见文本
   */
  extract(
    ctx: MessageHandlerContext,
    elem: MsgBodyItemType,
    resData: ExtractTextFromMsgBodyResult,
  ): string | undefined {
    // 复用模块级 Logger instance
    const log: ModuleLog = createLog("custom", ctx.log);
    if (elem.msg_content?.data) {
      try {
        const customContent = JSON.parse(elem.msg_content?.data);

        switch (customContent?.elem_type) {
          case 1002: {
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

            if (customContent?.user_id) {
              resData.mentions.push({
                userId: customContent.user_id,
                text: customContent.text || "",
              });
            }

            if (isAtBotSelf && customContent.text) {
              resData.botUsername = customContent.text.replace(/^@/, "");
            }

            return customContent.text || undefined;
          }
          case 1010:
          case 1007: {
            const urls = extractLinkCardUrls(customContent);
            if (urls.length > 0) {
              resData.linkUrls.push(...urls);
            }
            return extractLinkCard(customContent);
          }
          default:
            return FALLBACK_TEXT;
        }
      } catch {
        // JSON 解析失败，降级为兜底文本
        log.debug("TIMCustomElem data JSON parse failed", {
          data: elem.msg_content?.data,
        });
      }
    }
    return FALLBACK_TEXT;
  },

  /**
   * 构造 TIMCustomElem Message body
   *
   * @param data - 需包含 data 字段（JSON 字符串或可序列化对象）
   * @returns TIMCustomElem Message body 数组
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
