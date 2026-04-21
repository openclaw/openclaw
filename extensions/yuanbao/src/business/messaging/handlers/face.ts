/** TIMFaceElem message handler. */

import type { MessageHandlerContext } from "../context.js";
import type { MessageElemHandler, MsgBodyItemType, ExtractTextFromMsgBodyResult } from "./types.js";

/** JSON structure of TIMFaceElem Data field */
interface FaceData {
  package_id?: string;
  sticker_id?: string;
  name?: string;
  width?: number;
  height?: number;
  formats?: string;
}

export const faceHandler: MessageElemHandler = {
  msgType: "TIMFaceElem",

  extract(
    _ctx: MessageHandlerContext,
    elem: MsgBodyItemType,
    _resData: ExtractTextFromMsgBodyResult,
  ): string | undefined {
    const rawData = elem.msg_content?.data;
    if (rawData) {
      try {
        const faceData = JSON.parse(rawData) as FaceData;
        const name = faceData.name?.trim();
        if (name) {
          return `[EMOJI: ${name}]`;
        }
      } catch {
        // JSON parse failed
      }
    }
    return "[EMOJI]";
  },

  buildMsgBody(data: {
    package_id: string;
    sticker_id: string;
    name: string;
    index?: number;
  }): MsgBodyItemType[] {
    const { index, ...contentdata } = data;
    return [
      {
        msg_type: "TIMFaceElem",
        msg_content: {
          index,
          data: JSON.stringify(contentdata),
        },
      },
    ];
  },
};
