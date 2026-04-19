/**
 * TIMSoundElem message handler.
 *
 * Voice/audio message: on input, returns [voice] placeholder.
 * Active construction of voice messages is not currently supported.
 */

import type { MessageHandlerContext } from "../context.js";
import type { MessageElemHandler, MsgBodyItemType, ExtractTextFromMsgBodyResult } from "./types.js";

export const soundHandler: MessageElemHandler = {
  msgType: "TIMSoundElem",

  /**
   * Extract voice message: returns [voice] placeholder.
   * Currently only returns placeholder text; no further parsing of voice content.
   */
  extract(
    _ctx: MessageHandlerContext,
    _elem: MsgBodyItemType,
    _resData: ExtractTextFromMsgBodyResult,
  ): string | undefined {
    return "[voice]";
  },
};
