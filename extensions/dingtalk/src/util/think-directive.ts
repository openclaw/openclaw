/**
 * Parse /think directives (OpenClaw-compatible) for DingTalk.
 *
 * We support:
 * - Persistent: `/think low ...` or `/t on ...`
 * - One-shot: `/think! low ...` or `/t! on ...` (channel-side only)
 */

export type ThinkLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function matchLevelDirective(
  body: string,
  names: string[]
): { start: number; end: number; rawLevel?: string } | null {
  const namePattern = names.map(escapeRegExp).join("|");
  const match = body.match(new RegExp(`(?:^|\\s)\\/(?:${namePattern})(?=$|\\s|:)`, "i"));
  if (!match || match.index === undefined) {
    return null;
  }

  const start = match.index;
  let end = match.index + match[0].length;

  let i = end;
  while (i < body.length && /\s/.test(body[i] ?? "")) {
    i += 1;
  }
  if (body[i] === ":") {
    i += 1;
    while (i < body.length && /\s/.test(body[i] ?? "")) {
      i += 1;
    }
  }

  const argStart = i;
  while (i < body.length && /[A-Za-z-]/.test(body[i] ?? "")) {
    i += 1;
  }

  const rawLevel = i > argStart ? body.slice(argStart, i) : undefined;
  end = i;

  return { start, end, rawLevel };
}

function extractLevelDirective(
  body: string,
  names: string[],
  normalize: (rawLevel?: string) => ThinkLevel | undefined
): { cleaned: string; hasDirective: boolean; level?: ThinkLevel; rawLevel?: string } {
  const match = matchLevelDirective(body, names);
  if (!match) {
    return { cleaned: body.trim(), hasDirective: false };
  }

  const level = normalize(match.rawLevel);
  const cleaned = body
    .slice(0, match.start)
    .concat(" ")
    .concat(body.slice(match.end))
    .replace(/\s+/g, " ")
    .trim();

  return {
    cleaned,
    level,
    rawLevel: match.rawLevel,
    hasDirective: true,
  };
}

/**
 * Normalize user-provided thinking level strings to the canonical enum.
 * Mirrors OpenClaw behavior (including synonyms).
 */
export function normalizeThinkLevel(raw?: string): ThinkLevel | undefined {
  if (!raw) {
    return undefined;
  }

  const key = raw.toLowerCase();

  if (["off"].includes(key)) {
    return "off";
  }
  if (["on", "enable", "enabled"].includes(key)) {
    return "high";
  }
  if (["min", "minimal"].includes(key)) {
    return "minimal";
  }
  if (["low", "thinkhard", "think-hard", "think_hard"].includes(key)) {
    return "low";
  }
  if (["mid", "med", "medium", "thinkharder", "think-harder", "harder"].includes(key)) {
    return "medium";
  }
  if (["high", "ultra", "ultrathink", "think-hard", "thinkhardest", "highest", "max"].includes(key)) {
    return "high";
  }
  if (["xhigh", "x-high", "x_high"].includes(key)) {
    return "xhigh";
  }
  if (["think"].includes(key)) {
    return "minimal";
  }

  return undefined;
}

export function extractThinkDirective(
  body: string
): { cleaned: string; hasDirective: boolean; thinkLevel?: ThinkLevel; rawLevel?: string } {
  if (!body) {
    return { cleaned: "", hasDirective: false };
  }

  const extracted = extractLevelDirective(body, ["thinking", "think", "t"], normalizeThinkLevel);
  return {
    cleaned: extracted.cleaned,
    thinkLevel: extracted.level,
    rawLevel: extracted.rawLevel,
    hasDirective: extracted.hasDirective,
  };
}

export function extractThinkOnceDirective(
  body: string
): { cleaned: string; hasDirective: boolean; thinkLevel?: ThinkLevel; rawLevel?: string } {
  if (!body) {
    return { cleaned: "", hasDirective: false };
  }

  const extracted = extractLevelDirective(body, ["thinking!", "think!", "t!"], normalizeThinkLevel);
  return {
    cleaned: extracted.cleaned,
    thinkLevel: extracted.level,
    rawLevel: extracted.rawLevel,
    hasDirective: extracted.hasDirective,
  };
}
