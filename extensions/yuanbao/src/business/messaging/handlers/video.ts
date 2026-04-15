/**
 * TIMVideoFileElem 消息处理器
 *
 * 视频消息：输入时返回 [video] 占位符，输出时构造视频Message body。
 */

import type { MessageHandlerContext } from "../context.js";
import type { MessageElemHandler, MsgBodyItemType, ExtractTextFromMsgBodyResult } from "./types.js";

export const videoHandler: MessageElemHandler = {
  msgType: "TIMVideoFileElem",

  /**
   * 视频消息Extract：返回 [video] 占位符
   *
   * Currently only returns placeholder text; no further parsing of video content.
   *
   * @param _ctx - Message processing context（视频处理中未使用）
   * @param _elem - 原始 MsgBody 视频消息元素（当前未解析具体字段）
   * @param _resData - Extract结果的可变引用（视频处理中未修改）
   * @returns "[video]" 占位符文本
   */
  extract(
    _ctx: MessageHandlerContext,
    _elem: MsgBodyItemType,
    _resData: ExtractTextFromMsgBodyResult,
  ): string | undefined {
    return "[video]";
  },

  /**
   * 构造 TIMVideoFileElem Message body
   *
   * @param data - 需包含 videoUrl 字段，可选 videoUuid、videoSize、videoSecond、
   *              videoFormat、thumbUrl、thumbUuid、thumbSize、thumbWidth、thumbHeight、thumbFormat
   * @returns TIMVideoFileElem Message body数组
   */
  buildMsgBody(data: Record<string, unknown>): MsgBodyItemType[] {
    return [
      {
        msg_type: "TIMVideoFileElem",
        msg_content: {
          video_url: data.videoUrl,
          ...(data.videoUuid ? { video_uuid: data.videoUuid } : {}),
          ...(data.videoSize ? { video_size: data.videoSize } : {}),
          ...(data.videoSecond ? { video_second: data.videoSecond } : {}),
          ...(data.videoFormat ? { video_format: data.videoFormat } : {}),
          ...(data.thumbUrl ? { thumb_url: data.thumbUrl } : {}),
          ...(data.thumbUuid ? { thumb_uuid: data.thumbUuid } : {}),
          ...(data.thumbSize ? { thumb_size: data.thumbSize } : {}),
          ...(data.thumbWidth ? { thumb_width: data.thumbWidth } : {}),
          ...(data.thumbHeight ? { thumb_height: data.thumbHeight } : {}),
          ...(data.thumbFormat ? { thumb_format: data.thumbFormat } : {}),
        } as MsgBodyItemType["msg_content"],
      },
    ];
  },
};
