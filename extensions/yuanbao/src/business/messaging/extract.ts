/**
 * Message format conversion: extract text, media and structured info from Tencent IM MsgBody.
 * Specific message type handling is split into handlers/ directory.
 */

import type { MessageHandlerContext } from "./context.js";
import { getHandler } from "./handlers/index.js";
import type { MsgBodyItemType, ExtractTextFromMsgBodyResult } from "./handlers/types.js";

// Re-export types for backward compatibility
export type { ExtractTextFromMsgBodyResult } from "./handlers/types.js";

// ============ Extract text content from MsgBody ============

/**
 * Extract text content from message body.
 *
 * Converts various MsgBody elements to readable text via corresponding handlers:
 * TIMTextElem extracts raw text, other types use placeholders (e.g. [image], [voice]).
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
    // Silently ignore unregistered message types
  }

  resData.rawBody = texts.join("\n");

  return resData;
}
