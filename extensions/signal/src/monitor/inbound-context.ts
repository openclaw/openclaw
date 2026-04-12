import { resolveChannelContextVisibilityMode } from "openclaw/plugin-sdk/config-runtime";
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

export type SignalQuoteContext = {
  contextVisibilityMode: ReturnType<typeof resolveChannelContextVisibilityMode>;
  decision: ContextVisibilityDecision;
  quoteSenderAllowed: boolean;
  visibleQuoteText: string;
  visibleQuoteSender?: string;
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
    sourceNumber: params.dataMessage?.quote?.authorNumber ?? (quoteAuthor && !looksLikeUuid(quoteAuthor) ? quoteAuthor : null),
    sourceUuid: params.dataMessage?.quote?.authorUuid ?? (quoteAuthor && looksLikeUuid(quoteAuthor) ? quoteAuthor : null),
  });
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

  return {
    contextVisibilityMode,
    decision,
    quoteSenderAllowed,
    visibleQuoteText: decision.include ? quoteText : "",
    visibleQuoteSender:
      decision.include && quoteSender ? formatSignalSenderDisplay(quoteSender) : undefined,
  };
}
