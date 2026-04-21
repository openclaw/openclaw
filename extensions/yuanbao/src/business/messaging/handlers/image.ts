/**
 * TIMImageElem message handler.
 *
 * Image message: on input, extracts image URL to media list and returns [imageN] placeholder;
 * on output, constructs image message body.
 */

import type { MessageHandlerContext } from "../context.js";
import type { MessageElemHandler, MsgBodyItemType, ExtractTextFromMsgBodyResult } from "./types.js";

export const imageHandler: MessageElemHandler = {
  msgType: "TIMImageElem",

  /**
   * Extract image URL and record to media list.
   * Returns [imageN] placeholder (1-indexed); undefined if no URL.
   */
  extract(
    _ctx: MessageHandlerContext,
    elem: MsgBodyItemType,
    resData: ExtractTextFromMsgBodyResult,
  ): string | undefined {
    // Get url from first element in image_info_array (original image, type=1)
    const imageInfoArray = elem.msg_content?.image_info_array as
      | Array<{ type?: number; url?: string }>
      | undefined;
    // Use medium-size image for download
    const imageInfo = imageInfoArray?.[1] || imageInfoArray?.[0];
    if (imageInfo?.url) {
      resData.medias.push({ mediaType: "image", url: imageInfo.url });
      // Image index starts from 1, corresponding to [image1][image2]
      return `[image${resData.medias.filter((m) => m.mediaType === "image").length}]`;
    }
    return undefined;
  },

  /**
   * Build TIMImageElem message body.
   */
  buildMsgBody(data: Record<string, unknown>): MsgBodyItemType[] {
    const imageInfoArray = data.imageInfoArray ?? [
      {
        type: 1, // Original image
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
