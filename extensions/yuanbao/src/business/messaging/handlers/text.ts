/**
 * TIMTextElem 消息处理器
 *
 * 纯文本消息：输入时Extract文本内容，输出时构造文本Message body。
 */

import type { MessageHandlerContext } from "../context.js";
import type { MessageElemHandler, MsgBodyItemType, ExtractTextFromMsgBodyResult } from "./types.js";

export const textHandler: MessageElemHandler = {
  msgType: "TIMTextElem",

  /**
   * Extract文本Message content
   *
   * @param _ctx - Message processing context（纯文本处理中未使用）
   * @param elem - 原始 MsgBody 文本消息元素，从 msg_content.text 中Extract文本
   * @param _resData - Extract结果的可变引用（纯文本处理中未修改）
   * @returns 文本内容；空文本时返回 undefined
   */
  extract(
    _ctx: MessageHandlerContext,
    elem: MsgBodyItemType,
    _resData: ExtractTextFromMsgBodyResult,
  ): string | undefined {
    return elem.msg_content?.text || undefined;
  },

  /**
   * 构造 TIMTextElem Message body
   *
   * @param data - 需包含 text 字段
   * @returns TIMTextElem Message body数组
   */
  buildMsgBody(data: Record<string, unknown>): MsgBodyItemType[] {
    const text = data.text as string;
    return [
      {
        msg_type: "TIMTextElem",
        msg_content: { text },
      },
    ];
  },
};
