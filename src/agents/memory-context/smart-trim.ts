/**
 * Smart Trim -- three-layer context trimming for Phase 6.
 *
 * Layer 1: Protected messages (never trimmed)
 * Layer 2: BM25 relevance-based trimming (low relevance first)
 * Layer 3: Time-order fallback trimming (oldest first)
 *
 * After trimming, sanitizes tool_use/toolResult pairing.
 */

import { BM25Index } from "./bm25.js";
import { RECALLED_CONTEXT_MARKER, extractText } from "./shared.js";

export type MessageLike = {
  role?: string;
  content?: unknown;
  id?: string;
};

export type SmartTrimConfig = {
  protectedRecent: number;
  safeLimit: number;
  estimateTokens: (msg: MessageLike) => number;
};

export type SmartTrimResult = {
  kept: MessageLike[];
  trimmed: MessageLike[];
  didTrim: boolean;
};

// extractText imported from shared.ts

export function isRecalledContext(msg: MessageLike): boolean {
  return extractText(msg).includes(RECALLED_CONTEXT_MARKER);
}

// Pi framework may use "toolUse" / "toolCall" / "functionCall" in addition to
// the Anthropic-native "tool_use". We must recognise all variants to avoid
// leaving orphaned tool_results after trimming.
const TOOL_CALL_TYPES = new Set(["tool_use", "toolUse", "toolCall", "functionCall"]);

function hasToolUse(msg: MessageLike): boolean {
  if (msg.role !== "assistant") {
    return false;
  }
  if (Array.isArray(msg.content)) {
    return (msg.content as Array<{ type?: string }>).some(
      (b) => typeof b?.type === "string" && TOOL_CALL_TYPES.has(b.type),
    );
  }
  return false;
}

function isToolResult(msg: MessageLike): boolean {
  return msg.role === "toolResult" || msg.role === "tool";
}

function isCompactionSummary(msg: MessageLike, idx: number, messages: MessageLike[]): boolean {
  // Compaction summary is typically the first assistant/user message after system prompt
  if (idx === 0) {
    return false;
  }
  if (idx > 2) {
    return false;
  } // Summary is always near the beginning
  const prevRole = messages[idx - 1]?.role;
  if (prevRole !== "system" && idx !== 1) {
    return false;
  }
  const text = extractText(msg);
  // Heuristic: contains file operation tags or summary markers
  return (
    text.includes("<read-files>") ||
    text.includes("<modified-files>") ||
    text.includes("Summary unavailable") ||
    text.includes("Turn Context")
  );
}

function markProtected(messages: MessageLike[], protectedRecent: number): Set<number> {
  const s = new Set<number>();
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role === "system") {
      s.add(i);
    }
    if (isRecalledContext(messages[i])) {
      s.add(i);
    }
    if (isCompactionSummary(messages[i], i, messages)) {
      s.add(i);
    }
  }
  let count = 0;
  for (let i = messages.length - 1; i >= 0 && count < protectedRecent; i--) {
    const r = messages[i].role;
    if (r === "user" || r === "assistant") {
      s.add(i);
      count++;
    }
  }
  // Protect last complete tool-call span
  for (let i = messages.length - 1; i >= 0; i--) {
    if (hasToolUse(messages[i])) {
      s.add(i);
      for (let j = i + 1; j < messages.length; j++) {
        if (isToolResult(messages[j])) {
          s.add(j);
        } else {
          break;
        }
      }
      break;
    }
  }
  return s;
}

