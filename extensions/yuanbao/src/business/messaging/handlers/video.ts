/**
 * TIMVideoFileElem message handler.
 *
 * Video message: on input, returns [video] placeholder; on output, constructs video message body.
 */

import type { MessageHandlerContext } from "../context.js";
import type { MessageElemHandler, MsgBodyItemType, ExtractTextFromMsgBodyResult } from "./types.js";

export const videoHandler: MessageElemHandler = {
  msgType: "TIMVideoFileElem",

  /**
   * Extract video message: returns [video] placeholder.
   * Currently only returns placeholder text; no further parsing of video content.
   */
  extract(
    _ctx: MessageHandlerContext,
    _elem: MsgBodyItemType,
    _resData: ExtractTextFromMsgBodyResult,
  ): string | undefined {
    return "[video]";
  },

  /**
   * Build TIMVideoFileElem message body.
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
