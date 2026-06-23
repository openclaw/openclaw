// Msteams plugin module: DLP-aware outbound redaction (#16).
//
// Scrubs sensitive values (card numbers, national IDs, secrets, …) out of text the bot is about to
// SEND to Teams, so the agent can't accidentally leak data into a chat. Pure + deterministic so it's
// unit-testable; the wiring (apply on every outbound chat message) lives in send.ts and
// reply-dispatcher.ts. Off unless channels.msteams.dlp.enabled is set.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";

export interface MSTeamsDlpConfigLike {
  enabled?: boolean;
  /** Built-in categories to redact. Omitted = all built-ins. */
  categories?: string[];
  /** Extra org-specific patterns; each match is replaced like a built-in category. */
  customPatterns?: Array<{ name: string; pattern: string }>;
  /** Replacement template; "{category}" is substituted. Default "[REDACTED:{category}]". */
  placeholder?: string;
}

export interface RedactionResult {
  text: string;
  /** Per-category hit counts, for audit/logging. Empty when nothing matched. */
  redactions: Array<{ category: string; count: number }>;
}

interface Detector {
  category: string;
  regex: RegExp;
  /** Optional extra validation on a raw match (e.g. Luhn for card numbers). */
  validate?: (match: string) => boolean;
}

/** Luhn checksum — keeps random 13-19 digit numbers from being flagged as card numbers. */
function luhnValid(digits: string): boolean {
  const d = digits.replace(/[^\d]/g, "");
  if (d.length < 13 || d.length > 19) {
    return false;
  }
  let sum = 0;
  let alt = false;
  for (let i = d.length - 1; i >= 0; i--) {
    let n = d.charCodeAt(i) - 48;
    if (alt) {
      n *= 2;
      if (n > 9) {
        n -= 9;
      }
    }
    sum += n;
    alt = !alt;
  }
  return sum % 10 === 0;
}

// Built-in detectors. Order matters: more specific patterns run first so they win the redaction.
const BUILTIN_DETECTORS: Detector[] = [
  { category: "awsKey", regex: /\bAKIA[0-9A-Z]{16}\b/g },
  // Common provider secret prefixes (OpenAI/Anthropic/GitHub/Slack/Stripe/Google). The sk- class
  // includes - and _ so segmented keys (sk-proj-…, sk-ant-api03-…) match too.
  {
    category: "secret",
    regex:
      /\b(?:sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{20,})\b/g,
  },
  { category: "iban", regex: /\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]{4}){2,7}(?:[ ]?[A-Z0-9]{1,3})?\b/g },
  { category: "email", regex: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g },
  { category: "ssn", regex: /\b\d{3}-\d{2}-\d{4}\b/g },
  {
    category: "creditCard",
    regex: /\b(?:\d[ -]?){12,18}\d\b/g,
    validate: luhnValid,
  },
  // E.164 / common international phone forms (kept loose, after card so card numbers win).
  { category: "phone", regex: /(?<!\w)\+\d{1,3}[ -]?\d{2,4}(?:[ -]?\d{2,4}){2,4}(?!\w)/g },
];

/**
 * Redact sensitive values from outbound text. Returns the scrubbed text plus per-category counts.
 * Custom patterns run first (org rules take precedence), then the enabled built-ins.
 */
export function redactText(text: string, config: MSTeamsDlpConfigLike): RedactionResult {
  if (!config.enabled || !text) {
    return { text, redactions: [] };
  }
  const placeholderTemplate = config.placeholder ?? "[REDACTED:{category}]";
  const counts = new Map<string, number>();

  const apply = (
    input: string,
    category: string,
    regex: RegExp,
    validate?: (m: string) => boolean,
  ) => {
    // Fresh lastIndex per call; all detector regexes are global.
    regex.lastIndex = 0;
    return input.replace(regex, (match) => {
      if (validate && !validate(match)) {
        return match;
      }
      counts.set(category, (counts.get(category) ?? 0) + 1);
      return placeholderTemplate.replace("{category}", category);
    });
  };

  let out = text;

  for (const custom of config.customPatterns ?? []) {
    let regex: RegExp;
    try {
      regex = new RegExp(custom.pattern, "g");
    } catch {
      continue; // skip a malformed custom pattern rather than throw on the send path
    }
    out = apply(out, custom.name, regex);
  }

  const enabled = config.categories;
  for (const det of BUILTIN_DETECTORS) {
    if (enabled && !enabled.includes(det.category)) {
      continue;
    }
    out = apply(out, det.category, det.regex, det.validate);
  }

  return {
    text: out,
    redactions: [...counts.entries()].map(([category, count]) => ({ category, count })),
  };
}

/**
 * Convenience wrapper for the outbound send paths: redact `text` per the channel's DLP config,
 * returning just the scrubbed text. A no-op (returns `text` unchanged) when DLP is off. Optionally
 * logs a per-category summary (never the redacted values themselves).
 */
export function redactOutboundMSTeamsText(
  text: string,
  cfg: OpenClawConfig,
  log?: { debug?: (message: string, meta?: Record<string, unknown>) => void },
): string {
  const dlp = cfg.channels?.msteams?.dlp;
  if (!dlp?.enabled) {
    return text;
  }
  const result = redactText(text, dlp);
  if (result.redactions.length > 0) {
    log?.debug?.("dlp redacted outbound text", { redactions: result.redactions });
  }
  return result.text;
}

/**
 * Deep-redact every string value in an outbound Adaptive Card (or any JSON-shaped) payload.
 * Cards are an agent-reachable outbound surface too — with only the text paths redacted,
 * "put the secret in a card" was a DLP loophole. A no-op (returns `card` unchanged) when DLP is
 * off.
 */
export function redactOutboundMSTeamsCard<T>(
  card: T,
  cfg: OpenClawConfig,
  log?: { debug?: (message: string, meta?: Record<string, unknown>) => void },
): T {
  const dlp = cfg.channels?.msteams?.dlp;
  if (!dlp?.enabled || card === null || typeof card !== "object") {
    return card;
  }
  const totals = new Map<string, number>();
  const walk = (value: unknown): unknown => {
    if (typeof value === "string") {
      const result = redactText(value, dlp);
      for (const r of result.redactions) {
        totals.set(r.category, (totals.get(r.category) ?? 0) + r.count);
      }
      return result.text;
    }
    if (Array.isArray(value)) {
      return value.map(walk);
    }
    if (value && typeof value === "object") {
      const out: Record<string, unknown> = {};
      for (const [key, entry] of Object.entries(value)) {
        out[key] = walk(entry);
      }
      return out;
    }
    return value;
  };
  const redacted = walk(card) as T;
  if (totals.size > 0) {
    log?.debug?.("dlp redacted outbound card", {
      redactions: [...totals.entries()].map(([category, count]) => ({ category, count })),
    });
  }
  return redacted;
}
