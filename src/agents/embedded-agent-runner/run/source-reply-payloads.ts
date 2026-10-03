import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { SourceReplyDeliveryMode } from "../../../auto-reply/get-reply-options.types.js";
import {
  markReplyPayloadForSourceSuppressionDelivery,
  setReplyPayloadMetadata,
  type ReplyPayload,
} from "../../../auto-reply/reply-payload.js";
import type {
  MessagingToolSend,
  MessagingToolSourceReplyPayload,
} from "../../embedded-agent-messaging.types.js";
import { resolveExplicitFinalSourceReplyDeliveryEvidence } from "../delivery-evidence.js";

/** Builds transcript mirrors and completion evidence for message-tool source replies. */
export function buildSourceReplyPayloadState(params: {
  payloads?: MessagingToolSourceReplyPayload[];
  sentTargets?: MessagingToolSend[];
  sourceReplyDeliveryMode?: SourceReplyDeliveryMode;
  didDeliverSourceReplyViaMessageTool?: boolean;
  runId?: string;
  sessionKey: string;
  agentId?: string;
}): {
  replyItems: ReplyPayload[];
  hasSourceReplyPayload: boolean;
  deliveredSourceReplyViaMessageTool: boolean;
  completedSourceReplyViaMessageTool: boolean;
} {
  const sourceReplyPayloads = params.payloads ?? [];
  const replyItems = sourceReplyPayloads.flatMap((payload, index): ReplyPayload[] => {
    const text = normalizeOptionalString(payload.text) ?? "";
    const media = (
      payload.mediaUrls?.length ? payload.mediaUrls : payload.mediaUrl ? [payload.mediaUrl] : []
    ).filter((value) => value.trim().length > 0);
    if (
      !text &&
      media.length === 0 &&
      !payload.presentation &&
      !payload.interactive &&
      !payload.channelData
    ) {
      return [];
    }
    const base: ReplyPayload = {
      text,
      ...(payload.mediaUrl || media[0] ? { mediaUrl: payload.mediaUrl || media[0] } : {}),
      ...(media.length ? { mediaUrls: media } : {}),
      ...(payload.audioAsVoice ? { audioAsVoice: true } : {}),
      ...(payload.attachments?.length ? { attachments: payload.attachments } : {}),
      ...(payload.trustedLocalMedia !== undefined
        ? { trustedLocalMedia: payload.trustedLocalMedia }
        : {}),
      ...(payload.presentation ? { presentation: payload.presentation } : {}),
      ...(payload.interactive ? { interactive: payload.interactive } : {}),
      ...(payload.channelData ? { channelData: payload.channelData } : {}),
    };
    // A tool-authored reply has not reached the channel yet: the host delivers
    // it like assistant text, and its transcript row was already persisted at
    // tool completion.
    if (payload.toolAuthored) {
      return [base];
    }
    // Every other source reply was already sent by the tool. Mirror it into the
    // transcript while marking channel delivery to suppress a duplicate send.
    const reply = markReplyPayloadForSourceSuppressionDelivery(base);
    if (params.sessionKey) {
      const idempotencyKey =
        payload.idempotencyKey ??
        (params.runId ? `${params.runId}:internal-source-reply:${index}` : undefined);
      setReplyPayloadMetadata(reply, {
        sourceReplyTranscriptMirror: {
          sessionKey: params.sessionKey,
          ...(params.agentId ? { agentId: params.agentId } : {}),
          ...(text ? { text } : {}),
          ...(media.length ? { mediaUrls: media } : {}),
          ...(idempotencyKey ? { idempotencyKey } : {}),
          ...(payload.transcriptOwner ? { transcriptOwner: true } : {}),
        },
      });
    }
    return [reply];
  });
  const hasSourceReplyPayload = replyItems.length > 0;
  const deliveredSourceReplyViaMessageTool =
    params.sourceReplyDeliveryMode === "message_tool_only" &&
    params.didDeliverSourceReplyViaMessageTool === true;
  const explicitFinalSourceReply = resolveExplicitFinalSourceReplyDeliveryEvidence({
    messagingToolSentTargets: params.sentTargets,
    messagingToolSourceReplyPayloads: sourceReplyPayloads,
  });
  return {
    replyItems,
    hasSourceReplyPayload,
    deliveredSourceReplyViaMessageTool,
    completedSourceReplyViaMessageTool:
      explicitFinalSourceReply ?? (hasSourceReplyPayload || deliveredSourceReplyViaMessageTool),
  };
}
