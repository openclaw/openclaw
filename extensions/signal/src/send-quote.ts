/**
 * Lightweight quote-parameter helpers for Signal outbound sends.
 * Kept in a separate module so channel.ts can import them at startup
 * without eagerly loading the heavier send runtime.
 */

function normalizeSignalQuoteAuthorFromTarget(rawTo: string): string | undefined {
  let value = rawTo.trim();
  if (!value) {
    return undefined;
  }
  if (/^signal:/i.test(value)) {
    value = value.replace(/^signal:/i, "").trim();
  }
  if (!value) {
    return undefined;
  }
  const lower = value.toLowerCase();
  if (lower.startsWith("group:")) {
    return undefined;
  }
  if (lower.startsWith("username:")) {
    value = value.slice("username:".length).trim();
  }
  return value || undefined;
}

export function resolveSignalQuoteParams(input: {
  to: string;
  replyToId?: string;
  quoteTimestamp?: number;
  quoteAuthor?: string;
}): { quoteTimestamp?: number; quoteAuthor?: string } {
  let quoteTimestamp = input.quoteTimestamp;
  let quoteAuthor = input.quoteAuthor?.trim();

  if ((typeof quoteTimestamp !== "number" || !quoteAuthor) && input.replyToId?.trim()) {
    const parsedTs = Number(input.replyToId.trim());
    if (Number.isFinite(parsedTs) && parsedTs > 0) {
      if (typeof quoteTimestamp !== "number") {
        quoteTimestamp = parsedTs;
      }
      quoteAuthor = quoteAuthor || normalizeSignalQuoteAuthorFromTarget(input.to);
    }
  }

  if (
    typeof quoteTimestamp === "number" &&
    Number.isFinite(quoteTimestamp) &&
    quoteTimestamp > 0 &&
    quoteAuthor
  ) {
    return { quoteTimestamp, quoteAuthor };
  }
  return {};
}
