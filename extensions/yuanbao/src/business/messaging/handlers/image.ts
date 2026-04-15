/**
 * TIMImageElem 消息处理器
 *
 * Image消息：输入时ExtractImage URL 到Media列表并返回 [imageN] 占位符，
 * 输出时构造ImageMessage body。
 */

import type { MessageHandlerContext } from "../context.js";
import type { MessageElemHandler, MsgBodyItemType, ExtractTextFromMsgBodyResult } from "./types.js";

export const imageHandler: MessageElemHandler = {
  msgType: "TIMImageElem",

  /**
   * ExtractImage URL 并记录到Media列表
   *
   * 取 image_info_array 中第一个元素的 url，添加到 resData.medias，
   * 返回 [imageN] 格式的占位符（索引从 1 开始）。
   *
   * @param _ctx - Message processing context（Image处理中未使用）
   * @param elem - 原始 MsgBody Image消息元素，需包含 msg_content.image_info_array
   * @param resData - Extract结果的可变引用，Image信息将追加到 resData.medias 列表
   * @returns [imageN] 占位符文本；无 URL 时返回 undefined
   */
  extract(
    _ctx: MessageHandlerContext,
    elem: MsgBodyItemType,
    resData: ExtractTextFromMsgBodyResult,
  ): string | undefined {
    // 取第一个 image_info_array 中的 url（Original image，type=1）
    const imageInfoArray = elem.msg_content?.image_info_array as
      | Array<{ type?: number; url?: string }>
      | undefined;
    // 取中间图下载
    const imageInfo = imageInfoArray?.[1] || imageInfoArray?.[0];
    if (imageInfo?.url) {
      resData.medias.push({ mediaType: "image", url: imageInfo.url });
      // Image索引从 1 开始，与 [image1][image2] 对应
      return `[image${resData.medias.filter((m) => m.mediaType === "image").length}]`;
    }
    return undefined;
  },

  /**
   * 构造 TIMImageElem Message body
   *
   * @param data - 需包含 url 字段，可选 uuid、imageFormat、imageInfoArray
   * @returns TIMImageElem Message body数组
   */
  buildMsgBody(data: Record<string, unknown>): MsgBodyItemType[] {
    const imageInfoArray = data.imageInfoArray ?? [
      {
        type: 1, // 原图
        url: data.url as string,
      },
    ];
    return [
      {
        msg_type: "TIMImageElem",
        msg_content: {
          ...(data.uuid ? { uuid: data.uuid } : {}),
          ...(data.imageFormat ? { image_format: data.imageFormat } : {}),
          image_info_array: imageInfoArray,
        } as MsgBodyItemType["msg_content"],
      },
    ];
  },
};
