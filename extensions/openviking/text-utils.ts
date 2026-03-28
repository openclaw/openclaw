import type { CaptureMode } from "./client.js";

export const MEMORY_TRIGGERS = [
  /remember|preference|prefer|important|decision|decided|always|never/i,
  /记住|偏好|喜欢|喜爱|崇拜|讨厌|害怕|重要|决定|总是|永远|优先|习惯|爱好|擅长|最爱|不喜欢/i,
  /[\w.-]+@[\w.-]+\.\w+/,
  /\+\d{10,}/,
  /(?:我|my)\s*(?:是|叫|名字|name|住在|live|来自|from|生日|birthday|电话|phone|邮箱|email)/i,
  /(?:我|i)\s*(?:喜欢|崇拜|讨厌|害怕|擅长|不会|爱|恨|想要|需要|希望|觉得|认为|相信)/i,
  /(?:favorite|favourite|love|hate|enjoy|dislike|admire|idol|fan of)/i,
];

const CJK_CHAR_REGEX = /[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff\uac00-\ud7af]/;
const RELEVANT_MEMORIES_BLOCK_RE = /<relevant-memories>[\s\S]*?<\/relevant-memories>/gi;
const CONVERSATION_METADATA_BLOCK_RE =
  /(?:^|\n)\s*(?:Conversation info|Conversation metadata|会话信息|对话信息)\s*(?:\([^)]+\))?\s*:\s*```[\s\S]*?```/gi;
/** Strips "Sender (untrusted metadata): ```json ... ```" so capture sends clean text to OpenViking extract. */
const SENDER_METADATA_BLOCK_RE = /Sender\s*\([^)]*\)\s*:\s*```[\s\S]*?```/gi;
const FENCED_JSON_BLOCK_RE = /```json\s*([\s\S]*?)```/gi;
const METADATA_JSON_KEY_RE =
  /"(session|sessionid|sessionkey|conversationid|channel|sender|userid|agentid|timestamp|timezone)"\s*:/gi;
const LEADING_TIMESTAMP_PREFIX_RE = /^\s*\[[^\]\n]{1,120}\]\s*/;
const COMMAND_TEXT_RE = /^\/[a-z0-9_-]{1,64}\b/i;
const NON_CONTENT_TEXT_RE = /^[\p{P}\p{S}\s]+$/u;
const SUBAGENT_CONTEXT_RE = /^\s*\[Subagent Context\]/i;
const MEMORY_INTENT_RE = /记住|记下|remember|save|store|偏好|preference|规则|rule|事实|fact/i;
const QUESTION_CUE_RE =
  /[?？]|\b(?:what|when|where|who|why|how|which|can|could|would|did|does|is|are)\b|^(?:请问|能否|可否|怎么|如何|什么时候|谁|什么|哪|是否)/i;
const SPEAKER_TAG_RE = /(?:^|\s)([A-Za-z\u4e00-\u9fa5][A-Za-z0-9_\u4e00-\u9fa5-]{1,30}):\s/g;

export const CAPTURE_LIMIT = 3;

function resolveCaptureMinLength(text: string): number {
  return CJK_CHAR_REGEX.test(text) ? 4 : 10;
}

function looksLikeMetadataJsonBlock(content: string): boolean {
  const matchedKeys = new Set<string>();
  const matches = content.matchAll(METADATA_JSON_KEY_RE);
  for (const match of matches) {
    const key = (match[1] ?? "").toLowerCase();
    if (key) {
      matchedKeys.add(key);
    }
  }
  return matchedKeys.size >= 3;
}

