import type { ReplyPayload } from "../../../../src/auto-reply/types.js";

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
 * Only consume the inherited reply state when the reply id is a valid Signal
 * timestamp (pure decimal string, > 0).  Malformed ids (e.g. a raw
 * `[[reply_to:...]]` tag that wasn't resolved) would be silently dropped by
 * `sendMessageSignal`, so consuming state for them would lose the inherited
 * quote for subsequent payloads in the same turn.
 */
export function markSignalReplyConsumed(
  state: SignalReplyDeliveryState | undefined,
  replyToId?: string,
) {
  if (state && replyToId && /^\d+$/.test(replyToId) && parseInt(replyToId, 10) > 0) {
    state.consumed = true;
  }
}
