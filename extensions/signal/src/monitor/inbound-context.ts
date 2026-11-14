import {
  filterChannelInboundQuoteContext,
  resolveInboundSupplementalSenderAllowed,
} from "openclaw/plugin-sdk/channel-inbound";
import { resolveChannelContextVisibilityMode } from "openclaw/plugin-sdk/context-visibility-runtime";
import {
  asPositiveSafeInteger,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  formatSignalSenderDisplay,
  isSignalSenderAllowed,
  looksLikeUuid,
  resolveSignalSender,
} from "../identity.js";
import type { SignalDataMessage, SignalQuoteContext } from "./event-handler.types.js";

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
  const quoteText = normalizeOptionalString(quote?.text) ?? "";
  const author = normalizeOptionalString(quote?.author);
  // signal-cli's legacy author is a number when known, otherwise a bare UUID.
  const authorIsUuid = author ? looksLikeUuid(author) : false;
  const quoteSender = resolveSignalSender({
    sourceNumber:
      normalizeOptionalString(quote?.authorNumber) ?? (authorIsUuid ? undefined : author),
    sourceUuid: normalizeOptionalString(quote?.authorUuid) ?? (authorIsUuid ? author : undefined),
  });
  const quoteSenderAllowed = resolveInboundSupplementalSenderAllowed({
    isGroup: params.isGroup,
    groupPolicy: params.effectiveGroupAllow.length === 0 ? "open" : "allowlist",
    allowFrom: params.effectiveGroupAllow,
    isSenderAllowed: (allowFrom) =>
      quoteSender ? isSignalSenderAllowed(quoteSender, allowFrom) : false,
  });
  const quoteId = asPositiveSafeInteger(quote?.id);
  const filteredQuote = filterChannelInboundQuoteContext(contextVisibilityMode, {
    id: quoteId === undefined ? undefined : String(quoteId),
    body: quoteText,
    sender: quoteSender ? formatSignalSenderDisplay(quoteSender) : undefined,
    senderAllowed: quoteSenderAllowed,
    isQuote: true,
  });
  const visibleQuote: SignalQuoteContext | undefined = filteredQuote?.body
    ? { id: filteredQuote.id, body: filteredQuote.body, sender: filteredQuote.sender }
    : undefined;

  return {
    contextVisibilityMode,
    quoteSenderAllowed,
    visibleQuote,
  };
}
