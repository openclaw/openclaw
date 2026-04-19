/**
 * TIMCustomElem message handler.
 *
 * Custom message: dispatches to sub-handlers by elem_type (@mention, link cards, etc.),
 * supports constructing custom message body.
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
 * Build @user TIMCustomElem message body element.
 *
 * Generates an elem_type=1002 custom message for @mentioning a user in group replies.
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

// Fallback text for unhandled TIMCustomElem sub-types
const FALLBACK_TEXT = "[当前消息暂不支持查看]";

export const customHandler: MessageElemHandler = {
  msgType: "TIMCustomElem",

  /**
   * Parse custom message element, dispatch to sub-handlers by elem_type.
   *
   * - 1002: @mention message, identifies @bot / @other-user
   * - 1010/1007: link card, formats as XML text and collects link URLs
   * - Other: returns fallback placeholder
   */
  extract(
    ctx: MessageHandlerContext,
    elem: MsgBodyItemType,
    resData: ExtractTextFromMsgBodyResult,
  ): string | undefined {
    // Reuse module-level Logger instance
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
        // JSON parse failed, fall back to placeholder
        log.debug("TIMCustomElem data JSON parse failed", {
          data: elem.msg_content?.data,
        });
      }
    }
    return FALLBACK_TEXT;
  },

  /**
   * Build TIMCustomElem message body.
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
