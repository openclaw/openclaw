import type { ParsedArgs } from "./types.js";

/** Regex matching a valid period token: digits + h/d/w/m. */
const PERIOD_RE = /^\d+[hdwm]$/;

/**
 * Parse `/email_brief [filters...] [period]` arguments.
 *
 * The last token matching the period regex is extracted as the period.
 * Everything else is parsed as filters:
 * - `from:<email>` — sender filter
 * - `to:<email>` — recipient filter
 * - `urgent` — urgency flag
 * - `unread` — unread-only flag
 * - anything else — free text search query
 */
export function parseArgs(raw: string): ParsedArgs {
  const tokens = raw.trim().split(/\s+/).filter(Boolean);

  const result: ParsedArgs = {
    period: "1d",
    filters: {},
  };

  if (tokens.length === 0) {
    return result;
  }

  // Check if last token is a period
  const lastToken = tokens[tokens.length - 1];
  if (PERIOD_RE.test(lastToken)) {
    result.period = lastToken;
    tokens.pop();
  }

  const freeTextParts: string[] = [];

  for (const token of tokens) {
    const lower = token.toLowerCase();

    if (lower.startsWith("from:")) {
      result.filters.from = token.slice(5);
    } else if (lower.startsWith("to:")) {
      result.filters.to = token.slice(3);
    } else if (lower === "urgent") {
      result.filters.urgent = true;
    } else if (lower === "unread") {
      result.filters.unread = true;
    } else {
      freeTextParts.push(token);
    }
  }

  if (freeTextParts.length > 0) {
    result.filters.freeText = freeTextParts.join(" ");
  }

  return result;
}
