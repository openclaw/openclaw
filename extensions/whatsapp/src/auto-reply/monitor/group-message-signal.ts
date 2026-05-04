import {
  classifyWhatsAppEmotionPulse,
  type WhatsAppEmotionPulseDecision,
} from "../../emotion-pulse.js";
import type { GroupHistoryEntry } from "./inbound-context.js";

export type GroupMessageSignalState = "normal" | "low_signal_burst" | "casual_vibe";

export type GroupMessageSignalDecision = {
  state: GroupMessageSignalState;
  reason: string;
  maxReplyLines?: number;
  emotionPulse?: WhatsAppEmotionPulseDecision;
  debug: {
    scope: "direct" | "bot_bros" | "other_group";
    depthRequested?: boolean;
    currentLowSignal?: boolean;
    recentShortCount?: number;
    recentWindowSeconds?: number;
    wordCount?: number;
    charCount?: number;
    emojiOnly?: boolean;
    repetitive?: boolean;
    substantiveTask?: boolean;
    emotionPulseId?: WhatsAppEmotionPulseDecision["id"];
    emotionCarrier?: WhatsAppEmotionPulseDecision["carrier"];
    emotionIntensity?: WhatsAppEmotionPulseDecision["intensity"];
  };
};

const BOT_BROS_GROUP_IDS = new Set(["120363406331109499@g.us"]);
const LOW_SIGNAL_RECENT_WINDOW_MS = 2 * 60 * 1000;
const LOW_SIGNAL_RECENT_THRESHOLD = 3;

const DEPTH_REQUEST_RE =
  /\b(?:go\s+deep|deep\s+dive|in\s+depth|explain|break\s+(?:it|this|that)\s+down|full\s+(?:take|analysis|breakdown)|essay|details?|detailed|thorough|research|investigate|summari[sz]e|analy[sz]e)\b/i;

const SUBSTANTIVE_TASK_RE =
  /\b(?:summari[sz]e|analy[sz]e|explain|investigate|research|review|compare|calculate|draft|write|build|fix|debug|search|find|pull|make|create|generate|send)\b/i;

const LOW_SIGNAL_MARKER_RE =
  /^(?:l+o+l+|lmao+|lmfao+|haha+|hehe+|bruh+|bro+|nah+|no+|yes+|yea+h*|ok+|okay+|k+|huh+|wtf+|damn+|insane+|wild+|real+|true+|fr+|fax+|test(?:ing)?|same+|done+|fair+|say\s+it|good+|crazy+|boogie+|best\s+believe)\b/i;

function cleanText(value: string | undefined | null): string {
  return (value ?? "")
    .normalize("NFKC")
    .replace(/[\u2018\u2019\u201B\u2032]/g, "'")
    .replace(/[\u200B-\u200F\u202A-\u202E]/g, "")
    .trim();
}

function normalizeLoose(value: string | undefined | null): string {
  return cleanText(value)
    .toLowerCase()
    .replace(/[_\s]+/g, " ");
}

