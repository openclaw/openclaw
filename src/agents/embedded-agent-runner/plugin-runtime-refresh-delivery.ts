import {
  copyReplyPayloadMetadata,
  getReplyPayloadMetadata,
} from "../../auto-reply/reply-payload.js";
import {
  filterMessagingToolMediaDuplicates,
  filterMessagingToolReplyPayload,
  resolveMessagingToolPayloadDedupe,
} from "../../auto-reply/reply/reply-payloads-dedupe.js";
import type { ReplyPayload } from "../../auto-reply/types.js";
import { hasReplyPayloadContent } from "../../interactive/payload.js";
import {
  normalizeTextForComparison,
  resolveCurrentSourceMessagingToolPartial,
} from "../embedded-agent-helpers/messaging-dedupe.js";
import type { AttemptDeliveryState } from "./run/attempt-delivery-state.js";
import type { RunEmbeddedAgentParamsWithSessionFile } from "./run/internal-params.js";

type DeliveryCallbacks = Pick<
  RunEmbeddedAgentParamsWithSessionFile,
  "onPartialReply" | "onBlockReply" | "onReasoningStream" | "onAssistantMessageStart"
>;

/** Prior generations retain send facts; each runtime still records only its own attempt. */
export function createInheritedDeliveryCallbacks(
  params: RunEmbeddedAgentParamsWithSessionFile,
  callbacks: DeliveryCallbacks,
  delivery: AttemptDeliveryState,
): DeliveryCallbacks {
  const route = {
    config: params.config,
    messageProvider: params.messageChannel ?? params.messageProvider,
    originatingTo: params.messageTo ?? params.currentMessagingTarget ?? params.currentChannelId,
    originatingThreadId: params.messageThreadId ?? params.currentThreadTs,
    accountId: params.agentAccountId,
    messagingToolSentTargets: delivery.messagingToolSentTargets,
  };
  const decision = resolveMessagingToolPayloadDedupe(route);
  const sentTexts = decision.shouldDedupePayloads
    ? decision.matchingRoute && !decision.useGlobalSentTextEvidenceFallback
      ? decision.routeSentTexts
      : delivery.messagingToolSentTexts
    : [];
  const sentMediaUrls = decision.shouldDedupePayloads
    ? decision.matchingRoute && !decision.useGlobalSentMediaUrlEvidenceFallback
      ? decision.routeSentMediaUrls
      : delivery.messagingToolSentMediaUrls
    : [];
  const partial: Parameters<typeof resolveCurrentSourceMessagingToolPartial>[0] = {
    currentSourceMessagingToolHeldPartial: undefined,
    currentSourceMessagingToolSentTextsNormalized: sentTexts.map(normalizeTextForComparison),
  };
  const toolOnlySourceDelivered =
    params.sourceReplyDeliveryMode === "message_tool_only" &&
    (delivery.didDeliverSourceReplyViaMessageTool ||
      (delivery.messagingToolSourceReplyPayloads?.length ?? 0) > 0);
  const filter = (payload: ReplyPayload) =>
    filterMessagingToolReplyPayload({
      ...route,
      payload,
      sentTexts: delivery.messagingToolSentTexts,
      sentMediaUrls: delivery.messagingToolSentMediaUrls,
    }).filter((next) => next === payload || hasReplyPayloadContent(next));

  return {
    onAssistantMessageStart: () => {
      partial.currentSourceMessagingToolHeldPartial = undefined;
      return callbacks.onAssistantMessageStart?.();
    },
    onPartialReply: callbacks.onPartialReply
      ? (payload) => {
          if (toolOnlySourceDelivered) {
            return false;
          }
          const text = payload.text ?? payload.delta ?? "";
          const held = partial.currentSourceMessagingToolHeldPartial;
          const resolved = resolveCurrentSourceMessagingToolPartial(partial, {
            evtType: payload.delta && !payload.replace ? "text_delta" : "text_end",
            text,
            visibleDelta: payload.delta ?? "",
          });
          if (resolved.hold && !payload.mediaUrls?.length) {
            return false;
          }
          // A withheld prefix never reached the receiver; divergence releases a full snapshot.
          const next = {
            ...payload,
            text: resolved.hold ? undefined : resolved.text,
            ...(held || resolved.text !== text || resolved.hold
              ? { delta: resolved.hold ? undefined : resolved.text, replace: true as const }
              : {}),
          };
          const filtered = filterMessagingToolMediaDuplicates({
            payloads: [next],
            sentMediaUrls,
          })[0];
          return filtered && hasReplyPayloadContent(filtered)
            ? callbacks.onPartialReply?.(filtered)
            : false;
        }
      : undefined,
    onBlockReply: callbacks.onBlockReply
      ? async (payload, context) => {
          const metadata = getReplyPayloadMetadata(payload);
          if (metadata?.sourceReplyTranscriptMirror) {
            await callbacks.onBlockReply?.(payload, context);
            return;
          }
          if (toolOnlySourceDelivered && !metadata?.deliverDespiteSourceReplySuppression) {
            return;
          }
          for (const next of filter(payload)) {
            await callbacks.onBlockReply?.(copyReplyPayloadMetadata(payload, next), context);
          }
        }
      : undefined,
    onReasoningStream: callbacks.onReasoningStream
      ? (payload) => {
          if (!toolOnlySourceDelivered) {
            return callbacks.onReasoningStream?.(payload);
          }
        }
      : undefined,
  };
}
