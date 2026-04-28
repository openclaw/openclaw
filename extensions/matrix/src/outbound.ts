import {
  renderMessagePresentationFallbackText,
  type MessagePresentation,
} from "openclaw/plugin-sdk/interactive-runtime";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";
import { sendMessageMatrix, sendPollMatrix } from "./matrix/send.js";
import type { MatrixExtraContentFields } from "./matrix/send/types.js";
import {
  chunkTextForOutbound,
  resolveOutboundSendDep,
  type ChannelOutboundAdapter,
} from "./runtime-api.js";

const MATRIX_OPENCLAW_PRESENTATION_KEY = "com.openclaw.presentation" as const;

type MatrixChannelData = {
  extraContent?: MatrixExtraContentFields;
};

function toRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function resolveMatrixChannelData(payload: ReplyPayload): MatrixChannelData {
  const raw = toRecord(payload.channelData)?.matrix;
  return (toRecord(raw) as MatrixChannelData | undefined) ?? {};
}

function buildMatrixPresentationContent(presentation: MessagePresentation) {
  return {
    version: 1,
    ...presentation,
  };
}

function renderMatrixPresentationPayload(params: {
  payload: ReplyPayload;
  presentation: MessagePresentation;
}): ReplyPayload {
  const matrixData = resolveMatrixChannelData(params.payload);
  return {
    ...params.payload,
    text: renderMessagePresentationFallbackText({
      text: params.payload.text,
      presentation: params.presentation,
    }),
    channelData: {
      ...params.payload.channelData,
      matrix: {
        ...matrixData,
        extraContent: {
          ...matrixData.extraContent,
          [MATRIX_OPENCLAW_PRESENTATION_KEY]: buildMatrixPresentationContent(params.presentation),
        },
      },
    },
  };
}

function resolveMatrixExtraContent(payload: ReplyPayload): MatrixExtraContentFields | undefined {
  const extraContent = resolveMatrixChannelData(payload).extraContent;
  return extraContent && Object.keys(extraContent).length > 0 ? extraContent : undefined;
}

export const matrixOutbound: ChannelOutboundAdapter = {
  deliveryMode: "direct",
  chunker: chunkTextForOutbound,
  chunkerMode: "markdown",
  textChunkLimit: 4000,
  presentationCapabilities: {
    supported: true,
    buttons: true,
    selects: true,
    context: true,
    divider: true,
  },
  renderPresentation: ({ payload, presentation }) =>
    renderMatrixPresentationPayload({ payload, presentation }),
  sendPayload: async ({
    cfg,
    to,
    payload,
    mediaLocalRoots,
    mediaReadFile,
    mediaAccess,
    deps,
    replyToId,
    threadId,
    accountId,
    audioAsVoice,
  }) => {
    const send =
      resolveOutboundSendDep<typeof sendMessageMatrix>(deps, "matrix") ?? sendMessageMatrix;
    const resolvedThreadId =
      threadId !== undefined && threadId !== null ? String(threadId) : undefined;
    const result = await send(to, payload.text ?? "", {
      cfg,
      mediaUrl: payload.mediaUrl,
      mediaAccess,
      mediaLocalRoots,
      mediaReadFile,
      replyToId: replyToId ?? undefined,
      threadId: resolvedThreadId,
      accountId: accountId ?? undefined,
      audioAsVoice,
      extraContent: resolveMatrixExtraContent(payload),
    });
    return {
      channel: "matrix",
      messageId: result.messageId,
      roomId: result.roomId,
    };
  },
  sendText: async ({ cfg, to, text, deps, replyToId, threadId, accountId, audioAsVoice }) => {
    const send =
      resolveOutboundSendDep<typeof sendMessageMatrix>(deps, "matrix") ?? sendMessageMatrix;
    const resolvedThreadId =
      threadId !== undefined && threadId !== null ? String(threadId) : undefined;
    const result = await send(to, text, {
      cfg,
      replyToId: replyToId ?? undefined,
      threadId: resolvedThreadId,
      accountId: accountId ?? undefined,
      audioAsVoice,
    });
    return {
      channel: "matrix",
      messageId: result.messageId,
      roomId: result.roomId,
    };
  },
  sendMedia: async ({
    cfg,
    to,
    text,
    mediaUrl,
    mediaLocalRoots,
    mediaReadFile,
    deps,
    replyToId,
    threadId,
    accountId,
    audioAsVoice,
  }) => {
    const send =
      resolveOutboundSendDep<typeof sendMessageMatrix>(deps, "matrix") ?? sendMessageMatrix;
    const resolvedThreadId =
      threadId !== undefined && threadId !== null ? String(threadId) : undefined;
    const result = await send(to, text, {
      cfg,
      mediaUrl,
      mediaLocalRoots,
      mediaReadFile,
      replyToId: replyToId ?? undefined,
      threadId: resolvedThreadId,
      accountId: accountId ?? undefined,
      audioAsVoice,
    });
    return {
      channel: "matrix",
      messageId: result.messageId,
      roomId: result.roomId,
    };
  },
  sendPoll: async ({ cfg, to, poll, threadId, accountId }) => {
    const resolvedThreadId = threadId !== undefined && threadId !== null ? threadId : undefined;
    const result = await sendPollMatrix(to, poll, {
      cfg,
      threadId: resolvedThreadId,
      accountId: accountId ?? undefined,
    });
    return {
      channel: "matrix",
      messageId: result.eventId,
      roomId: result.roomId,
      pollId: result.eventId,
    };
  },
};
