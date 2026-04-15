/**
 * Message type Handler 注册表
 *
 * 统一注册和管理所有Message type的 Handler，提供：
 * - 按 msgType 查找 handler（用于输入解析）
 * - 按 msgType 构造Message body（用于输出发送）
 * - 出站Message content准备与 msgBody 构造管线
 *
 * 新增Message type只需：
 * 1. 在 handlers/ Directory下创建对应 handler 文件
 * 2. 在本文件 handlerList 中注册即可
 */

import type { Member } from "../../../infra/cache/member.js";
import { mdTable, mdMath } from "../../utils/markdown.js";
import { customHandler } from "./custom.js";
import { faceHandler } from "./face.js";
import { fileHandler } from "./file.js";
import { imageHandler } from "./image.js";
import { soundHandler } from "./sound.js";
import { textHandler } from "./text.js";
import type { MessageElemHandler, MsgBodyItemType, OutboundContentItem } from "./types.js";
import { videoHandler } from "./video.js";

// ============ Handler 注册 ============

/** 所有已注册的Message type Handler 列表 */
const handlerList: MessageElemHandler[] = [
  textHandler,
  customHandler,
  imageHandler,
  soundHandler,
  fileHandler,
  videoHandler,
  faceHandler,
];

/** msgType → Handler 的快速查找映射 */
const handlerMap = new Map<string, MessageElemHandler>(handlerList.map((h) => [h.msgType, h]));

/**
 * OutboundContentItem.type → 腾讯 IM msgType 的映射
 *
 * 将简短的内容类型标识（"text"、"image" 等）映射到对应的 handler msgType，
 * 从而让 buildOutboundMsgBody 找到正确的 handler 进行 msgBody 构造。
 */
const outboundTypeToMsgType: Record<string, string> = {
  text: "TIMTextElem",
  image: "TIMImageElem",
  file: "TIMFileElem",
  video: "TIMVideoFileElem",
  custom: "TIMCustomElem",
};

// ============ 公共 API ============

/**
 * 根据Message type获取对应的 Handler
 *
 * @param msgType - 腾讯 IM Message type标识（如 "TIMTextElem"）
 * @returns 对应的 Handler 实例；未注册的类型返回 undefined
 */
export function getHandler(msgType: string): MessageElemHandler | undefined {
  return handlerMap.get(msgType);
}

/**
 * 获取所有已注册的 Handler 列表
 *
 * @returns Handler 数组（只读副本）
 */
export function getAllHandlers(): readonly MessageElemHandler[] {
  return handlerList;
}

/**
 * 通过 msgType 构造Message body（便捷方法）
 *
 * @param msgType - 腾讯 IM Message type标识
 * @param data - 构造消息所需的业务数据
 * @returns MsgBody 元素数组；handler 不存在或不支持构造时返回 undefined
 */
export function buildMsgBody(
  msgType: string,
  data: Record<string, unknown>,
): MsgBodyItemType[] | undefined {
  const handler = handlerMap.get(msgType);
  return handler?.buildMsgBody?.(data);
}

// ============ 出站内容准备与 MsgBody 构造管线 ============

/**
 * @用户 正则：空格（或行首）+ @ + nickname + 空格（或行尾）
 *
 * 通过 lookbehind 保证前方有空格或行首，lookahead 保证后方有空格或行尾。
 * 组1: nickname（@符号后到下一个空格之间的非空白字符）
 */
const AT_USER_RE = /(?<=\s|^)@(\S+?)(?=\s|$)/g;

/**
 * 对纯文本片段进行 @用户 解析，拆分为 text + custom 混合内容项
 *
 * 扫描文本中的 空格+@+nickname+空格 格式：
 * - 有 groupCode 且提供了 memberInst 时查询 member 模块，命中则插入 custom 类型（elem_type: 1002）
 * - 未命中或无 groupCode/memberInst 则保留 @nickname 原文按 text 类型插入
 *
 * @param text - 纯文本片段
 * @param groupCode - 可选的Group identifier，用于在 member 模块中查询 @用户
 * @param memberInst - 可选的 Member 实例，用于查询用户信息
 * @returns 拆分后的 OutboundContentItem 列表（无匹配时返回单个 text 项）
 */
