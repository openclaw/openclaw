/**
 * Message format conversion
 *
 * 从腾讯 IM MsgBody 中Extract文本、Media等结构化信息。
 * 具体的Message type处理逻辑已拆分到 handlers/ Directory下的各个 Handler 中。
 */

import type { MessageHandlerContext } from "./context.js";
import { getHandler } from "./handlers/index.js";
import type { MsgBodyItemType, ExtractTextFromMsgBodyResult } from "./handlers/types.js";

// 重新导出类型，保持向后兼容
export type { ExtractTextFromMsgBodyResult } from "./handlers/types.js";

// ============ 从 MsgBody Extract文本内容 ============

/**
 * 从Message body中Extract文本内容
 *
 * 将 MsgBody 中的各类元素通过对应的 Handler 转换为可读文本：
 * TIMTextElem Extract原文，其他类型用占位符表示（如 [image]、[voice]）
 *
 * @param ctx - Message processing context
 * @param msgBody - Message body元素数组
 * @returns Extract并拼接后的文本内容
 */
export function extractTextFromMsgBody(
  ctx: MessageHandlerContext,
  msgBody?: Array<MsgBodyItemType>,
): ExtractTextFromMsgBodyResult {
  const resData: ExtractTextFromMsgBodyResult = {
    rawBody: "",
    isAtBot: false,
    medias: [],
    mentions: [],
    linkUrls: [],
  };

  if (!msgBody || !Array.isArray(msgBody)) {
    return resData;
  }

  const texts: string[] = [];

  for (const elem of msgBody) {
    const handler = getHandler(elem.msg_type);
    if (handler) {
      const text = handler.extract(ctx, elem, resData);
      if (text) {
        texts.push(text);
      }
    }
    // 未注册的Message type静默忽略
  }

  resData.rawBody = texts.join("\n");

  return resData;
}
