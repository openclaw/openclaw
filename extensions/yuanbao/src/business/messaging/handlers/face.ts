/**
 * TIMFaceElem message handler.
 *
 * Sticker message: on input, parses sticker info from Data field and returns [EMOJI: name] text for model processing;
 * on output, constructs sticker message body.
 *
 * Data format example:
 * {
 *   "msg_type": "TIMFaceElem",
 *   "msg_content": {
 *     "index": 0,
 *     "data": "{\"package_id\": \"1004\", \"sticker_id\": \"51675\", \"name\": \"喜悦情绪\", \"width\": 220, \"height\": 220, \"formats\": \"gif\"}"
 *   }
 * }
 */

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

  /**
   * Extract sticker message as text representation.
   *
   * Parses msg_content.data (JSON string) to get sticker name,
   * returns [EMOJI: name] format for model processing.
   * Falls back to generic [EMOJI] placeholder if data is missing or parsing fails.
   *
   */
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
        // Inbound cache: write received sticker to local cache
        // if (faceData.sticker_id) {
        //   cacheSticker({
        //     sticker_id: faceData.sticker_id,
        //     emoji_pack_id: faceData.package_id ?? '',
        //     name: name ?? faceData.sticker_id,
        //     description: name ?? faceData.sticker_id,
        //     cachedAt: new Date().toISOString(),
        //     source: 'received',
        //   });
        // }
        if (name) {
          return `[EMOJI: ${name}]`;
        }
      } catch {
        // JSON parse failed, fall back to generic placeholder
      }
    }
    return "[EMOJI]";
  },

  /**
   * Build TIMFaceElem message body.
   *

   */
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
