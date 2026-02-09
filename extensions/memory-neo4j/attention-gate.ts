/**
 * Attention gate — lightweight heuristic filter (phase 1 of memory pipeline).
 *
 * Rejects obvious noise without any LLM call, analogous to how the brain's
 * sensory gating filters out irrelevant stimuli before they enter working
 * memory. Everything that passes gets stored; the sleep cycle decides what
 * matters.
 */

const NOISE_PATTERNS = [
  // Greetings / acknowledgments (exact match, with optional punctuation)
  /^(hi|hey|hello|yo|sup|ok|okay|sure|thanks|thank you|thx|ty|yep|yup|nope|no|yes|yeah|cool|nice|great|got it|sounds good|perfect|alright|fine|noted|ack|kk|k)\s*[.!?]*$/i,
  // Two-word affirmations: "ok great", "sounds good", "yes please", etc.
  /^(ok|okay|yes|yeah|yep|sure|no|nope|alright|right|fine|cool|nice|great)\s+(great|good|sure|thanks|please|ok|fine|cool|yeah|perfect|noted|absolutely|definitely|exactly)\s*[.!?]*$/i,
  // Deictic: messages that are only pronouns/articles/common verbs — no standalone meaning
  // e.g. "I need those", "let me do it", "ok let me test it out", "I got it"
  /^(ok[,.]?\s+)?(i('ll|'m|'d|'ve)?\s+)?(just\s+)?(need|want|got|have|let|let's|let me|give me|send|do|did|try|check|see|look at|test|take|get|go|use)\s+(it|that|this|those|these|them|some|one|the|a|an|me|him|her|us)\s*(out|up|now|then|too|again|later|first|here|there|please)?\s*[.!?]*$/i,
  // Short acknowledgments with trailing context: "ok, ..." / "yes, ..." when total is brief
  /^(ok|okay|yes|yeah|yep|sure|no|nope|right|alright|fine|cool|nice|great|perfect)[,.]?\s+.{0,20}$/i,
  // Conversational filler / noise phrases (standalone, with optional punctuation)
  /^(hmm+|huh|haha|ha|lol|lmao|rofl|nah|meh|idk|brb|ttyl|omg|wow|whoa|welp|oops|ooh|aah|ugh|bleh|pfft|smh|ikr|tbh|imo|fwiw|np|nvm|nm|wut|wat|wha|heh|tsk|sigh|yay|woo+|boo|dang|darn|geez|gosh|sheesh|oof)\s*[.!?]*$/i,
  // Single-word or near-empty
  /^\S{0,3}$/,
  // Pure emoji
  /^[\p{Emoji}\s]+$/u,
  // System/XML markup
  /^<[a-z-]+>[\s\S]*<\/[a-z-]+>$/i,

  // --- Session reset prompts (from /new and /reset commands) ---
  /^A new session was started via/i,

  // --- System infrastructure messages (never user-generated) ---
  // Heartbeat prompts
  /Read HEARTBEAT\.md if it exists/i,
  // Pre-compaction flush prompts
  /^Pre-compaction memory flush/i,
  // System timestamp messages (cron outputs, reminders, exec reports)
  /^System:\s*\[/i,
  // Cron job wrappers
  /^\[cron:[0-9a-f-]+/i,
  // Gateway restart JSON payloads
  /^GatewayRestart:\s*\{/i,
  // Background task completion reports
  /^\[\w{3}\s+\d{4}-\d{2}-\d{2}\s.*\]\s*A background task/i,
];

/** Maximum message length — code dumps, logs, etc. are not memories. */
const MAX_CAPTURE_CHARS = 2000;

/** Minimum message length — too short to be meaningful. */
const MIN_CAPTURE_CHARS = 30;

/** Minimum word count — short contextual phrases lack standalone meaning. */
const MIN_WORD_COUNT = 5;

export function passesAttentionGate(text: string): boolean {
  const trimmed = text.trim();

  // Length bounds
  if (trimmed.length < MIN_CAPTURE_CHARS || trimmed.length > MAX_CAPTURE_CHARS) {
    return false;
  }

  // Word count — short phrases ("I need those") lack context for recall
  const wordCount = trimmed.split(/\s+/).length;
  if (wordCount < MIN_WORD_COUNT) {
    return false;
  }

  // Injected context from the memory system itself
  if (trimmed.includes("<relevant-memories>") || trimmed.includes("<core-memory-refresh>")) {
    return false;
  }

  // Noise patterns
  if (NOISE_PATTERNS.some((r) => r.test(trimmed))) {
    return false;
  }

  // Excessive emoji (likely reaction, not substance)
  const emojiCount = (trimmed.match(/[\u{1F300}-\u{1F9FF}]/gu) || []).length;
  if (emojiCount > 3) {
    return false;
  }

  // Passes gate — retain for short-term storage
  return true;
}

// ============================================================================
// Assistant attention gate — stricter filter for assistant messages
// ============================================================================

/** Maximum assistant message length — shorter than user to avoid code dumps. */
const MAX_ASSISTANT_CAPTURE_CHARS = 1000;

/** Minimum word count for assistant messages — higher than user. */
const MIN_ASSISTANT_WORD_COUNT = 10;

export function passesAssistantAttentionGate(text: string): boolean {
  const trimmed = text.trim();

  // Length bounds (stricter than user)
  if (trimmed.length < MIN_CAPTURE_CHARS || trimmed.length > MAX_ASSISTANT_CAPTURE_CHARS) {
    return false;
  }

  // Word count — higher threshold than user messages
  const wordCount = trimmed.split(/\s+/).length;
  if (wordCount < MIN_ASSISTANT_WORD_COUNT) {
    return false;
  }

  // Reject messages that are mostly code (>50% inside triple-backtick fences)
  const codeBlockRegex = /```[\s\S]*?```/g;
  let codeChars = 0;
  let match: RegExpExecArray | null;
  while ((match = codeBlockRegex.exec(trimmed)) !== null) {
    codeChars += match[0].length;
  }
  if (codeChars > trimmed.length * 0.5) {
    return false;
  }

  // Reject messages that are mostly tool output
  if (
    trimmed.includes("<tool_result>") ||
    trimmed.includes("<tool_use>") ||
    trimmed.includes("<function_call>")
  ) {
    return false;
  }

  // Injected context from the memory system itself
  if (trimmed.includes("<relevant-memories>") || trimmed.includes("<core-memory-refresh>")) {
    return false;
  }

  // Noise patterns (same as user gate)
  if (NOISE_PATTERNS.some((r) => r.test(trimmed))) {
    return false;
  }

  // Excessive emoji (likely reaction, not substance)
  const emojiCount = (trimmed.match(/[\u{1F300}-\u{1F9FF}]/gu) || []).length;
  if (emojiCount > 3) {
    return false;
  }

  return true;
}
