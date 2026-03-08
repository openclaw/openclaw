import type { ReplyPayload } from "../../../../src/auto-reply/types.js";
import { resolveSignalQuoteMetadata } from "../reply-quote.js";

export type SignalReplyDeliveryState = {
  consumed: boolean;
};

function normalizeReplyToId(raw?: string | null) {
  if (raw == null) {
    return raw;
  }
  const trimmed = raw.trim();
  return trimmed ? trimmed : null;
}

export function resolveSignalReplyDelivery(params: {
  payload: ReplyPayload;
  inheritedReplyToId?: string | null;
  state?: SignalReplyDeliveryState;
}): {
  payload: ReplyPayload;
  effectiveReplyTo?: string;
} {
  const explicitReplyTo =
    "replyToId" in params.payload ? normalizeReplyToId(params.payload.replyToId) : undefined;
  const inheritedReplyTo =
    explicitReplyTo === undefined ? normalizeReplyToId(params.inheritedReplyToId) : undefined;
  const effectiveReplyTo =
    explicitReplyTo != null
      ? explicitReplyTo
      : !params.state?.consumed
        ? (inheritedReplyTo ?? undefined)
        : undefined;

  if (explicitReplyTo === undefined) {
    return {
      payload: params.payload,
      effectiveReplyTo,
    };
  }

  return {
    payload:
      explicitReplyTo === null
        ? { ...params.payload, replyToId: undefined }
        : params.payload.replyToId === explicitReplyTo
          ? params.payload
          : { ...params.payload, replyToId: explicitReplyTo },
    effectiveReplyTo,
  };
}

/**
 * Only consume the inherited reply state when Signal can actually send quote
 * metadata for the payload. Malformed ids (e.g. a raw `[[reply_to:...]]` tag)
 * and group replies without a resolved quote-author are silently dropped by
 * `sendMessageSignal`, so consuming state for them would lose the inherited
 * quote for subsequent payloads in the same turn.
 */
export function markSignalReplyConsumed(
  state: SignalReplyDeliveryState | undefined,
  replyToId?: string,
  options: { isGroup?: boolean; quoteAuthor?: string | null } = {},
) {
  if (
    state &&
    resolveSignalQuoteMetadata({
      replyToId,
      quoteAuthor: options.quoteAuthor,
      isGroup: options.isGroup,
    }).quoteTimestamp !== undefined
  ) {
    state.consumed = true;
  }
}
