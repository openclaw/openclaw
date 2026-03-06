import { kindFromMime } from "../../../../src/media/mime.js";
import { normalizeE164 } from "../../../../src/utils.js";
import { looksLikeUuid } from "../identity.js";
import type {
  SignalDataMessage,
  SignalMention,
  SignalQuote,
  SignalQuotedAttachment,
  SignalReplyTarget,
} from "./event-handler.types.js";
import { renderSignalMentions } from "./mentions.js";

export type SignalQuotedAuthorResolver = (params: {
  conversationKey: string;
  replyToId: string;
}) => string | undefined;

function filterMentions(mentions?: Array<SignalMention | null> | null) {
  const filtered = mentions?.filter((mention): mention is SignalMention => mention != null);
  return filtered && filtered.length > 0 ? filtered : undefined;
}

function normalizeQuoteAuthorValue(raw?: string | null) {
  const trimmed = raw?.trim();
  if (!trimmed) {
    return undefined;
  }
  const unprefixed = trimmed.replace(/^uuid:/i, "").trim();
  if (!unprefixed) {
    return undefined;
  }
  if (looksLikeUuid(unprefixed)) {
    // Preserve uuid: prefix for signal-cli compatibility
    return `uuid:${unprefixed}`;
  }
  const digits = unprefixed.replace(/[^\d+]/g, "");
  return digits ? normalizeE164(unprefixed) : undefined;
}

function resolveQuotedAuthorFromPayload(quote: SignalQuote) {
  return (
    normalizeQuoteAuthorValue(quote.authorNumber) ??
    normalizeQuoteAuthorValue(quote.authorUuid) ??
    normalizeQuoteAuthorValue(quote.author)
  );
}

function resolveQuotedAttachmentPlaceholder(
  attachments?: Array<SignalQuotedAttachment | null> | null,
) {
  const firstContentType = attachments?.find((attachment) => attachment?.contentType)?.contentType;
  const kind = kindFromMime(firstContentType ?? undefined);
  if (kind) {
    return `<media:${kind}>`;
  }
  return attachments?.length ? "<media:attachment>" : undefined;
}

export function normalizeSignalQuoteId(rawId?: SignalQuote["id"]) {
  if (typeof rawId === "number") {
    return Number.isInteger(rawId) && rawId > 0 ? String(rawId) : undefined;
  }
  const trimmed = rawId?.trim();
  if (!trimmed) {
    return undefined;
  }
  const numeric = Number(trimmed);
  return Number.isInteger(numeric) && numeric > 0 ? String(numeric) : undefined;
}

export function describeSignalReplyTarget(
  dataMessage: SignalDataMessage,
  opts: {
    resolveAuthor?: SignalQuotedAuthorResolver;
    conversationKey?: string;
  } = {},
): SignalReplyTarget | null {
  const quote = dataMessage.quote;
  if (!quote) {
    return null;
  }

  const id = normalizeSignalQuoteId(quote.id);
  const mentions = filterMentions(quote.mentions);
  const renderedText = renderSignalMentions(quote.text ?? "", mentions)?.trim() || "";
  const body =
    renderedText ||
    resolveQuotedAttachmentPlaceholder(quote.attachments) ||
    (id ? "<quoted message>" : "");
  if (!body) {
    return null;
  }

  const author =
    resolveQuotedAuthorFromPayload(quote) ??
    (opts.resolveAuthor && opts.conversationKey && id
      ? opts.resolveAuthor({ conversationKey: opts.conversationKey, replyToId: id })
      : undefined);

  return {
    id,
    author,
    body,
    kind: "quote",
    mentions,
  };
}