function countWords(value: string): number {
  const matches = value.match(/[\p{L}\p{N}']+/gu);
  return matches?.length ?? 0;
}

function hasUrlOrCommand(value: string): boolean {
  return /(?:https?:\/\/|www\.)\S+/i.test(value) || /^\s*\/[a-z0-9_-]+/i.test(value);
}

function isEmojiOrPunctuationOnly(value: string): boolean {
  if (!value) {
    return false;
  }
  return !/[\p{L}\p{N}]/u.test(value) && value.replace(/\s/g, "").length <= 8;
}

function hasRepetitiveShape(value: string): boolean {
  const compact = value.toLowerCase().replace(/\s+/g, " ").trim();
  if (/(.)\1{4,}/u.test(compact)) {
    return true;
  }
  const words = compact.match(/[\p{L}\p{N}']+/gu) ?? [];
  if (words.length >= 3 && new Set(words).size === 1) {
    return true;
  }
  if (words.length >= 4 && words.every((word) => word.length === 1)) {
    return true;
  }
  return false;
}

function isBotBrosScope(params: {
  conversationId: string;
  groupSubject?: string;
  groupSystemPrompt?: string;
}): boolean {
  if (BOT_BROS_GROUP_IDS.has(params.conversationId)) {
    return true;
  }
  const subject = normalizeLoose(params.groupSubject);
  if (subject === "bot-bros" || subject === "bot bros") {
    return true;
  }
  const prompt = normalizeLoose(params.groupSystemPrompt);
  return (
    prompt.includes("bot-bros turn-taking protocol") ||
    prompt.includes("bot-bros turn ownership protocol")
  );
}

function normalizeTimestampMs(value: number | undefined): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  return value < 10_000_000_000 ? value * 1000 : value;
}

function analyzeText(value: string): {
  lowSignal: boolean;
  reason?: string;
  wordCount: number;
  charCount: number;
  emojiOnly: boolean;
  repetitive: boolean;
  substantiveTask: boolean;
} {
  const body = cleanText(value);
  const wordCount = countWords(body);
  const charCount = body.length;
  const emojiOnly = isEmojiOrPunctuationOnly(body);
  const repetitive = hasRepetitiveShape(body);
  const substantiveTask = SUBSTANTIVE_TASK_RE.test(body);

  if (!body || hasUrlOrCommand(body) || substantiveTask) {
    return { lowSignal: false, wordCount, charCount, emojiOnly, repetitive, substantiveTask };
  }
  if (emojiOnly) {
    return {
      lowSignal: true,
      reason: "emoji_or_punctuation_only",
      wordCount,
      charCount,
      emojiOnly,
      repetitive,
      substantiveTask,
    };
  }
  if (repetitive) {
    return {
      lowSignal: true,
      reason: "repetitive_short_text",
      wordCount,
      charCount,
      emojiOnly,
      repetitive,
      substantiveTask,
    };
  }
  if (LOW_SIGNAL_MARKER_RE.test(body) && charCount <= 80) {
    return {
      lowSignal: true,
      reason: "casual_low_signal_marker",
      wordCount,
      charCount,
      emojiOnly,
      repetitive,
      substantiveTask,
    };
  }
  if (wordCount > 0 && wordCount <= 6 && charCount <= 64 && !/[?]/u.test(body)) {
    return {
      lowSignal: true,
      reason: "short_banter_without_task",
      wordCount,
      charCount,
      emojiOnly,
      repetitive,
      substantiveTask,
    };
  }
  return { lowSignal: false, wordCount, charCount, emojiOnly, repetitive, substantiveTask };
}

function countRecentLowSignalHistory(params: {
  history: GroupHistoryEntry[];
  nowMs: number;
}): number {
  let count = 0;
  for (const entry of params.history.slice(-6)) {
    const timestampMs = normalizeTimestampMs(entry.timestamp);
    if (timestampMs !== undefined && params.nowMs - timestampMs > LOW_SIGNAL_RECENT_WINDOW_MS) {
      continue;
    }
    if (analyzeText(entry.body).lowSignal) {
      count += 1;
    }
  }
  return count;
}

function decision(
  state: GroupMessageSignalState,
  reason: string,
  debug: GroupMessageSignalDecision["debug"],
  emotionPulse?: WhatsAppEmotionPulseDecision,
): GroupMessageSignalDecision {
  return {
    state,
    reason,
    ...(state === "low_signal_burst" || state === "casual_vibe" ? { maxReplyLines: 2 } : {}),
    ...(emotionPulse ? { emotionPulse } : {}),
    debug,
  };
}

export function classifyWhatsAppGroupMessageSignal(params: {
  body: string;
  chatType: "direct" | "group";
  conversationId: string;
  groupHistory?: GroupHistoryEntry[];
  groupSubject?: string;
  groupSystemPrompt?: string;
  nowMs?: number;
}): GroupMessageSignalDecision {
  if (params.chatType !== "group") {
    return decision("normal", "direct_chat_unaffected", { scope: "direct" });
  }
  if (
    !isBotBrosScope({
      conversationId: params.conversationId,
      groupSubject: params.groupSubject,
      groupSystemPrompt: params.groupSystemPrompt,
    })
  ) {
    return decision("normal", "not_bot_bros_group", { scope: "other_group" });
  }

  const text = analyzeText(params.body);
  const depthRequested = DEPTH_REQUEST_RE.test(params.body);
  const emotionPulse = classifyWhatsAppEmotionPulse({
    body: params.body,
    lowSignal: text.lowSignal,
    substantiveTask: text.substantiveTask,
    depthRequested,
  });
  const nowMs = params.nowMs ?? normalizeTimestampMs(Date.now()) ?? Date.now();
  const recentShortCount = countRecentLowSignalHistory({
    history: params.groupHistory ?? [],
    nowMs,
  });
  const debug = {
    scope: "bot_bros" as const,
    depthRequested,
    currentLowSignal: text.lowSignal,
    recentShortCount,
    recentWindowSeconds: LOW_SIGNAL_RECENT_WINDOW_MS / 1000,
    wordCount: text.wordCount,
    charCount: text.charCount,
    emojiOnly: text.emojiOnly,
    repetitive: text.repetitive,
    substantiveTask: text.substantiveTask,
    emotionPulseId: emotionPulse.id,
    emotionCarrier: emotionPulse.carrier,
    emotionIntensity: emotionPulse.intensity,
  };

  if (depthRequested) {
    return decision("normal", "explicit_depth_request", debug, emotionPulse);
  }
  if (text.lowSignal) {
    return decision(
      "low_signal_burst",
      text.reason ?? "low_signal_current_message",
      debug,
      emotionPulse,
    );
  }
  if (recentShortCount >= LOW_SIGNAL_RECENT_THRESHOLD) {
    return decision("low_signal_burst", "recent_low_signal_burst", debug, emotionPulse);
  }
  if (cleanText(params.body) && !text.substantiveTask) {
    return decision("casual_vibe", "bot_bros_casual_vibe", debug, emotionPulse);
  }
  return decision("normal", "substantive_or_not_low_signal", debug, emotionPulse);
}
