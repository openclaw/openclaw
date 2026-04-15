/**
 * TIMSoundElem 消息处理器
 *
 * Voice/Audio消息：输入时返回 [voice] 占位符。
 * 当前不支持主动构造Voice/Audio消息。
 */

import type { MessageHandlerContext } from "../context.js";
import type { MessageElemHandler, MsgBodyItemType, ExtractTextFromMsgBodyResult } from "./types.js";

export const soundHandler: MessageElemHandler = {
  msgType: "TIMSoundElem",

  /**
   * Voice/Audio消息Extract：返回 [voice] 占位符
   *
   * 当前仅返回占位符文本，不对Voice/Audio内容做进一步解析。
   *
   * @param _ctx - Message processing context（Voice/Audio处理中未使用）
   * @param _elem - 原始 MsgBody Voice/Audio消息元素（当前未解析具体字段）
   * @param _resData - Extract结果的可变引用（Voice/Audio处理中未修改）
   * @returns "[voice]" 占位符文本
   */
  extract(
    _ctx: MessageHandlerContext,
    _elem: MsgBodyItemType,
    _resData: ExtractTextFromMsgBodyResult,
  ): string | undefined {
    return "[voice]";
  },
};