function relevanceTrim(
  messages: MessageLike[],
  protectedSet: Set<number>,
  query: string,
  config: SmartTrimConfig,
): { kept: number[]; trimmed: number[] } {
  const bm25 = new BM25Index();
  const candidates: Array<{ idx: number }> = [];
  for (let i = 0; i < messages.length; i++) {
    if (protectedSet.has(i)) {
      continue;
    }
    const text = extractText(messages[i]);
    if (!text.trim()) {
      continue;
    }
    bm25.add(`msg-${i}`, text);
    candidates.push({ idx: i });
  }
  if (candidates.length === 0) {
    return { kept: Array.from({ length: messages.length }, (_, i) => i), trimmed: [] };
  }
  const scores = bm25.search(query, candidates.length);
  const scoreMap = new Map(scores.map((s) => [s.id, s.score]));
  const sorted = [...candidates].toSorted((a, b) => {
    return (scoreMap.get(`msg-${a.idx}`) ?? 0) - (scoreMap.get(`msg-${b.idx}`) ?? 0);
  });
  let totalTokens = 0;
  for (let i = 0; i < messages.length; i++) {
    totalTokens += config.estimateTokens(messages[i]);
  }
  const trimmedIndices: number[] = [];
  for (const c of sorted) {
    if (totalTokens <= config.safeLimit) {
      break;
    }
    trimmedIndices.push(c.idx);
    totalTokens -= config.estimateTokens(messages[c.idx]);
  }
  const trimSet = new Set(trimmedIndices);
  return {
    kept: Array.from({ length: messages.length }, (_, i) => i).filter((i) => !trimSet.has(i)),
    trimmed: trimmedIndices,
  };
}

function timeOrderTrim(
  messages: MessageLike[],
  keptIndices: number[],
  protectedSet: Set<number>,
  config: SmartTrimConfig,
): { kept: number[]; trimmed: number[] } {
  let totalTokens = 0;
  for (const i of keptIndices) {
    totalTokens += config.estimateTokens(messages[i]);
  }
  if (totalTokens <= config.safeLimit) {
    const keptSet = new Set(keptIndices);
    return {
      kept: keptIndices,
      trimmed: Array.from({ length: messages.length }, (_, i) => i).filter((i) => !keptSet.has(i)),
    };
  }
  const keptSet = new Set(keptIndices);
  for (const i of keptIndices) {
    if (totalTokens <= config.safeLimit) {
      break;
    }
    if (protectedSet.has(i)) {
      continue;
    }
    keptSet.delete(i);
    totalTokens -= config.estimateTokens(messages[i]);
  }
  return {
    kept: keptIndices.filter((i) => keptSet.has(i)),
    trimmed: Array.from({ length: messages.length }, (_, i) => i).filter((i) => !keptSet.has(i)),
  };
}

function sanitizeToolPairing(messages: MessageLike[], keptIndices: number[]): number[] {
  const keptSet = new Set(keptIndices);
  for (let i = 0; i < messages.length; i++) {
    if (!keptSet.has(i)) {
      continue;
    }
    if (hasToolUse(messages[i])) {
      for (let j = i + 1; j < messages.length; j++) {
        if (isToolResult(messages[j])) {
          if (!keptSet.has(j)) {
            keptSet.delete(i);
            break;
          }
        } else {
          break;
        }
      }
    }
    if (isToolResult(messages[i])) {
      for (let j = i - 1; j >= 0; j--) {
        if (hasToolUse(messages[j])) {
          if (!keptSet.has(j)) {
            keptSet.delete(i);
          }
          break;
        }
        if (!isToolResult(messages[j])) {
          break;
        }
      }
    }
  }
  return keptIndices.filter((i) => keptSet.has(i));
}

export function smartTrim(
  messages: MessageLike[],
  query: string,
  config: SmartTrimConfig,
): SmartTrimResult {
  let totalTokens = 0;
  for (const msg of messages) {
    totalTokens += config.estimateTokens(msg);
  }
  if (totalTokens <= config.safeLimit) {
    return { kept: messages, trimmed: [], didTrim: false };
  }
  const protectedSet = markProtected(messages, config.protectedRecent);
  const { kept: afterRelevance } = relevanceTrim(messages, protectedSet, query, config);
  const { kept: afterTimeOrder } = timeOrderTrim(messages, afterRelevance, protectedSet, config);
  const sanitized = sanitizeToolPairing(messages, afterTimeOrder);
  const keptSet = new Set(sanitized);
  const kept = sanitized.map((i) => messages[i]);
  const trimmed: MessageLike[] = [];
  for (let i = 0; i < messages.length; i++) {
    if (!keptSet.has(i) && !isRecalledContext(messages[i])) {
      trimmed.push(messages[i]);
    }
  }
  return { kept, trimmed, didTrim: true };
}
