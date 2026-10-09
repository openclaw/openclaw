import { decodeHtmlEntities } from "openclaw/plugin-sdk/html-entity-runtime";

export type MSTeamsQuoteInfo = {
  sender: string;
  body: string;
  /**
   * The quoted message's Teams id (the blockquote `itemid`). Present when Teams
   * includes it; used to fetch the complete message text via Graph because the
   * inbound blockquote only carries a truncated `preview` snippet.
   */
  id?: string;
  senderId?: string;
  fromQuotedReplyEntity?: boolean;
};

type MSTeamsAttachmentLike = {
  contentType?: string | null;
  content?: unknown;
};

export type MSTeamsEntityLike = {
  type?: string;
  text?: unknown;
  mentioned?: { id?: unknown; name?: unknown };
  quotedReply?: {
    messageId?: unknown;
    senderId?: unknown;
    senderName?: unknown;
    preview?: unknown;
  };
};

export function htmlToPlainText(html: string): string {
  return decodeHtmlEntities(html.replace(/<[^>]*>/g, " "))
    .replaceAll("\u00a0", " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Extract quote info from MS Teams HTML reply attachments.
 * Teams wraps quoted content in a blockquote with itemtype="http://schema.skype.com/Reply".
 */
export function extractMSTeamsQuoteInfo(
  attachments: MSTeamsAttachmentLike[],
  entities?: MSTeamsEntityLike[] | null,
): MSTeamsQuoteInfo | undefined {
  // Entity metadata carries the authenticated sender identity. Prefer it over
  // attachment HTML, whose display name is not sufficient for authorization.
  const quotedEntity = (entities ?? []).find((entity) => entity.type === "quotedReply");
  if (quotedEntity) {
    const quotedReply = quotedEntity.quotedReply;
    if (typeof quotedReply?.preview === "string") {
      const body = normalizeMSTeamsWhitespace(quotedReply.preview);
      if (body) {
        const sender =
          typeof quotedReply.senderName === "string" ? quotedReply.senderName.trim() : "";
        const id = typeof quotedReply.messageId === "string" ? quotedReply.messageId.trim() : "";
        const senderId =
          typeof quotedReply.senderId === "string" ? quotedReply.senderId.trim() : "";
        return {
          sender: sender || "unknown",
          body,
          ...(id ? { id } : {}),
          ...(senderId ? { senderId } : {}),
          fromQuotedReplyEntity: true,
        };
      }
    }
  }

  for (const att of attachments) {
    const content = readMSTeamsAttachmentContent(att);
    if (!content) {
      continue;
    }

    if (!content.includes("http://schema.skype.com/Reply")) {
      continue;
    }

    for (const replyBlock of content.matchAll(
      /<blockquote\b(?=[^>]*\bitemtype=["']http:\/\/schema\.skype\.com\/Reply["'])([^>]*)>(.*?)<\/blockquote>/gis,
    )) {
      const attributes = replyBlock[1] ?? "";
      const replyHtml = replyBlock[2] ?? "";
      const senderMatch = /<strong[^>]*itemprop=["']mri["'][^>]*>(.*?)<\/strong>/i.exec(replyHtml);
      const sender = senderMatch?.[1] ? htmlToPlainText(senderMatch[1]) : undefined;

      // Keep identity and text scoped to one Reply block. Prefer the full copy
      // over Teams' truncated preview when both occur in that same block.
      const copyMatch = /<p[^>]*itemprop=["']copy["'][^>]*>(.*?)<\/p>/is.exec(replyHtml);
      const bodyMatch =
        copyMatch ?? /<p[^>]*itemprop=["']preview["'][^>]*>(.*?)<\/p>/is.exec(replyHtml);
      const body = bodyMatch?.[1] ? htmlToPlainText(bodyMatch[1]) : undefined;
      const idMatch = /\bitemid=["']([^"']+)["']/i.exec(attributes);
      const id = idMatch?.[1]?.trim() || undefined;
      if (!body) {
        continue;
      }

      const quotedReply = quotedEntity?.quotedReply;
      const entitySender =
        typeof quotedReply?.senderName === "string" ? quotedReply.senderName.trim() : "";
      const entityId =
        typeof quotedReply?.messageId === "string" ? quotedReply.messageId.trim() : "";
      const senderId = typeof quotedReply?.senderId === "string" ? quotedReply.senderId.trim() : "";
      // Do not authorize attachment HTML with an unrelated entity identity.
      // When Teams supplies both sources, their message ids must bind them to
      // the same quote before the authenticated entity sender can be used.
      if (quotedEntity && (!entityId || !id || entityId !== id)) {
        continue;
      }
      return {
        sender: entitySender || sender || "unknown",
        body,
        ...(entityId || id ? { id: entityId || id } : {}),
        ...(senderId ? { senderId } : {}),
        ...(quotedEntity ? { fromQuotedReplyEntity: true } : {}),
      };
    }
  }
  return undefined;
}

function readMSTeamsAttachmentContent(att: MSTeamsAttachmentLike): string {
  if (typeof att.content === "string") {
    return att.content;
  }
  if (typeof att.content !== "object" || att.content === null) {
    return "";
  }
  const record = att.content as Record<string, unknown>;
  return typeof record.text === "string"
    ? record.text
    : typeof record.body === "string"
      ? record.body
      : "";
}

function normalizeMSTeamsWhitespace(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function normalizeMSTeamsMentionTags(
  text: string,
  entities: MSTeamsEntityLike[],
  botId?: string | null,
  botName?: string | null,
): string {
  const mentions: Array<{ id?: string; name: string; text: string }> = [];
  for (const entity of entities) {
    const name = entity.mentioned?.name;
    if (entity.type !== "mention" || typeof entity.text !== "string" || typeof name !== "string") {
      continue;
    }
    mentions.push({
      id: typeof entity.mentioned?.id === "string" ? entity.mentioned.id : undefined,
      name,
      text: entity.text.trim(),
    });
  }

  return text.replace(/<at\b[^>]*>.*?<\/at>/gis, (tag) => {
    const displayName = htmlToPlainText(tag);
    const exactIndex = mentions.findIndex((mention) => mention.text === tag.trim());
    const displayIndex = mentions.findIndex(
      (mention) => htmlToPlainText(mention.text) === displayName,
    );
    const mentionIndex = exactIndex >= 0 ? exactIndex : displayIndex;
    const mention = mentionIndex >= 0 ? mentions.splice(mentionIndex, 1)[0] : undefined;
    if (mention?.id && botId && mention.id === botId) {
      return "";
    }
    if (mention) {
      return `@${mention.name}`;
    }
    if (!botId) {
      return "";
    }
    if (botId && botName && displayName.trim() === botName.trim()) {
      return "";
    }
    return displayName ? `@${displayName}` : "";
  });
}

function extractMSTeamsForwardBodies(attachments: MSTeamsAttachmentLike[]): string[] {
  const bodies: string[] = [];
  for (const attachment of attachments) {
    const content = readMSTeamsAttachmentContent(attachment);
    if (!content.includes("http://schema.skype.com/Forward")) {
      continue;
    }
    for (const match of content.matchAll(
      /<blockquote\b[^>]*itemtype=["']http:\/\/schema\.skype\.com\/Forward["'][^>]*>(.*?)<\/blockquote>/gis,
    )) {
      const body = htmlToPlainText(match[1] ?? "");
      if (body) {
        bodies.push(body);
      }
    }
  }
  return bodies;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function labelMSTeamsForwardBody(text: string, body: string): string {
  const marker = `[Forwarded message]\n${body}\n[/Forwarded message]`;
  const comparableBody = body.trim().split(/\s+/).join(" ");
  const alreadyLabeled = [
    ...text.matchAll(/\[Forwarded message\]\n([\s\S]*?)\n\[\/Forwarded message\]/g),
  ].some((match) => (match[1] ?? "").trim().split(/\s+/).join(" ") === comparableBody);
  if (alreadyLabeled) {
    return text;
  }
  const bodyPattern = body.trim().split(/\s+/).map(escapeRegExp).join("\\s+");
  const matches = [
    ...text.matchAll(new RegExp(`(^|\\n[ \\t]*\\n|\\n)([ \\t]*)(${bodyPattern})(?=$|\\n)`, "g")),
  ];
  const match = matches.at(-1);
  if (match?.index === undefined) {
    return `${text}\n\n${marker}`;
  }
  const replacement = `${match[1] ?? ""}[Forwarded message]\n${match[2] ?? ""}${match[3] ?? body}\n[/Forwarded message]`;
  return `${text.slice(0, match.index)}${replacement}${text.slice(match.index + match[0].length)}`;
}

export function buildMSTeamsNormalizedText(params: {
  text: string;
  entities?: MSTeamsEntityLike[] | null;
  attachments?: MSTeamsAttachmentLike[];
  botId?: string | null;
  botName?: string | null;
}): string {
  let text = normalizeMSTeamsMentionTags(
    params.text,
    params.entities ?? [],
    params.botId,
    params.botName,
  )
    .replace(/<quoted\b[^>]*\/>/gi, "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n");
  for (const body of extractMSTeamsForwardBodies(params.attachments ?? [])) {
    text = labelMSTeamsForwardBody(text, body);
  }
  return text.trim();
}

type MentionableActivity = {
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
