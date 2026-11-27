import {
  filterChannelInboundQuoteContext,
  resolveInboundSupplementalSenderAllowed,
} from "openclaw/plugin-sdk/channel-inbound";
import { resolveChannelContextVisibilityMode } from "openclaw/plugin-sdk/context-visibility-runtime";
import { resolveAgentRoute } from "openclaw/plugin-sdk/routing";
import {
  formatSignalSenderDisplay,
  isSignalSenderAllowed,
  looksLikeUuid,
  resolveSignalSender,
} from "../identity.js";
import type { SignalInboundEntry } from "./event-handler.control-lane.js";
import type { SignalDataMessage, SignalEventHandlerDeps } from "./event-handler.types.js";
import { renderSignalMentions } from "./mentions.js";

export function resolveSignalInboundRoute(params: {
  cfg: SignalEventHandlerDeps["cfg"];
  accountId: SignalEventHandlerDeps["accountId"];
  isGroup: boolean;
  groupId?: string;
  senderPeerId: string;
}) {
  return resolveAgentRoute({
    cfg: params.cfg,
    channel: "signal",
    accountId: params.accountId,
    peer: {
      kind: params.isGroup ? "group" : "direct",
      id: params.isGroup ? (params.groupId ?? "unknown") : params.senderPeerId,
    },
  });
}

export function mergeSignalInboundBatch(
  entries: SignalInboundEntry[],
  last: SignalInboundEntry,
): SignalInboundEntry | undefined {
  if (entries.length === 1) {
    return last;
  }
  const bodyText = entries
    .map((entry) => entry.bodyText)
    .filter(Boolean)
    .join("\n");
  if (!bodyText.trim()) {
    return undefined;
  }
  return {
    ...last,
    bodyText,
    commandBody: entries
      .map((entry) => entry.commandBody)
      .filter(Boolean)
      .join("\n"),
    isBatched: true,
    nativeReplyBody: last.nativeReplyBody ?? last.bodyText,
    media: entries.flatMap((entry) => entry.media ?? []),
    wasMentioned: entries.some((entry) => entry.wasMentioned),
    historyImageQuotes: entries.flatMap((entry) => entry.historyImageQuotes ?? []),
  };
}

export function resolveSignalQuoteContext(params: {
  cfg: Parameters<typeof resolveChannelContextVisibilityMode>[0]["cfg"];
  accountId: string;
  isGroup: boolean;
  dataMessage?: SignalDataMessage | null;
  effectiveGroupAllow: string[];
}) {
  const contextVisibilityMode = resolveChannelContextVisibilityMode({
    cfg: params.cfg,
    channel: "signal",
    accountId: params.accountId,
  });
  const quote = params.dataMessage?.quote;
  const quoteText = renderSignalMentions(quote?.text ?? "", quote?.mentions).trim();
  const legacyAuthor = quote?.author?.trim();
  const legacyAuthorIsUuid = legacyAuthor ? looksLikeUuid(legacyAuthor) : false;
  const quoteSender = resolveSignalSender({
    sourceNumber: quote?.authorNumber?.trim() || (legacyAuthorIsUuid ? undefined : legacyAuthor),
    sourceUuid: quote?.authorUuid?.trim() || (legacyAuthorIsUuid ? legacyAuthor : undefined),
  });
  const quoteSenderAllowed = resolveInboundSupplementalSenderAllowed({
    isGroup: params.isGroup,
    groupPolicy: params.effectiveGroupAllow.length === 0 ? "open" : "allowlist",
    allowFrom: params.effectiveGroupAllow,
    isSenderAllowed: (allowFrom) =>
      quoteSender ? isSignalSenderAllowed(quoteSender, allowFrom) : false,
  });
  const visibleQuote = filterChannelInboundQuoteContext(contextVisibilityMode, {
    body: quoteText,
    sender: quoteSender ? formatSignalSenderDisplay(quoteSender) : undefined,
    senderAllowed: quoteSenderAllowed,
    isQuote: true,
  });

  return {
    quoteText,
    quoteSender,
    contextVisibilityMode,
    quoteSenderAllowed,
    visibleQuoteText: visibleQuote?.body ?? "",
    visibleQuoteSender: visibleQuote?.sender,
  };
}
