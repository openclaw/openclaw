export type MSTeamsQuoteInfo = {
  sender: string;
  body: string;
};

/**
 * Decode common HTML entities to plain text.
 */
export function decodeHtmlEntities(html: string): string {
  return html
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&"); // must be last to prevent double-decoding (e.g. &amp;lt; → &lt; not <)
}

/**
 * Strip HTML tags, preserving text content.
 */
export function htmlToPlainText(html: string): string {
  return decodeHtmlEntities(
    html
      .replace(/<[^>]*>/g, " ")
      .replace(/\s+/g, " ")
      .trim(),
  );
}

/**
 * Extract quote info from MS Teams HTML reply attachments.
 * Teams wraps quoted content in a blockquote with itemtype="http://schema.skype.com/Reply".
 */
export function extractMSTeamsQuoteInfo(
  attachments: Array<{ contentType?: string | null; content?: unknown }>,
): MSTeamsQuoteInfo | undefined {
  for (const att of attachments) {
    // Content may be a plain string or an object with .text/.body (e.g. Adaptive Card payloads).
    const content =
      typeof att.content === "string"
        ? att.content
        : typeof att.content === "object" && att.content !== null
          ? String(
              (att.content as Record<string, unknown>).text ??
                (att.content as Record<string, unknown>).body ??
                "",
            )
          : "";
    if (!content) continue;

    // Look for the Skype Reply schema blockquote.
    if (!content.includes("http://schema.skype.com/Reply")) continue;

    // Extract sender from <strong itemprop="mri">.
    const senderMatch = /<strong[^>]*itemprop=["']mri["'][^>]*>(.*?)<\/strong>/i.exec(content);
    const sender = senderMatch?.[1] ? htmlToPlainText(senderMatch[1]) : undefined;

    // Extract body from <p itemprop="copy">.
    const bodyMatch = /<p[^>]*itemprop=["']copy["'][^>]*>(.*?)<\/p>/is.exec(content);
    const body = bodyMatch?.[1] ? htmlToPlainText(bodyMatch[1]) : undefined;

    if (body) {
      return { sender: sender ?? "unknown", body };
    }
  }
  return undefined;
}

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
