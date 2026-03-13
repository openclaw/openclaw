export type MentionableActivity = {
  recipient?: { id?: string } | null;
  entities?: Array<{
    type?: string;
    mentioned?: { id?: string };
  }> | null;
};

export function normalizeMSTeamsConversationId(raw: string): string {
  return raw.split(";")[0] ?? raw;
}

export function extractMSTeamsConversationMessageId(raw: string): string | undefined {
  if (!raw) {
    return undefined;
  }
  const match = /(?:^|;)messageid=([^;]+)/i.exec(raw);
  const value = match?.[1]?.trim() ?? "";
  return value || undefined;
}

export function parseMSTeamsActivityTimestamp(value: unknown): Date | undefined {
  if (!value) {
    return undefined;
  }
  if (value instanceof Date) {
    return value;
  }
  if (typeof value !== "string") {
    return undefined;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

export function stripMSTeamsMentionTags(text: string): string {
  // Teams wraps mentions in <at>...</at> tags
  return text.replace(/<at[^>]*>.*?<\/at>/gi, "").trim();
}

export function wasMSTeamsBotMentioned(activity: MentionableActivity): boolean {
  const botId = activity.recipient?.id;
  if (!botId) {
    return false;
  }
  const entities = activity.entities ?? [];
  return entities.some((e) => e.type === "mention" && e.mentioned?.id === botId);
}

// ── Quote / reply-to extraction ──────────────────────────────────────────────

/**
 * Structured info extracted from a Teams quoted/reply message.
 */
export interface MSTeamsQuoteInfo {
  /** Display name of the person whose message was quoted. */
  quotedSender?: string;
  /** Plain-text body of the quoted message. */
  quotedBody?: string;
  /** The message text with the quoted prefix stripped (the sender's own words). */
  cleanBody: string;
}

/**
 * Strip HTML tags, decode common entities, collapse whitespace and trim.
 */
function htmlToPlainText(html: string): string {
  return (
    html
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/p>/gi, "\n")
      .replace(/<[^>]*>/g, "")
      .replace(/&nbsp;/gi, " ")
      .replace(/&amp;/gi, "&")
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">")
      .replace(/&quot;/gi, '"')
      .replace(/&#39;/gi, "'")
      // Decode numeric character references (decimal and hex) that Teams may produce.
      .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
      .replace(/&#([0-9]+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
      .replace(/[ \t]+/g, " ")
      .replace(/\n{3,}/g, "\n\n")
      .trim()
  );
}

/**
 * Try to extract structured quote context from the Teams activity body.
 *
 * Teams wraps quoted / replied-to content in the `activity.text` field itself
 * (plain-text) and sometimes in a `text/html` attachment.  The HTML form looks
 * roughly like:
 *
 * ```html
 * <blockquote itemscope itemtype="http://schema.skype.com/Reply" itemid="…">
 *   <strong itemprop="mri" itemid="…">Sender Name</strong>
 *   <span itemprop="time" itemid="…"></span>
 *   <p itemprop="copy">quoted text</p>
 * </blockquote>
 * actual message body
 * ```
 *
 * The plain-text `activity.text` squashes everything together:
 *   "Sender NameActual message body"
 *
 * This function tries the HTML attachment path to give the agent structured
 * context about which part is the quote and who originally wrote it.
 */
export function extractMSTeamsQuoteInfo(params: {
  /** Plain text body after mention-tag stripping. */
  text: string;
  /** Raw attachments from the activity. */
  attachments?: ReadonlyArray<{
    contentType?: string | null;
    content?: unknown;
  }>;
}): MSTeamsQuoteInfo | undefined {
  const { text, attachments } = params;

  // Try HTML attachment path (most reliable).
  if (attachments) {
    const result = extractQuoteFromHtmlAttachments(text, attachments);
    if (result) {
      return result;
    }
  }

  // No structured quote detected.
  return undefined;
}

/** Extract quote info from text/html attachments. */
function extractQuoteFromHtmlAttachments(
  fallbackText: string,
  attachments: ReadonlyArray<{
    contentType?: string | null;
    content?: unknown;
  }>,
): MSTeamsQuoteInfo | undefined {
  for (const att of attachments) {
    const ct = typeof att.contentType === "string" ? att.contentType.toLowerCase() : "";
    if (!ct.startsWith("text/html")) {
      continue;
    }
    const html = resolveHtmlContent(att.content);
    if (!html) {
      continue;
    }

    // Match <blockquote> that Teams uses for quoted replies (with Skype Reply schema).
    // Note: non-greedy match stops at the first </blockquote>, so nested
    // blockquotes are not supported. Teams does not currently produce them
    // for quote/reply scenarios.
    const blockquoteRe =
      /<blockquote[^>]*itemtype=["']http:\/\/schema\.skype\.com\/Reply["'][^>]*>([\s\S]*?)<\/blockquote>/i;
    const bqMatch = blockquoteRe.exec(html);
    if (!bqMatch) {
      // Only match blockquotes with the Skype Reply schema attribute.
      // Generic blockquotes (e.g. user-authored quote formatting) are not
      // treated as reply metadata to avoid misinterpreting normal messages.
      continue;
    }
    return parseBlockquoteContent(bqMatch, html, fallbackText);
  }
  return undefined;
}

function parseBlockquoteContent(
  bqMatch: RegExpExecArray,
  html: string,
  fallbackText: string,
): MSTeamsQuoteInfo {
  const quoteHtml = bqMatch[1] ?? "";

  // Extract sender name from <strong> tag.
  const senderRe = /<strong[^>]*>([\s\S]*?)<\/strong>/i;
  const senderMatch = senderRe.exec(quoteHtml);
  const quotedSender = senderMatch ? htmlToPlainText(senderMatch[1] ?? "") : undefined;

  // Extract quoted body: prefer itemprop="copy", fall back to remaining text.
  const copyRe = /<p[^>]*itemprop=["']copy["'][^>]*>([\s\S]*?)<\/p>/i;
  const copyMatch = copyRe.exec(quoteHtml);
  const quotedBody = copyMatch
    ? htmlToPlainText(copyMatch[1] ?? "")
    : htmlToPlainText(quoteHtml.replace(senderRe, ""));

  // The actual message is everything after the blockquote.
  const afterBlockquote = html.slice(bqMatch.index + bqMatch[0].length);
  const cleanBody = htmlToPlainText(afterBlockquote) || fallbackText;

  return {
    quotedSender: quotedSender || undefined,
    quotedBody: quotedBody || undefined,
    cleanBody,
  };
}

function resolveHtmlContent(content: unknown): string | undefined {
  if (typeof content === "string") {
    return content;
  }
  if (content && typeof content === "object" && !Array.isArray(content)) {
    const rec = content as Record<string, unknown>;
    if (typeof rec.text === "string") return rec.text;
    if (typeof rec.body === "string") return rec.body;
    if (typeof rec.content === "string") return rec.content;
  }
  return undefined;
}
