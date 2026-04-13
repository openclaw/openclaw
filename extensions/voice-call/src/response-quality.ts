export type ReplayRule = "NO_ELONGATED_TOKEN" | "NO_CONSECUTIVE_DUPLICATE_BOT_LINE";

export type ReplayTurn = {
  speaker: "user" | "bot";
  text: string;
};

export type ReplayViolation = {
  rule: ReplayRule;
  turnIndex: number;
  rawText: string;
  normalizedText: string;
};

const REPLY_TAG_PATTERN = /\[\[\s*reply_to(?:_current|\s*:[^\]]+)\s*\]\]/gi;
const CODE_FENCE_PATTERN = /```[\s\S]*?```/g;
const TOOL_JSON_BLOB_PATTERN = /\{[^{}]{0,900}"tool"\s*:\s*"[^\"]+"[^{}]*\}/gi;
const TOOL_USE_BLOB_PATTERN =
  /\{[^{}]{0,900}"recipient_name"\s*:\s*"functions\.[^\"]+"[^{}]*\}/gi;

function hasToolLikePayload(text: string): boolean {
  return (
    /\{[^{}]{0,900}"tool"\s*:\s*"[^\"]+"[^{}]*\}/i.test(text) ||
    /\{[^{}]{0,900}"recipient_name"\s*:\s*"functions\.[^\"]+"[^{}]*\}/i.test(text)
  );
}

function looksLikeInternalArtifact(text: string): boolean {
  const lowered = text.toLowerCase();
  const signals = [
    "toolcall",
    "toolresult",
    "thinkingsignature",
    "runid",
    "sessionid",
    '"tool":',
    '"recipient_name":',
    '"tool_uses":',
    "/opt/homebrew",
    "~/.openclaw",
    "openclaw/docs",
    "need maybe use",
    "functions.",
  ];
  return signals.some((signal) => lowered.includes(signal));
}

export function sanitizeVoiceResponse(raw: string): string | null {
  const text = raw
    .replace(REPLY_TAG_PATTERN, " ")
    .replace(CODE_FENCE_PATTERN, " ")
    .replace(TOOL_JSON_BLOB_PATTERN, " ")
    .replace(TOOL_USE_BLOB_PATTERN, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!text) {
    return null;
  }

  // Guard against leaking internal planning/tool chatter into spoken output.
  if (looksLikeInternalArtifact(text)) {
    return null;
  }

  // Extra guardrail: if text still looks like raw JSON/object payload, do not speak it.
  if (/^\s*[\[{].+[\]}]\s*$/s.test(text)) {
    return null;
  }

  // Defensive fallback when sanitizer strips tool/code wrappers but JSON-like payload remains.
  if (hasToolLikePayload(text)) {
    return null;
  }

  const maxChars = 320;
  if (text.length <= maxChars) {
    return text;
  }

  const truncated = text.slice(0, maxChars);
  const cutAt = Math.max(
    truncated.lastIndexOf("."),
    truncated.lastIndexOf("!"),
    truncated.lastIndexOf("?"),
  );
  if (cutAt >= 80) {
    return truncated.slice(0, cutAt + 1).trim();
  }

  const wordCut = truncated.lastIndexOf(" ");
  if (wordCut >= 80) {
    return `${truncated.slice(0, wordCut).trim()}...`;
  }

  return `${truncated.trim()}...`;
}

export function normalizeBotLineForDedupe(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/\s+/g, " ")
    .replace(/[.!?]+$/g, "");
}

export function isConsecutiveDuplicateBotLine(previous: string | null, current: string): boolean {
  if (!previous) {
    return false;
  }
  const prevNorm = normalizeBotLineForDedupe(previous);
  const curNorm = normalizeBotLineForDedupe(current);
  return prevNorm.length > 0 && prevNorm === curNorm;
}

export function containsElongatedToken(text: string, repeatThreshold = 2): boolean {
  if (repeatThreshold < 1) {
    return false;
  }
  const repeats = repeatThreshold + 1;
  const pattern = new RegExp(`([A-Za-z])\\1{${repeats - 1},}`);
  return pattern.test(text);
}

export function evaluateReplayQuality(turns: ReplayTurn[]): { violations: ReplayViolation[] } {
  const violations: ReplayViolation[] = [];
  let previousBotLine: string | null = null;

  turns.forEach((turn, turnIndex) => {
    if (turn.speaker !== "bot") {
      return;
    }

    const rawText = String(turn.text ?? "");
    const sanitized = sanitizeVoiceResponse(rawText);
    if (!sanitized) {
      return;
    }

    if (containsElongatedToken(sanitized)) {
      violations.push({
        rule: "NO_ELONGATED_TOKEN",
        turnIndex,
        rawText,
        normalizedText: sanitized,
      });
    }

    if (isConsecutiveDuplicateBotLine(previousBotLine, sanitized)) {
      violations.push({
        rule: "NO_CONSECUTIVE_DUPLICATE_BOT_LINE",
        turnIndex,
        rawText,
        normalizedText: normalizeBotLineForDedupe(sanitized),
      });
    }

    previousBotLine = sanitized;
  });

  return { violations };
}
