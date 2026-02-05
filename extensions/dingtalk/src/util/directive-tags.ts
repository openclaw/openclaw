/**
 * 清理 Clawdbot 输出中的内联指令标记
 *
 * Clawdbot 使用类似 [[reply_to_current]] 的标记来控制消息行为，
 * 这些标记应该在发送给用户之前被移除。
 */

// 匹配 [[audio_as_voice]] 标记
const AUDIO_TAG_RE = /\[\[\s*audio_as_voice\s*\]\]/gi;

// 匹配 [[reply_to_current]] 或 [[reply_to:<id>]] 标记
const REPLY_TAG_RE = /\[\[\s*(?:reply_to_current|reply_to\s*:\s*[^\]\n]+)\s*\]\]/gi;

// 匹配其他可能的控制标记 [[...]]
const GENERIC_TAG_RE = /\[\[\s*[a-z_]+(?:\s*:\s*[^\]\n]*)?\s*\]\]/gi;

/**
 * 规范化空白字符
 */
function normalizeWhitespace(text: string): string {
  return text
    .replace(/[ \t]+/g, " ")
    .replace(/[ \t]*\n[ \t]*/g, "\n")
    .trim();
}

/**
 * 清理文本中的指令标记
 * @param text - 原始文本
 * @returns 清理后的文本
 */
export function stripDirectiveTags(text: string): string {
  if (!text) {
    return "";
  }

  let cleaned = text;

  // 移除 audio 标记
  cleaned = cleaned.replace(AUDIO_TAG_RE, " ");

  // 移除 reply 标记
  cleaned = cleaned.replace(REPLY_TAG_RE, " ");

  // 移除其他 [[...]] 格式的标记（作为兜底）
  cleaned = cleaned.replace(GENERIC_TAG_RE, " ");

  return normalizeWhitespace(cleaned);
}

/**
 * 检查文本是否只包含指令标记（没有实际内容）
 * @param text - 原始文本
 * @returns 是否只有标记
 */
export function isOnlyDirectiveTags(text: string): boolean {
  if (!text) {
    return true;
  }
  const cleaned = stripDirectiveTags(text);
  return !cleaned || cleaned.length === 0;
}
