/**
 * Quote message parsing module
 *
 * 从 cloud_custom_data 中Extract引用消息（quote），并格式化为可拼入上下文的文本。
 */

import type { QuoteInfo, CloudCustomData } from "../../types.js";

// IM 客户端消息 message_type 枚举【客户端定义】
enum ImClientMessageTypeEnum {
  MT_UNKNOW = 0,
  MT_TEXT = 1,
  MT_PIC = 2,
  MT_FILE = 3,
  MT_VIDEO = 4,
  MT_AUDIO = 5,
}

/**
 * 从 cloud_custom_data JSON 字符串中解析引用消息信息
 *
 * @param cloudCustomData - 原始 cloud_custom_data 字符串（JSON 格式）
 * @returns 解析出的 QuoteInfo 对象；不存在引用或解析失败时返回 undefined
 */
export function parseQuoteFromCloudCustomData(cloudCustomData?: string): QuoteInfo | undefined {
  if (!cloudCustomData) {
    return undefined;
  }

  try {
    const parsed: CloudCustomData = JSON.parse(cloudCustomData);
    if (!parsed.quote || typeof parsed.quote !== "object") {
      return undefined;
    }

    const { quote } = parsed;

    // 支持Image引用
    if (Number(quote.type) === (ImClientMessageTypeEnum.MT_PIC as number)) {
      quote.desc = quote.desc?.trim() || "[image]";
    }

    // 至少需要有引用消息的Description内容才有意义
    if (!quote.desc?.trim()) {
      return undefined;
    }

    return quote;
  } catch {
    return undefined;
  }
}

/** 引用摘要的最大字符长度 */
const QUOTE_DESC_MAX_LENGTH = 500;

/**
 * Format quoted message into context text that can be appended to user messages
 *
 * Generated format:
 * ```
 * [Quoted message from <sender_nickname>]:
 * <desc（截断至 QUOTE_DESC_MAX_LENGTH）>
 * ---
 * ```
 *
 * @param quote - 引用消息信息
 * @returns 格式化后的引用上下文文本
 */
export function formatQuoteContext(quote: QuoteInfo): string {
  let senderPart = "";
  if (quote.sender_nickname) {
    senderPart = ` from ${quote.sender_nickname}`;
  } else if (quote.sender_id) {
    senderPart = ` from ${quote.sender_id}`;
  }

  let desc = quote.desc?.trim() || "";

  // 超长引用进行截断，避免占用过多上下文
  if (desc.length > QUOTE_DESC_MAX_LENGTH) {
    desc = `${desc.slice(0, QUOTE_DESC_MAX_LENGTH)}...(truncated)`;
  }

  return `> [Quoted message${senderPart}]:\n>${desc}\n`;
}
