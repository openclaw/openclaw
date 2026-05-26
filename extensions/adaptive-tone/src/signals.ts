/**
 * Pure signal-detection functions.
 *
 * These take plain values (never OpenClaw SDK types) so they are trivially
 * unit-testable and have no runtime dependency on the host. The plugin entry
 * (`index.ts`) extracts the relevant fields from the hook event/context and
 * passes them in.
 */

import type { AdaptiveToneConfig, ChannelRegister } from "./config.js";

export type TimeBucket = "early-morning" | "day" | "evening" | "late-night";

/** Read the hour (0–23) for `now` in the given IANA timezone, falling back to host local time. */
export function getHourInZone(now: Date, timeZone?: string): number {
  if (!timeZone) return now.getHours();
  try {
    const fmt = new Intl.DateTimeFormat("en-US", {
      hour: "numeric",
      hour12: false,
      timeZone,
    });
    const part = fmt.formatToParts(now).find((p) => p.type === "hour")?.value;
    let hour = part ? Number.parseInt(part, 10) : now.getHours();
    if (hour === 24) hour = 0; // some environments emit "24" for midnight
    return Number.isFinite(hour) ? hour : now.getHours();
  } catch {
    return now.getHours();
  }
}

export function timeBucket(now: Date, timeZone?: string): TimeBucket {
  const h = getHourInZone(now, timeZone);
  if (h >= 5 && h < 8) return "early-morning";
  if (h >= 8 && h < 18) return "day";
  if (h >= 18 && h < 22) return "evening";
  return "late-night"; // 22:00–04:59
}

/** Map a channel id to a register using the operator's allow-lists. */
export function channelRegister(
  channelId: string | undefined,
  config: AdaptiveToneConfig,
): ChannelRegister {
  if (!channelId) return "neutral";
  // Channel ids look like "slack", "telegram", or "slack:T123/C456" — take the
  // leading segment before any ":" or "/" and match case-insensitively.
  const base = channelId.split(/[:/]/)[0]?.toLowerCase() ?? "";
  if (!base) return "neutral";
  if (config.place.professionalChannels.includes(base)) return "professional";
  if (config.place.casualChannels.includes(base)) return "casual";
  return "neutral";
}

/** Normalise prompt text for repetition comparison: lower-case, strip punctuation, collapse space. */
export function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenSet(text: string): Set<string> {
  return new Set(normalizeText(text).split(" ").filter(Boolean));
}

/** Jaccard similarity between two strings' token sets (0–1). */
export function similarity(a: string, b: string): number {
  const sa = tokenSet(a);
  const sb = tokenSet(b);
  if (sa.size === 0 && sb.size === 0) return 1;
  if (sa.size === 0 || sb.size === 0) return 0;
  let inter = 0;
  for (const t of sa) if (sb.has(t)) inter++;
  const union = sa.size + sb.size - inter;
  return union === 0 ? 0 : inter / union;
}

/**
 * Decide whether two asks are "the same question" for repetition purposes.
 * Matches on: identical normalized text, one being a (multi-word) substring of
 * the other — so "restart the gateway" matches "restart the gateway please" —
 * or token-overlap above the configured threshold.
 */
export function isRepeatOf(currentNorm: string, prior: string, threshold: number): boolean {
  const priorNorm = normalizeText(prior);
  if (!priorNorm || !currentNorm) return false;
  if (priorNorm === currentNorm) return true;
  const [shorter, longer] =
    currentNorm.length <= priorNorm.length ? [currentNorm, priorNorm] : [priorNorm, currentNorm];
  if (shorter.split(" ").length >= 2 && longer.includes(shorter)) return true;
  return similarity(priorNorm, currentNorm) >= threshold;
}

/**
 * Best-effort extraction of user-authored text from OpenClaw's session
 * messages array (typed as `unknown[]` at the hook boundary). Handles both
 * `content: string` and `content: Array<{ type, text }>` message shapes, and
 * ignores anything that does not look like a user turn.
 */
export function extractUserTexts(messages: unknown[]): string[] {
  const out: string[] = [];
  for (const raw of messages) {
    if (!raw || typeof raw !== "object") continue;
    const msg = raw as { role?: unknown; content?: unknown };
    if (msg.role !== "user") continue;
    const content = msg.content;
    if (typeof content === "string") {
      if (content.trim()) out.push(content);
      continue;
    }
    if (Array.isArray(content)) {
      const text = content
        .map((part) => {
          if (typeof part === "string") return part;
          if (part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string") {
            return (part as { text: string }).text;
          }
          return "";
        })
        .join(" ")
        .trim();
      if (text) out.push(text);
    }
  }
  return out;
}

/**
 * Count how many *prior* user asks (within the recent window) are
 * near-identical to the current prompt. A return of 1 means "this is the 2nd
 * time asked", 2 means "3rd time", and so on.
 */
export function countRepeats(
  currentPrompt: string,
  messages: unknown[],
  config: AdaptiveToneConfig,
): number {
  const current = normalizeText(currentPrompt);
  if (!current) return 0;
  const priorUserTexts = extractUserTexts(messages);
  // The current prompt is usually not yet in `messages`, but if a host includes
  // it, drop a single trailing exact-match so we don't count the user against
  // themselves.
  const window = priorUserTexts.slice(-config.repetition.windowTurns);
  let matches = 0;
  for (const text of window) {
    if (isRepeatOf(current, text, config.repetition.similarityThreshold)) {
      matches++;
    }
  }
  return matches;
}

/** Conservative, explicit-only detection of user-stated distress in the current message. */
export function detectUnwell(prompt: string, config: AdaptiveToneConfig): boolean {
  const text = ` ${prompt.toLowerCase()} `;
  return config.wellbeing.phrases.some((phrase) => phrase && text.includes(phrase));
}
