/**
 * TIMTextElem message handler.
 *
 * Plain text message: on input, extracts text content; on output, constructs text message body.
 */

import type { MessageHandlerContext } from "../context.js";
import type { MessageElemHandler, MsgBodyItemType, ExtractTextFromMsgBodyResult } from "./types.js";

export const textHandler: MessageElemHandler = {
  msgType: "TIMTextElem",

  /**
   * Extract text message content.
   */
  extract(
    _ctx: MessageHandlerContext,
    elem: MsgBodyItemType,
    _resData: ExtractTextFromMsgBodyResult,
  ): string | undefined {
    return elem.msg_content?.text || undefined;
  },

  /**
   * Build TIMTextElem message body.
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
