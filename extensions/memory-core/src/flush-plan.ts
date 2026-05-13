import {
  DEFAULT_PI_COMPACTION_RESERVE_TOKENS_FLOOR,
  parseNonNegativeByteSize,
  resolveCronStyleNow,
  SILENT_REPLY_TOKEN,
  type MemoryFlushPlan,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/memory-core-host-runtime-core";

export const DEFAULT_MEMORY_FLUSH_SOFT_TOKENS = 4000;
export const DEFAULT_MEMORY_FLUSH_SOFT_TOKENS_MAX = 900_000;
export const DEFAULT_MEMORY_FLUSH_FORCE_TRANSCRIPT_BYTES = 2 * 1024 * 1024;

/**
 * Default `softThresholdTokens` headroom buffer used when the operator did
 * not pick a value in `agents.defaults.compaction.memoryFlush.softThresholdTokens`.
 *
 * History: prior to v2026.5.x this was a hard-coded 4000 regardless of model
 * context window. On 1M-token models that left the flush trigger at ~99.6% of
 * the window, so a bot with a long-lived session would skip pre-compaction
 * flushes and arrive at the auto-compaction boundary with nothing persisted —
 * producing the "bot turns slow over days" symptom (a fully resident, near-full
 * prompt). Workspace operators had to manually set `softThresholdTokens` to a
 * very large number (e.g. 900_000) to force eager pre-compaction flushing.
 *
 * The window-aware default keeps the legacy 4000 floor for small models and
 * grows the buffer with the window, capped at 900_000 to stay within the
 * upper bound operators already use as a manual override.
 *
 * Callers that cannot resolve the model context window (e.g. control-plane
 * tooling building a plan for documentation purposes) should omit the param;
 * we'll keep the legacy 4000 default in that path.
 */
export function defaultMemoryFlushSoftThresholdTokens(
  modelContextWindowTokens?: number,
): number {
  if (
    typeof modelContextWindowTokens !== "number" ||
    !Number.isFinite(modelContextWindowTokens) ||
    modelContextWindowTokens <= 0
  ) {
    return DEFAULT_MEMORY_FLUSH_SOFT_TOKENS;
  }
  const auto = Math.floor(modelContextWindowTokens * 0.7);
  if (auto <= DEFAULT_MEMORY_FLUSH_SOFT_TOKENS) {
    return DEFAULT_MEMORY_FLUSH_SOFT_TOKENS;
  }
  return Math.min(auto, DEFAULT_MEMORY_FLUSH_SOFT_TOKENS_MAX);
}

const MEMORY_FLUSH_TARGET_HINT =
  "Store durable memories only in memory/YYYY-MM-DD.md (create memory/ if needed).";
const MEMORY_FLUSH_APPEND_ONLY_HINT =
  "If memory/YYYY-MM-DD.md already exists, APPEND new content only and do not overwrite existing entries.";
const MEMORY_FLUSH_READ_ONLY_HINT =
  "Treat workspace bootstrap/reference files such as MEMORY.md, DREAMS.md, SOUL.md, TOOLS.md, and AGENTS.md as read-only during this flush; never overwrite, replace, or edit them.";
const MEMORY_FLUSH_REQUIRED_HINTS = [
  MEMORY_FLUSH_TARGET_HINT,
  MEMORY_FLUSH_APPEND_ONLY_HINT,
  MEMORY_FLUSH_READ_ONLY_HINT,
];

export const DEFAULT_MEMORY_FLUSH_PROMPT = [
  "Pre-compaction memory flush.",
  MEMORY_FLUSH_TARGET_HINT,
  MEMORY_FLUSH_READ_ONLY_HINT,
  MEMORY_FLUSH_APPEND_ONLY_HINT,
  "Do NOT create timestamped variant files (e.g., YYYY-MM-DD-HHMM.md); always use the canonical YYYY-MM-DD.md filename.",
  `If nothing to store, reply with ${SILENT_REPLY_TOKEN}.`,
].join(" ");

const DEFAULT_MEMORY_FLUSH_SYSTEM_PROMPT = [
  "Pre-compaction memory flush turn.",
  "The session is near auto-compaction; capture durable memories to disk.",
  MEMORY_FLUSH_TARGET_HINT,
  MEMORY_FLUSH_READ_ONLY_HINT,
  MEMORY_FLUSH_APPEND_ONLY_HINT,
  `You may reply, but usually ${SILENT_REPLY_TOKEN} is correct.`,
].join(" ");

function formatDateStampInTimezone(nowMs: number, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(nowMs));
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;
  if (year && month && day) {
    return `${year}-${month}-${day}`;
  }
  return new Date(nowMs).toISOString().slice(0, 10);
}