function resolveAtMentions(
  text: string,
  groupCode?: string,
  memberInst?: Member,
): OutboundContentItem[] {
  const items: OutboundContentItem[] = [];
  let lastIndex = 0;

  for (const match of text.matchAll(AT_USER_RE)) {
    const matchStart = match.index;

    // @用户 前的文本片段
    if (matchStart > lastIndex) {
      const before = text.slice(lastIndex, matchStart);
      if (before.trim()) {
        items.push({ type: "text", text: before.trim() });
      }
    }

    const nickName = match[1];
    const userRecord =
      groupCode && memberInst ? memberInst.lookupUserByNickName(groupCode, nickName) : undefined;

    if (userRecord) {
      // 查到了用户，插入 custom 类型的 @消息
      items.push({
        type: "custom",
        data: JSON.stringify({
          elem_type: 1002,
          text: `@${userRecord.nickName}`,
          user_id: userRecord.userId,
        }),
      });
    } else {
      // 未查到，保留原文按 text 类型插入
      items.push({ type: "text", text: `@${nickName}` });
    }

    lastIndex = matchStart + match[0].length;
  }

  // 剩余的尾部文本
  if (lastIndex < text.length) {
    const trailing = text.slice(lastIndex);
    if (trailing.trim()) {
      items.push({ type: "text", text: trailing.trim() });
    }
  }

  // 无任何匹配时返回原文
  if (items.length === 0 && text.trim()) {
    items.push({ type: "text", text: text.trim() });
  }

  return items;
}

/**
 * Content formatting preparation: extract raw text content into a structured content item list
 *
 * Two-phase processing:
 * 1. Extract Markdown Image引用（![alt](url)），将文本拆分为 text + image 交替序列
 * 2. 对每个 text 片段进行 @用户 解析，将匹配到的 @nickname 替换为 custom 或保留 text
 *
 * @param text - 原始文本内容（可能包含 Markdown Image、@用户等格式）
 * @param groupCode - 可选的Group identifier，用于在 member 模块中查询 @用户
 * @param memberInst - 可选的 Member 实例，用于查询用户信息
 * @returns 有序的 OutboundContentItem 列表
 */
export function prepareOutboundContent(
  text: string,
  groupCode?: string,
  memberInst?: Member,
): OutboundContentItem[] {
  if (!text) {
    return [];
  }

  const sanitizedText = mdTable.sanitize(mdMath.normalize(text));

  const items: OutboundContentItem[] = [];

  // 剩余的尾部文本 → 进行 @用户 二次解析
  if (sanitizedText.length) {
    const trailing = sanitizedText.trim();
    if (trailing) {
      items.push(...resolveAtMentions(trailing, groupCode, memberInst));
    }
  }

  // 如果没有任何匹配，整段文本进行 @用户 解析
  if (items.length === 0 && sanitizedText.trim()) {
    items.push(...resolveAtMentions(sanitizedText.trim(), groupCode, memberInst));
  }

  return items;
}

/**
 * 将内容项列表通过各类型 handler 转换为最终的 MsgBody 数组
 *
 * 遍历 OutboundContentItem 列表，根据每项的 type 找到对应 handler 的 buildMsgBody，
 * 将所有结果合并为一个完整的 MsgBody 数组。
 *
 * @param items - 由 prepareOutboundContent Extract出的内容项列表
 * @returns 可直接用于消息发送的 MsgBody 元素数组
 */
export function buildOutboundMsgBody(items: OutboundContentItem[]): MsgBodyItemType[] {
  const msgBody: MsgBodyItemType[] = [];

  for (const item of items) {
    const msgType = outboundTypeToMsgType[item.type];
    if (!msgType) {
      continue;
    }

    const handler = handlerMap.get(msgType);
    if (!handler?.buildMsgBody) {
      continue;
    }

    // 将 OutboundContentItem 转换为 handler 的 data 参数
    const { type: _type, ...data } = item;
    const elems = handler.buildMsgBody(data as Record<string, unknown>);
    if (elems) {
      msgBody.push(...elems);
    }
  }

  return msgBody;
}

// ============ 导出类型和具体 Handler ============

export type {
  MessageElemHandler,
  MsgBodyItemType,
  MediaItem,
  ExtractTextFromMsgBodyResult,
  OutboundContentItem,
} from "./types.js";

export { textHandler } from "./text.js";
export { customHandler, buildAtUserMsgBodyItem } from "./custom.js";
export { imageHandler } from "./image.js";
export { soundHandler } from "./sound.js";
export { fileHandler } from "./file.js";
export { videoHandler } from "./video.js";
export { faceHandler } from "./face.js";
