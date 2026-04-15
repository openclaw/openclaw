/**
 * TIMFileElem 消息处理器
 *
 * 文件消息：输入时Extract文件 URL 和文件名到Media列表并返回文件标识，
 * 输出时构造文件Message body。
 */

import type { MessageHandlerContext } from "../context.js";
import type { MessageElemHandler, MsgBodyItemType, ExtractTextFromMsgBodyResult } from "./types.js";

export const fileHandler: MessageElemHandler = {
  msgType: "TIMFileElem",

  /**
   * Extract文件 URL 和文件名，记录到Media列表
   *
   * 优先使用文件名作为标识（如 [report.pdf]），
   * 无文件名时使用 [fileN] 格式的占位符。
   *
   * @param _ctx - Message processing context（文件处理中未使用）
   * @param elem - 原始 MsgBody 文件消息元素，需包含 msg_content.url 和可选的 msg_content.file_name
   * @param resData - Extract结果的可变引用，文件信息将追加到 resData.medias 列表
   * @returns 文件标识文本
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
   * 构造 TIMFileElem Message body
   *
   * @param data - 需包含 url 字段，可选 fileName、fileSize、uuid
   * @returns TIMFileElem Message body数组
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
