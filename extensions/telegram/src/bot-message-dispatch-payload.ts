import {
  createOutboundPayloadPlan,
  createStructuredOutboundPayloadPlan,
} from "openclaw/plugin-sdk/channel-outbound";
import { copyReplyPayloadMetadata, type ReplyPayload } from "openclaw/plugin-sdk/reply-payload";
import type {
  CurrentTurnTranscriptFinal,
  TelegramDispatchTurn as Turn,
} from "./bot-message-dispatch.types.js";
import { canonicalizeTelegramPresentationPayload } from "./interactive-fallback.js";
import { resolveTelegramTargetChatType } from "./targets.js";

export const applyTextToPayload = (payload: ReplyPayload, text: string): ReplyPayload =>
  payload.text === text ? payload : copyReplyPayloadMetadata(payload, { ...payload, text });

export const projectPayloadForDelivery = (
  turn: Turn,
  payload: ReplyPayload,
  delivery?: CurrentTurnTranscriptFinal["openclawDelivery"],
): ReplyPayload | undefined => {
  // Persisted delivery facts can accompany raw MEDIA lines; transcript text is not fully prepared.
  const projected = createOutboundPayloadPlan([payload])[0]?.payload;
  if (projected && delivery) {
    if (payload.replyToId !== undefined || payload.replyToCurrent === true) {
      // A current-message target and an explicit id are alternative intents, not mergeable fields.
      projected.replyToId = payload.replyToId;
      projected.replyToCurrent = payload.replyToCurrent;
      projected.replyToTag = payload.replyToTag || payload.replyToCurrent === true;
    } else if (delivery.replyToId !== undefined || delivery.replyToCurrent === true) {
      projected.replyToId = delivery.replyToId;
      projected.replyToCurrent = delivery.replyToCurrent;
      projected.replyToTag = true;
    }
    projected.audioAsVoice =
      payload.audioAsVoice ?? delivery.audioAsVoice ?? projected.audioAsVoice;
    if (delivery.mediaUrls?.length) {
      projected.mediaUrls = [...(projected.mediaUrls ?? []), ...delivery.mediaUrls];
    }
  }
  if (projected?.replyToCurrent && projected.replyToId === undefined) {
    // The raw planner has no turn context; resolve current-message intent before preview reuse.
    projected.replyToId =
      turn.context.ctxPayload.MessageSidFull ?? turn.context.ctxPayload.MessageSid;
  }
  return projected ? createStructuredOutboundPayloadPlan([projected])[0]?.payload : undefined;
};

export function normalizeDeliveryPayload(
  turn: Turn,
  payload: ReplyPayload,
): ReplyPayload | undefined {
  const keepReasoningLane = payload.isReasoning === true && turn.durableReasoningPayloadsEnabled;
  const payloadForPlan = keepReasoningLane
    ? copyReplyPayloadMetadata(payload, { ...payload })
    : payload;
  if (keepReasoningLane) {
    delete payloadForPlan.isReasoning;
  }
  const normalized = projectPayloadForDelivery(turn, payloadForPlan);
  if (!normalized) {
    return undefined;
  }
  return normalizePreparedDeliveryPayload(turn, normalized);
}

export function normalizePreparedDeliveryPayload(turn: Turn, payload: ReplyPayload): ReplyPayload {
  // Retained finals can still select HTML at send time, and HTML bypasses
  // rich blocks. Converting a presentation here would strip it while the
  // final funnel is still undecided, so rich accounts defer canonicalization
  // to the sender which knows the text mode.
  if (turn.telegramCfg.richMessages === true && payload.presentation) {
    return payload;
  }
  return canonicalizeTelegramPresentationPayload(payload, {
    allowWebAppButtons: resolveTelegramTargetChatType(String(turn.context.chatId)) === "direct",
    richTables: false,
  });
}

export const usesNativeTelegramQuote = (turn: Turn, payload: ReplyPayload): boolean =>
  (turn.replyToMode !== "off" || payload.replyToTag === true || payload.replyToCurrent === true) &&
  (turn.replyQuoteText != null ||
    (payload.replyToId != null && turn.replyQuoteByMessageId[payload.replyToId] != null));

export function applyQuoteReplyTarget(turn: Turn, payload: ReplyPayload): ReplyPayload {
  if (
    !turn.implicitQuoteReplyTargetId ||
    !turn.currentMessageIdForQuoteReply ||
    payload.replyToId !== turn.currentMessageIdForQuoteReply ||
    payload.replyToTag ||
    payload.replyToCurrent
  ) {
    return payload;
  }
  return copyReplyPayloadMetadata(payload, {
    ...payload,
    replyToId: turn.implicitQuoteReplyTargetId,
  });
}

export function formatTelegramGroupThreadReply(
  text: string,
  participant: { name: string },
): string {
  const name = participant.name.replace(/[\\`*_{}[\]()<>#!|]/g, "\\$&").replace(/\s+/g, " ");
  return `**${name}**\n${text}`;
}
