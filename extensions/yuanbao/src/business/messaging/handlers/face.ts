/**
 * TIMFaceElem 消息处理器
 *
 * 表情消息：输入时解析 Data 字段中的表情信息，返回 [表情: 名称] 文本表示供模型处理；
 * 输出时构造表情Message body。
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

/** TIMFaceElem Data 字段的 JSON 结构 */
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
   * Extract sticker message as text representation
   *
   * 解析 msg_content.data（JSON 字符串）获取表情名称，
   * 返回 [表情: 名称] 格式供模型处理。
   * 若 data 缺失或解析失败，返回通用占位符 [表情]。
   *
   * @param _ctx - Message processing context（表情处理中未使用）
   * @param elem - 原始 MsgBody 表情消息元素
   * @param _resData - Extract结果的可变引用（表情处理中未修改）
   * @returns [表情: 名称] 或 [表情] 文本占位符
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
        // 入站缓存：将收到的表情写入本地缓存
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
        // JSON 解析失败，降级为通用占位符
      }
    }
    return "[EMOJI]";
  },

  /**
   * 构造 TIMFaceElem Message body
   *
   * @param data - 需包含 index 和 faceData（表情元数据）字段
   *   - index: Sticker/emoji index（Default 0）
   *   - faceData: FaceData 对象，包含 package_id、sticker_id、name 等字段
   * @returns TIMFaceElem Message body数组
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
