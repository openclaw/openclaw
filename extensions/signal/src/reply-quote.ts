const SIGNAL_QUOTE_TIMESTAMP_RE = /^\d+$/;

export function parseSignalQuoteTimestamp(raw?: string | null): number | undefined {
  const trimmed = raw?.trim();
  if (!trimmed || !SIGNAL_QUOTE_TIMESTAMP_RE.test(trimmed)) {
    return undefined;
  }

  const timestamp = Number(trimmed);
  return Number.isInteger(timestamp) && timestamp > 0 ? timestamp : undefined;
}

export function isSignalGroupTarget(rawTarget: string): boolean {
  let value = rawTarget.trim();
  if (value.toLowerCase().startsWith("signal:")) {
    value = value.slice("signal:".length).trim();
  }
  return value.toLowerCase().startsWith("group:");
}

export function resolveSignalQuoteMetadata(params: {
  replyToId?: string | null;
  quoteAuthor?: string | null;
  isGroup?: boolean;
}): {
  quoteTimestamp?: number;
  quoteAuthor?: string;
} {
  const quoteTimestamp = parseSignalQuoteTimestamp(params.replyToId);
  if (quoteTimestamp === undefined) {
    return {};
  }

  const quoteAuthor = params.quoteAuthor?.trim() || undefined;
  if (params.isGroup && !quoteAuthor) {
    return {};
  }

  return { quoteTimestamp, quoteAuthor };
}
