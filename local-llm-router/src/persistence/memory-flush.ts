/**
 * Pre-compaction memory flush.
 * Adapted from OpenClaw src/auto-reply/reply/memory-flush.ts
 *
 * Before the context window is compacted, trigger a silent turn
 * that tells the agent to write durable memories to disk.
 */

export const SILENT_REPLY_TOKEN = "[SILENT]";

export const DEFAULT_MEMORY_FLUSH_SOFT_TOKENS = 4000;
export const DEFAULT_RESERVE_TOKENS_FLOOR = 8000;

export const DEFAULT_MEMORY_FLUSH_PROMPT = [
  "Pre-compaction memory flush.",
  "Store durable memories now (use memory/YYYY-MM-DD.md; create memory/ if needed).",
  `If nothing to store, reply with ${SILENT_REPLY_TOKEN}.`,
].join(" ");

export const DEFAULT_MEMORY_FLUSH_SYSTEM_PROMPT = [
  "Pre-compaction memory flush turn.",
  "The session is near auto-compaction; capture durable memories to disk.",
  `You may reply, but usually ${SILENT_REPLY_TOKEN} is correct.`,
].join(" ");

export interface MemoryFlushSettings {
  enabled: boolean;
  softThresholdTokens: number;
  prompt: string;
  systemPrompt: string;
  reserveTokensFloor: number;
}

function normalizeNonNegativeInt(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  const int = Math.floor(value);
  return int >= 0 ? int : null;
}

export function resolveMemoryFlushSettings(config?: {
  enabled?: boolean;
  softThresholdTokens?: number;
  prompt?: string;
  systemPrompt?: string;
  reserveTokensFloor?: number;
}): MemoryFlushSettings | null {
  const enabled = config?.enabled ?? true;
  if (!enabled) {
    return null;
  }

  const softThresholdTokens =
    normalizeNonNegativeInt(config?.softThresholdTokens) ??
    DEFAULT_MEMORY_FLUSH_SOFT_TOKENS;

  const prompt = config?.prompt?.trim() || DEFAULT_MEMORY_FLUSH_PROMPT;
  const systemPrompt =
    config?.systemPrompt?.trim() || DEFAULT_MEMORY_FLUSH_SYSTEM_PROMPT;
  const reserveTokensFloor =
    normalizeNonNegativeInt(config?.reserveTokensFloor) ??
    DEFAULT_RESERVE_TOKENS_FLOOR;

  return {
    enabled,
    softThresholdTokens,
    prompt: ensureSilentHint(prompt),
    systemPrompt: ensureSilentHint(systemPrompt),
    reserveTokensFloor,
  };
}

function ensureSilentHint(text: string): string {
  if (text.includes(SILENT_REPLY_TOKEN)) {
    return text;
  }
  return `${text}\n\nIf no user-visible reply is needed, start with ${SILENT_REPLY_TOKEN}.`;
}

/**
 * Should we run a memory flush before the next compaction?
 */
export function shouldRunMemoryFlush(params: {
  totalTokens?: number;
  compactionCount?: number;
  lastFlushAtCompaction?: number;
  contextWindowTokens: number;
  reserveTokensFloor: number;
  softThresholdTokens: number;
}): boolean {
  const totalTokens = params.totalTokens;
  if (!totalTokens || totalTokens <= 0) {
    return false;
  }

  const contextWindow = Math.max(1, Math.floor(params.contextWindowTokens));
  const reserveTokens = Math.max(0, Math.floor(params.reserveTokensFloor));
  const softThreshold = Math.max(0, Math.floor(params.softThresholdTokens));
  const threshold = Math.max(0, contextWindow - reserveTokens - softThreshold);

  if (threshold <= 0) {
    return false;
  }
  if (totalTokens < threshold) {
    return false;
  }

  // Don't flush twice for the same compaction cycle
  const compactionCount = params.compactionCount ?? 0;
  const lastFlushAt = params.lastFlushAtCompaction;
  if (typeof lastFlushAt === "number" && lastFlushAt === compactionCount) {
    return false;
  }

  return true;
}