function normalizeNonNegativeInt(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  const int = Math.floor(value);
  return int >= 0 ? int : null;
}

function ensureNoReplyHint(text: string): string {
  if (text.includes(SILENT_REPLY_TOKEN)) {
    return text;
  }
  return `${text}\n\nIf no user-visible reply is needed, start with ${SILENT_REPLY_TOKEN}.`;
}

function ensureMemoryFlushSafetyHints(text: string): string {
  let next = text.trim();
  for (const hint of MEMORY_FLUSH_REQUIRED_HINTS) {
    if (!next.includes(hint)) {
      next = next ? `${next}\n\n${hint}` : hint;
    }
  }
  return next;
}

function appendCurrentTimeLine(text: string, timeLine: string): string {
  const trimmed = text.trimEnd();
  if (!trimmed) {
    return timeLine;
  }
  if (trimmed.includes("Current time:")) {
    return trimmed;
  }
  return `${trimmed}\n${timeLine}`;
}

export function buildMemoryFlushPlan(
  params: {
    cfg?: OpenClawConfig;
    nowMs?: number;
    /**
     * Resolved model context window in tokens for the caller's run. Optional;
     * when present we scale the default `softThresholdTokens` to keep the flush
     * trigger at a sensible buffer below the window for large-window models.
     * See {@link defaultMemoryFlushSoftThresholdTokens}.
     *
     * Always honored as an *override hint*: an explicit operator-set
     * `agents.defaults.compaction.memoryFlush.softThresholdTokens` still wins.
     */
    modelContextWindowTokens?: number;
  } = {},
): MemoryFlushPlan | null {
  const resolved = params;
  const nowMs = Number.isFinite(resolved.nowMs) ? (resolved.nowMs as number) : Date.now();
  const cfg = resolved.cfg;
  const defaults = cfg?.agents?.defaults?.compaction?.memoryFlush;
  if (defaults?.enabled === false) {
    return null;
  }

  const softThresholdTokens =
    normalizeNonNegativeInt(defaults?.softThresholdTokens) ??
    defaultMemoryFlushSoftThresholdTokens(resolved.modelContextWindowTokens);
  const forceFlushTranscriptBytes =
    parseNonNegativeByteSize(defaults?.forceFlushTranscriptBytes) ??
    DEFAULT_MEMORY_FLUSH_FORCE_TRANSCRIPT_BYTES;
  const reserveTokensFloor =
    normalizeNonNegativeInt(cfg?.agents?.defaults?.compaction?.reserveTokensFloor) ??
    DEFAULT_PI_COMPACTION_RESERVE_TOKENS_FLOOR;

  const { timeLine, userTimezone } = resolveCronStyleNow(cfg ?? {}, nowMs);
  const dateStamp = formatDateStampInTimezone(nowMs, userTimezone);
  const relativePath = `memory/${dateStamp}.md`;

  const promptBase = ensureNoReplyHint(
    ensureMemoryFlushSafetyHints(defaults?.prompt?.trim() || DEFAULT_MEMORY_FLUSH_PROMPT),
  );
  const systemPrompt = ensureNoReplyHint(
    ensureMemoryFlushSafetyHints(
      defaults?.systemPrompt?.trim() || DEFAULT_MEMORY_FLUSH_SYSTEM_PROMPT,
    ),
  );

  return {
    softThresholdTokens,
    forceFlushTranscriptBytes,
    reserveTokensFloor,
    model: defaults?.model?.trim() || undefined,
    prompt: appendCurrentTimeLine(promptBase.replaceAll("YYYY-MM-DD", dateStamp), timeLine),
    systemPrompt: systemPrompt.replaceAll("YYYY-MM-DD", dateStamp),
    relativePath,
  };
}
