/**
 * Message type Handler 公共类型定义
 *
 * 每种腾讯 IM Message type（TIMTextElem、TIMImageElem 等）都实现 MessageElemHandler 接口，
 * 包含输入解析（extract）和输出构造（buildMsgBody）两个方向的处理。
 */

import type { MessageHandlerContext } from "../context.js";

// ============ 消息元素类型 ============

/** 单条 MsgBody 元素（腾讯 IM 原始格式） */
export type MsgBodyItemType = {
  msg_type: string;
  msg_content: {
    text?: string; // 文字聊天内容
    uuid?: string; // 图片
    image_format?: number; // 图片格式
    data?: string; // 扩展数据
    desc?: string; // 描述
    ext?: string; // 扩展字段
    sound?: string; // 语音
    image_info_array?: Array<{
      type?: number;
      size?: number;
      width?: number;
      height?: number;
      url?: string;
    }>; // 图片内容
    index?: number; // 表情索引
    url?: string; // 文件下载地址
    file_size?: number; // 文件大小（字节）
    file_name?: string; // 文件名称
    [key: string]: unknown;
  };
};

// ============ Extract结果 ============

/** Media资源项 */
export type MediaItem = {
  mediaType: "image" | "file";
  url: string;
  mediaName?: string;
};

/** 被提及的用户 */
export type MentionItem = {
  userId: string;
  text: string;
};

/** 从 MsgBody Extract的结构化结果 */
export type ExtractTextFromMsgBodyResult = {
  rawBody: string;
  isAtBot: boolean;
  /** Media资源列表（Image、文件等） */
  medias: MediaItem[];
  mentions: MentionItem[];
  /** @bot 时从 @mention 文本中提取的 bot 显示名称（不含 @ 前缀） */
  botUsername?: string;
  /** 链接卡片中提取的 URL 列表（供 LinkUnderstanding 使用） */
  linkUrls: string[];
};

// ============ 出站内容项 ============

/**
 * 出站内容项：Description从回复内容中Extract出的一个内容片段
 *
 * 出站消息的 msgBody 构造分两步：
 * 1. 内容格式化准备（prepareOutboundContent）→ Extract出 OutboundContentItem[]
 * 2. 各类型 handler 的 buildMsgBody 逐项转换 → 组合为最终 MsgBody
 */
export type OutboundContentItem =
  | { type: "text"; text: string }
  | {
      type: "image";
      url: string;
      uuid?: string;
      imageFormat?: number;
      imageInfoArray?: Array<{
        type?: number;
        size?: number;
        width?: number;
        height?: number;
        url?: string;
      }>;
    }
  | { type: "file"; url: string; fileName?: string; fileSize?: number; uuid?: string }
  | { type: "video"; videoUrl: string; [key: string]: unknown }
  | { type: "custom"; data: string | Record<string, unknown> };

// ============ Handler 接口 ============

/**
 * 消息元素 Handler 接口
 *
 * 每种Message type需要实现：
 * - msgType: 对应的腾讯 IM Message type标识（如 "TIMTextElem"）
 * - extract: 输入解析 —— 从原始 MsgBody 元素中Extract文本表示
 * - buildMsgBody: 输出构造 —— 将业务数据构造为可发送的 MsgBody 元素（可选）
 */
export interface MessageElemHandler {
  /** Message type标识 */
  readonly msgType: string;

  /**
   * 输入解析：从消息元素中Extract文本表示
   *
   * @param ctx - Message processing context
   * @param elem - 原始 MsgBody 元素
   * @param resData - Extract结果的可变引用（handler 可修改 isAtBot、medias 等字段）
   * @returns 元素的文本表示；返回 undefined 表示该元素不产生可见文本
   */
  extract(
    ctx: MessageHandlerContext,
    elem: MsgBodyItemType,
    resData: ExtractTextFromMsgBodyResult,
  ): string | undefined;

  /**
   * 输出构造：将业务数据构造为可发送的 MsgBody 元素（可选）
   *
   * 不是所有Message type都支持发送（如 TIMSoundElem 通常只接收），
   * Not implementing this method means this type does not support active construction.
   *
   * @param data - 构造消息所需的业务数据
   * @returns MsgBody 元素数组
   */
  buildMsgBody?(data: Record<string, unknown>): MsgBodyItemType[];
}