export function sanitizeUserTextForCapture(text: string): string {
  return text
    .replace(RELEVANT_MEMORIES_BLOCK_RE, " ")
    .replace(CONVERSATION_METADATA_BLOCK_RE, " ")
    .replace(SENDER_METADATA_BLOCK_RE, " ")
    .replace(FENCED_JSON_BLOCK_RE, (full, inner) =>
      looksLikeMetadataJsonBlock(String(inner ?? "")) ? " " : full,
    )
    .replace(LEADING_TIMESTAMP_PREFIX_RE, "")
    .replace(/\u0000/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function looksLikeQuestionOnlyText(text: string): boolean {
  if (!QUESTION_CUE_RE.test(text) || MEMORY_INTENT_RE.test(text)) {
    return false;
  }
  // Multi-speaker transcripts often contain many "?" but should still be captured.
  const speakerTags = text.match(/[A-Za-z\u4e00-\u9fa5]{2,20}:\s/g) ?? [];
  if (speakerTags.length >= 2 || text.length > 280) {
    return false;
  }
  return true;
}

export type TranscriptLikeIngestDecision = {
  shouldAssist: boolean;
  reason: string;
  normalizedText: string;
  speakerTurns: number;
  chars: number;
};

function countSpeakerTurns(text: string): number {
  let count = 0;
  for (const _match of text.matchAll(SPEAKER_TAG_RE)) {
    count += 1;
  }
  return count;
}

export function isTranscriptLikeIngest(
  text: string,
  options: {
    minSpeakerTurns: number;
    minChars: number;
  },
): TranscriptLikeIngestDecision {
  const normalizedText = sanitizeUserTextForCapture(text.trim());
  if (!normalizedText) {
    return {
      shouldAssist: false,
      reason: "empty_text",
      normalizedText,
      speakerTurns: 0,
      chars: 0,
    };
  }

  if (COMMAND_TEXT_RE.test(normalizedText)) {
    return {
      shouldAssist: false,
      reason: "command_text",
      normalizedText,
      speakerTurns: 0,
      chars: normalizedText.length,
    };
  }

  if (SUBAGENT_CONTEXT_RE.test(normalizedText)) {
    return {
      shouldAssist: false,
      reason: "subagent_context",
      normalizedText,
      speakerTurns: 0,
      chars: normalizedText.length,
    };
  }

  if (NON_CONTENT_TEXT_RE.test(normalizedText)) {
    return {
      shouldAssist: false,
      reason: "non_content_text",
      normalizedText,
      speakerTurns: 0,
      chars: normalizedText.length,
    };
  }

  if (looksLikeQuestionOnlyText(normalizedText)) {
    return {
      shouldAssist: false,
      reason: "question_text",
      normalizedText,
      speakerTurns: 0,
      chars: normalizedText.length,
    };
  }

  const chars = normalizedText.length;
  if (chars < options.minChars) {
    return {
      shouldAssist: false,
      reason: "chars_below_threshold",
      normalizedText,
      speakerTurns: 0,
      chars,
    };
  }

  const speakerTurns = countSpeakerTurns(normalizedText);
  if (speakerTurns < options.minSpeakerTurns) {
    return {
      shouldAssist: false,
      reason: "speaker_turns_below_threshold",
      normalizedText,
      speakerTurns,
      chars,
    };
  }

  return {
    shouldAssist: true,
    reason: "transcript_like_ingest",
    normalizedText,
    speakerTurns,
    chars,
  };
}

function normalizeDedupeText(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

function normalizeCaptureDedupeText(text: string): string {
  return normalizeDedupeText(text).replace(/[\p{P}\p{S}]+/gu, " ").replace(/\s+/g, " ").trim();
}

export function pickRecentUniqueTexts(texts: string[], limit: number): string[] {
  if (limit <= 0 || texts.length === 0) {
    return [];
  }
  const seen = new Set<string>();
  const picked: string[] = [];
  for (let i = texts.length - 1; i >= 0; i -= 1) {
    const text = texts[i];
    const key = normalizeCaptureDedupeText(text);
    if (!key || seen.has(key)) {
      continue;
    }
    seen.add(key);
    picked.push(text);
    if (picked.length >= limit) {
      break;
    }
  }
  return picked.reverse();
}

export function getCaptureDecision(text: string, mode: CaptureMode, captureMaxLength: number): {
  shouldCapture: boolean;
  reason: string;
  normalizedText: string;
} {
  const trimmed = text.trim();
  const normalizedText = sanitizeUserTextForCapture(trimmed);
  const hadSanitization = normalizedText !== trimmed;
  if (!normalizedText) {
    return {
      shouldCapture: false,
      reason: /<relevant-memories>/i.test(trimmed) ? "injected_memory_context_only" : "empty_text",
      normalizedText: "",
    };
  }

  const compactText = normalizedText.replace(/\s+/g, "");
  const minLength = resolveCaptureMinLength(compactText);
  if (compactText.length < minLength || normalizedText.length > captureMaxLength) {
    return {
      shouldCapture: false,
      reason: "length_out_of_range",
      normalizedText,
    };
  }

  if (COMMAND_TEXT_RE.test(normalizedText)) {
    return {
      shouldCapture: false,
      reason: "command_text",
      normalizedText,
    };
  }

  if (NON_CONTENT_TEXT_RE.test(normalizedText)) {
    return {
      shouldCapture: false,
      reason: "non_content_text",
      normalizedText,
    };
  }
  if (SUBAGENT_CONTEXT_RE.test(normalizedText)) {
    return {
      shouldCapture: false,
      reason: "subagent_context",
      normalizedText,
    };
  }
  if (looksLikeQuestionOnlyText(normalizedText)) {
    return {
      shouldCapture: false,
      reason: "question_text",
      normalizedText,
    };
  }

  if (mode === "keyword") {
    for (const trigger of MEMORY_TRIGGERS) {
      if (trigger.test(normalizedText)) {
        return {
          shouldCapture: true,
          reason: hadSanitization
            ? `matched_trigger_after_sanitize:${trigger.toString()}`
            : `matched_trigger:${trigger.toString()}`,
          normalizedText,
        };
      }
    }
    return {
      shouldCapture: false,
      reason: hadSanitization ? "no_trigger_matched_after_sanitize" : "no_trigger_matched",
      normalizedText,
    };
  }

  return {
    shouldCapture: true,
    reason: hadSanitization ? "semantic_candidate_after_sanitize" : "semantic_candidate",
    normalizedText,
  };
}

export function extractTextsFromUserMessages(messages: unknown[]): string[] {
  const texts: string[] = [];
  for (const msg of messages) {
    if (!msg || typeof msg !== "object") {
      continue;
    }
    const msgObj = msg as Record<string, unknown>;
    if (msgObj.role !== "user") {
      continue;
    }
    const content = msgObj.content;
    if (typeof content === "string") {
      texts.push(content);
      continue;
    }
    if (Array.isArray(content)) {
      for (const block of content) {
        if (!block || typeof block !== "object") {
          continue;
        }
        const blockObj = block as Record<string, unknown>;
        if (blockObj.type === "text" && typeof blockObj.text === "string") {
          texts.push(blockObj.text);
        }
      }
    }
  }
  return texts;
}

function formatToolUseBlock(b: Record<string, unknown>): string {
  const name = typeof b.name === "string" ? b.name : "unknown";
  let inputStr = "";
  if (b.input !== undefined && b.input !== null) {
    try {
      inputStr = typeof b.input === "string" ? b.input : JSON.stringify(b.input);
    } catch {
      inputStr = String(b.input);
    }
  }
  return inputStr
    ? `[toolUse: ${name}]\n${inputStr}`
    : `[toolUse: ${name}]`;
}

function formatToolResultContent(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      const b = block as Record<string, unknown>;
      if (b?.type === "text" && typeof b.text === "string") {
        parts.push((b.text as string).trim());
      }
    }
    return parts.join("\n");
  }
  if (content !== undefined && content !== null) {
    try {
      return JSON.stringify(content);
    } catch {
      return String(content);
    }
  }
  return "";
}

/**
 * 提取从 startIndex 开始的新消息（user + assistant + toolResult），返回格式化的文本。
 * 保留 toolUse 完整内容（tool name + input）和 toolResult 完整内容，
 * 跳过 system 消息（框架注入的元数据）。
 */
export function extractNewTurnTexts(
  messages: unknown[],
  startIndex: number,
): { texts: string[]; newCount: number } {
  const texts: string[] = [];
  let count = 0;
  for (let i = startIndex; i < messages.length; i++) {
    const msg = messages[i] as Record<string, unknown>;
    if (!msg || typeof msg !== "object") continue;
    const role = msg.role as string;
    if (!role || role === "system") continue;
    count++;

    if (role === "toolResult") {
      const toolName = typeof msg.toolName === "string" ? msg.toolName : "tool";
      const resultText = formatToolResultContent(msg.content);
      if (resultText) {
        texts.push(`[${toolName} result]: ${resultText}`);
      }
      continue;
    }

    const content = msg.content;
    if (typeof content === "string" && content.trim()) {
      texts.push(`[${role}]: ${content.trim()}`);
    } else if (Array.isArray(content)) {
      for (const block of content) {
        const b = block as Record<string, unknown>;
        if (b?.type === "text" && typeof b.text === "string") {
          texts.push(`[${role}]: ${(b.text as string).trim()}`);
        } else if (b?.type === "toolUse") {
          texts.push(`[${role}]: ${formatToolUseBlock(b)}`);
        }
      }
    }
  }
  return { texts, newCount: count };
}

export function extractLatestUserText(messages: unknown[] | undefined): string {
  if (!messages || messages.length === 0) {
    return "";
  }
  const texts = extractTextsFromUserMessages(messages);
  for (let i = texts.length - 1; i >= 0; i -= 1) {
    const normalized = sanitizeUserTextForCapture(texts[i] ?? "");
    if (normalized) {
      return normalized;
    }
  }
  return "";
}
