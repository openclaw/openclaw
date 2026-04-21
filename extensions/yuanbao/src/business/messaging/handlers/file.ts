/**
 * TIMFileElem message handler.
 *
 * File message: on input, extracts file URL and filename to media list and returns file identifier;
 * on output, constructs file message body.
 */

import type { MessageHandlerContext } from "../context.js";
import type { MessageElemHandler, MsgBodyItemType, ExtractTextFromMsgBodyResult } from "./types.js";

export const fileHandler: MessageElemHandler = {
  msgType: "TIMFileElem",

  /**
   * Extract file URL and filename, record to media list.
   * Prefers filename as identifier (e.g. [report.pdf]); falls back to [fileN] placeholder.
   */
  extract(
    _ctx: MessageHandlerContext,
    elem: MsgBodyItemType,
    resData: ExtractTextFromMsgBodyResult,
  ): string {
    const fileUrl = elem.msg_content?.url;
    const fileName = elem.msg_content?.file_name;
    if (fileUrl) {
      resData.medias.push({ mediaType: "file", url: fileUrl, mediaName: fileName });
      return fileName
        ? `[${fileName}]`
        : `[file${resData.medias.filter((m) => m.mediaType === "file").length}]`;
    }
    return "[file]";
  },

  /**
   * Build TIMFileElem message body.
   */
  buildMsgBody(data: Record<string, unknown>): MsgBodyItemType[] {
    return [
      {
        msg_type: "TIMFileElem",
        msg_content: {
          url: data.url,
          ...(data.fileName ? { file_name: data.fileName } : {}),
          ...(data.fileSize ? { file_size: data.fileSize } : {}),
          ...(data.uuid ? { uuid: data.uuid } : {}),
        } as MsgBodyItemType["msg_content"],
      },
    ];
  },
};
