import type { SourceReplyDeliveryMode } from "../../../auto-reply/get-reply-options.types.js";
import {
  copyReplyPayloadMetadata,
  getReplyPayloadMetadata,
  markReplyPayloadForSourceSuppressionMediaDelivery,
} from "../../../auto-reply/reply-payload.js";
import type { EmbeddedPiRunResult } from "../types.js";

type EmbeddedRunPayload = NonNullable<EmbeddedPiRunResult["payloads"]>[number];

export function mergeAttemptToolMediaPayloads(params: {
  payloads?: EmbeddedRunPayload[];
  toolMediaUrls?: string[];
  toolAudioAsVoice?: boolean;
  toolTrustedLocalMedia?: boolean;
  sourceReplyDeliveryMode?: SourceReplyDeliveryMode;
}): EmbeddedRunPayload[] | undefined {
  const mediaUrls = Array.from(
    new Set(params.toolMediaUrls?.map((url) => url.trim()).filter(Boolean) ?? []),
  );
  if (mediaUrls.length === 0 && !params.toolAudioAsVoice && !params.toolTrustedLocalMedia) {
    return params.payloads;
  }

  const payloads = params.payloads?.length ? [...params.payloads] : [];
  const shouldDeliverToolMediaDespiteSourceReplySuppression =
    params.sourceReplyDeliveryMode === "message_tool_only" &&
    params.toolAudioAsVoice === true &&
    params.toolTrustedLocalMedia === true &&
    mediaUrls.length > 0;
  const payloadIndex = payloads.findIndex((payload) => !payload.isReasoning);
  if (payloadIndex >= 0) {
    const payload = payloads[payloadIndex];
    if (
      params.sourceReplyDeliveryMode === "message_tool_only" &&
      getReplyPayloadMetadata(payload)?.sourceReplyTranscriptMirror
    ) {
      return payloads;
    }
    const mergedMediaUrls = Array.from(new Set([...(payload.mediaUrls ?? []), ...mediaUrls]));
    const mergedPayload = copyReplyPayloadMetadata(payload, {
      ...payload,
      mediaUrls: mergedMediaUrls.length ? mergedMediaUrls : undefined,
      mediaUrl: payload.mediaUrl ?? mergedMediaUrls[0],
      audioAsVoice: payload.audioAsVoice || params.toolAudioAsVoice || undefined,
      trustedLocalMedia: payload.trustedLocalMedia || params.toolTrustedLocalMedia || undefined,
    });
    payloads[payloadIndex] = shouldDeliverToolMediaDespiteSourceReplySuppression
      ? markReplyPayloadForSourceSuppressionMediaDelivery(mergedPayload)
      : mergedPayload;
    return payloads;
  }

  const mediaPayload: EmbeddedRunPayload = {
    mediaUrls: mediaUrls.length ? mediaUrls : undefined,
    mediaUrl: mediaUrls[0],
    audioAsVoice: params.toolAudioAsVoice || undefined,
    trustedLocalMedia: params.toolTrustedLocalMedia || undefined,
  };
  return [
    ...payloads,
    shouldDeliverToolMediaDespiteSourceReplySuppression
      ? markReplyPayloadForSourceSuppressionMediaDelivery(mediaPayload)
      : mediaPayload,
  ];
}
