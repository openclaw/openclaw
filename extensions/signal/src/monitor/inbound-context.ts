import { resolveChannelContextVisibilityMode } from "openclaw/plugin-sdk/context-visibility-runtime";
import {
  evaluateSupplementalContextVisibility,
  type ContextVisibilityDecision,
} from "openclaw/plugin-sdk/security-runtime";
import { normalizeOptionalString } from "openclaw/plugin-sdk/text-runtime";
import {
  formatSignalSenderDisplay,
  isSignalSenderAllowed,
  looksLikeUuid,
  resolveSignalSender,
} from "../identity.js";
import type { SignalDataMessage } from "./event-handler.types.js";

type SignalQuoteContext = {
  contextVisibilityMode: ReturnType<typeof resolveChannelContextVisibilityMode>;
  decision: ContextVisibilityDecision;
  quoteSenderAllowed: boolean;
  visibleQuoteId?: string;
  visibleQuoteText: string;
  visibleQuoteSender?: string;
  visibleQuoteIsQuote?: boolean;
};

export function resolveSignalQuoteContext(params: {
  cfg: Parameters<typeof resolveChannelContextVisibilityMode>[0]["cfg"];
  accountId: string;
  isGroup: boolean;
  dataMessage?: SignalDataMessage | null;
  effectiveGroupAllow: string[];
}): SignalQuoteContext {
  const contextVisibilityMode = resolveChannelContextVisibilityMode({
    cfg: params.cfg,
    channel: "signal",
    accountId: params.accountId,
  });
  const quoteText = normalizeOptionalString(params.dataMessage?.quote?.text) ?? "";
  const quoteAuthor = params.dataMessage?.quote?.author ?? null;
  const quoteSender = resolveSignalSender({
    sourceNumber:
      params.dataMessage?.quote?.authorNumber ??
      (quoteAuthor && !looksLikeUuid(quoteAuthor) ? quoteAuthor : null),
    sourceUuid:
      params.dataMessage?.quote?.authorUuid ??
      (quoteAuthor && looksLikeUuid(quoteAuthor) ? quoteAuthor : null),
  });
  const quoteId =
    params.dataMessage?.quote?.id != null ? String(params.dataMessage.quote.id) : undefined;
  const quoteSenderAllowed =
    !params.isGroup || params.effectiveGroupAllow.length === 0
      ? true
      : quoteSender
        ? isSignalSenderAllowed(quoteSender, params.effectiveGroupAllow)
        : false;
  const decision = evaluateSupplementalContextVisibility({
    mode: contextVisibilityMode,
    kind: "quote",
    senderAllowed: quoteSenderAllowed,
  });
  const hasQuoteMetadata = Boolean(quoteId || quoteText || quoteSender);
  const includeQuoteMetadata = decision.include && hasQuoteMetadata;

  return {
    contextVisibilityMode,
    decision,
    quoteSenderAllowed,
    visibleQuoteId: includeQuoteMetadata ? quoteId : undefined,
    visibleQuoteText: decision.include ? quoteText : "",
    visibleQuoteSender:
      includeQuoteMetadata && quoteSender ? formatSignalSenderDisplay(quoteSender) : undefined,
    visibleQuoteIsQuote: includeQuoteMetadata ? true : undefined,
  };
}
