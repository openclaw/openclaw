import { createAcceptedChannelDeliveryResult } from "openclaw/plugin-sdk/channel-inbound";
import {
  createPreviewMessageReceipt,
  isPotentialTruncatedFinal,
  resolveTranscriptBackedChannelFinalText,
  selectLongerFinalText,
  type LivePreviewDeliveryResult,
  type MessageReceipt,
} from "openclaw/plugin-sdk/channel-outbound";
import {
  buildTtsSupplementMediaPayload,
  copyReplyPayloadMetadata,
  getReplyPayloadTtsSupplement,
  resolveSendableOutboundReplyParts,
  type ReplyPayload,
} from "openclaw/plugin-sdk/reply-payload";
import { asOptionalRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { TelegramInlineButtons } from "./button-types.js";
import type { TelegramDraftStream } from "./draft-stream.js";
import type { TelegramPromptContextProjectionSequence } from "./prompt-context-projection.js";

export type LaneName = "answer" | "reasoning";

export type DraftLaneState = {
  stream: TelegramDraftStream | undefined;
  lastPartialText: string;
  hasStreamedMessage: boolean;
  finalized: boolean;
  retainedPromptContextPages: Array<{ messageId: number; text: string }>;
};

type LanePreviewFinalizedDelivery = {
  content: string;
  messageId: number;
  buttonsAttached?: boolean;
  receipt: MessageReceipt;
};

export type LaneDeliveryResult = (
  | {
      kind: "preview-finalized";
      delivery: LanePreviewFinalizedDelivery;
    }
  | {
      kind: "preview-finalized-partial";
      delivery: LanePreviewFinalizedDelivery;
      error: unknown;
      confirmedFinalContent?: true;
    }
  | { kind: "preview-retained" | "preview-updated" | "sent" | "skipped" }
) & { deliveryResult: LivePreviewDeliveryResult };

type CreateLaneTextDelivererParams = {
  lanes: Record<LaneName, DraftLaneState>;
  applyTextToPayload: (payload: ReplyPayload, text: string) => ReplyPayload;
  sendPayload: (
    payload: ReplyPayload,
    options?: {
      afterAcceptedDraft?: boolean;
      durable?: boolean;
      promptContextSequence?: TelegramPromptContextProjectionSequence;
      textMode?: "html";
      onPlatformSendDispatch?: () => Promise<void>;
      assertPlatformSendAuthorized?: () => void;
      bindPendingFinalDelivery?: <T extends ReplyPayload>(payload: T) => T;
      onMediaAccepted?: (mediaUrls: readonly string[]) => void;
    },
  ) => Promise<LivePreviewDeliveryResult>;
  flushDraftLane: (lane: DraftLaneState) => Promise<void>;
  stopDraftLane: (lane: DraftLaneState) => Promise<void>;
  clearDraftLane: (lane: DraftLaneState) => Promise<void>;
  editStreamMessage: (params: {
    laneName: LaneName;
    messageId: number;
    text: string;
    textMode?: "html" | "markdown";
    buttons?: TelegramInlineButtons;
  }) => Promise<void>;
  createPromptContextSequence: () => TelegramPromptContextProjectionSequence;
  resolveFinalPayloadCandidate?: (params: {
    finalText: string;
    laneName: LaneName;
    payload: ReplyPayload;
    candidateTexts: readonly (string | undefined)[];
  }) => Promise<ReplyPayload | undefined> | ReplyPayload | undefined;
  resolveFinalPresentationText?: (params: {
    payload: ReplyPayload;
    text: string;
  }) => Promise<string | undefined> | string | undefined;
  log: (message: string) => void;
  markDelivered: () => void;
};

type DeliverLaneTextParams = {
  laneName: LaneName;
  text: string;
  payload: ReplyPayload;
  /** Target before caller-side recovery; omitted uses the incoming payload. */
  replyTargetBeforeRecovery?: Readonly<Pick<ReplyPayload, "replyToId">>;
  infoKind: string;
  buttons?: TelegramInlineButtons;
  finalizePreview?: boolean;
  durable?: boolean;
  allowStream?: boolean;
  promptContextSequence?: TelegramPromptContextProjectionSequence;
  onPlatformSendDispatch?: () => Promise<void>;
  assertPlatformSendAuthorized?: () => void;
  bindPendingFinalDelivery?: <T extends ReplyPayload>(payload: T) => T;
  onMediaAccepted?: (mediaUrls: readonly string[]) => void;
};

export type LaneTextDeliverer = (params: DeliverLaneTextParams) => Promise<LaneDeliveryResult>;

export function createLaneTextDeliverer(params: CreateLaneTextDelivererParams): LaneTextDeliverer {
  const mediaChannelData = (
    channelData: ReplyPayload["channelData"],
    options?: { stripButtons?: boolean },
  ): ReplyPayload["channelData"] => {
    if (!options?.stripButtons) {
      return channelData;
    }
    const telegramData = asOptionalRecord(channelData?.telegram);
    if (!telegramData) {
      return channelData;
    }
    const { buttons: _buttons, ...telegramRest } = telegramData;
    if (_buttons === undefined) {
      return channelData;
    }
    const next: Record<string, unknown> = { ...channelData };
    if (Object.keys(telegramRest).length > 0) {
      next.telegram = telegramRest;
    } else {
      delete next.telegram;
    }
    return Object.keys(next).length > 0 ? next : undefined;
  };
  const withMediaChannelData = (
    payload: ReplyPayload,
    options?: { stripButtons?: boolean },
  ): ReplyPayload => {
    const channelData = mediaChannelData(payload.channelData, options);
    if (channelData === payload.channelData) {
      return payload;
    }
    if (channelData) {
      return copyReplyPayloadMetadata(payload, { ...payload, channelData });
    }
    const { channelData: _channelData, ...rest } = payload;
    return copyReplyPayloadMetadata(payload, rest);
  };
  const withFallbackTelegramButtons = (
    payload: ReplyPayload,
    buttons: TelegramInlineButtons | undefined,
  ): ReplyPayload => {
    if (!buttons) {
      return payload;
    }
    const channelData = payload.channelData ?? {};
    const telegramData = asOptionalRecord(channelData.telegram);
    if (telegramData && "buttons" in telegramData) {
      return payload;
    }
    return copyReplyPayloadMetadata(payload, {
      ...payload,
      channelData: {
        ...channelData,
        telegram: {
          ...telegramData,
          buttons,
        },
      },
    });
  };
  const mediaOnlyPayload = (
    payload: ReplyPayload,
    text: string,
    options?: { stripButtons?: boolean; fallbackButtons?: TelegramInlineButtons },
  ): ReplyPayload => {
    let mediaPayload: ReplyPayload;
    if (getReplyPayloadTtsSupplement(payload)) {
      mediaPayload = buildTtsSupplementMediaPayload(params.applyTextToPayload(payload, text));
    } else if (payload.audioAsVoice === true) {
      const {
        text: _text,
        presentation: _presentation,
        interactive: _interactive,
        btw: _btw,
        spokenText: _spokenText,
        ...voicePayload
      } = params.applyTextToPayload(payload, text);
      mediaPayload = copyReplyPayloadMetadata(payload, { ...voicePayload, spokenText: text });
    } else {
      const {
        text: _text,
        presentation: _presentation,
        interactive: _interactive,
        btw: _btw,
        ...rest
      } = payload;
      mediaPayload = copyReplyPayloadMetadata(payload, rest);
    }
    return withFallbackTelegramButtons(
      withMediaChannelData(mediaPayload, options),
      options?.fallbackButtons,
    );
  };

  const clearUnfinalizedStream = async (lane: DraftLaneState) => {
    if (!lane.stream || lane.finalized) {
      return;
    }
    await params.clearDraftLane(lane);
    lane.lastPartialText = "";
    lane.hasStreamedMessage = false;
  };

  const discardUnmaterializedStream = async (lane: DraftLaneState) => {
    const stream = lane.stream;
    if (stream) {
      await stream.discard();
      stream.forceNewMessage();
    }
    lane.lastPartialText = "";
    lane.hasStreamedMessage = false;
    lane.finalized = false;
  };

  const rotateFinalizedStream = (lane: DraftLaneState) => {
    if (!lane.stream || !lane.finalized) {
      return;
    }
    lane.stream.forceNewMessage();
    lane.lastPartialText = "";
    lane.hasStreamedMessage = false;
    lane.finalized = false;
  };

  const recordRetainedPromptContextPages = async (
    lane: DraftLaneState,
    sequence: TelegramPromptContextProjectionSequence,
  ): Promise<void> => {
    for (const page of lane.retainedPromptContextPages.splice(0)) {
      await sequence.accept(page);
    }
  };

  const streamText = async (
    laneName: LaneName,
    lane: DraftLaneState,
    text: string,
    payload: ReplyPayload,
    useFinalTextRecovery: boolean,
    finalizePreview: boolean,
    buttons: TelegramInlineButtons | undefined,
    promptContextSequence: TelegramPromptContextProjectionSequence,
    followedByDurablePayload = false,
    allowErrorPayload = false,
    onPlatformSendDispatch?: () => Promise<void>,
    assertPlatformSendAuthorized?: () => void,
  ): Promise<LaneDeliveryResult | undefined> => {
    const stream = lane.stream;
    if (!stream || text.length === 0 || (payload.isError && !allowErrorPayload)) {
      return undefined;
    }
    rotateFinalizedStream(lane);

    const finalText = text.trimEnd();
    const recoveredText = useFinalTextRecovery
      ? await resolveTranscriptBackedChannelFinalText({
          payload,
          finalText,
          resolveCandidateText: async () =>
            selectLongerFinalText({
              finalText,
              candidateTexts: [stream.lastDeliveredText(), lane.lastPartialText],
            }),
        })
      : finalText;
    const previewText =
      finalizePreview && payload.presentation
        ? ((await params.resolveFinalPresentationText?.({
            payload,
            text: recoveredText,
          })) ?? recoveredText)
        : recoveredText;
    lane.lastPartialText = previewText;
    lane.hasStreamedMessage = true;
    lane.finalized = false;
    const previewAlreadyVisible = stream.lastDeliveredText() === previewText;
    if (!previewAlreadyVisible) {
      if (finalizePreview && onPlatformSendDispatch) {
        stream.update(previewText, {
          onPlatformSendDispatch,
          assertPlatformSendAuthorized,
        });
      } else {
        stream.update(previewText);
      }
    } else if (finalizePreview) {
      await onPlatformSendDispatch?.();
      assertPlatformSendAuthorized?.();
    }
    if (finalizePreview) {
      if (previewAlreadyVisible) {
        // Cleanup cannot invalidate an accepted preview or create fresh send custody.
        await params.stopDraftLane(lane).catch(() => undefined);
      } else {
        await params.stopDraftLane(lane);
      }
    } else {
      await params.flushDraftLane(lane);
      if (buttons) {
        await stream.waitForInFlight();
      }
    }
    const messageId = stream.messageId();
    if (typeof messageId !== "number") {
      if (finalizePreview && stream.sendMayHaveLanded()) {
        const retainedDelivery = lane.retainedPromptContextPages.length
          ? createAcceptedChannelDeliveryResult({
              results: lane.retainedPromptContextPages.map(({ messageId: acceptedPageId }) => ({
                messageId: String(acceptedPageId),
              })),
            })
          : undefined;
        await recordRetainedPromptContextPages(lane, promptContextSequence);
        await promptContextSequence.fail();
        return {
          kind: "preview-retained",
          deliveryResult: {
            visibleReplySent: false,
            ...retainedDelivery,
            suppression: { reason: "adapter_returned_no_identity" },
          },
        };
      }
      if (!finalizePreview) {
        await discardUnmaterializedStream(lane);
      }
      return undefined;
    }
    if (finalizePreview && stream.lastDeliveredText() !== previewText) {
      // Retained pagination pages stay concrete while normal delivery resumes
      // the suffix, so their shared projection sequence remains valid.
      if (
        !lane.retainedPromptContextPages.length ||
        !stream.remainingFinalContent()?.text.trimEnd()
      ) {
        promptContextSequence.invalidate();
      }
      return undefined;
    }

    params.markDelivered();
    const activeSnapshot = finalizePreview || buttons ? stream.currentMessageSnapshot() : undefined;
    let buttonsAttached = false;
    let buttonAttachmentError: unknown;
    if (buttons && activeSnapshot) {
      try {
        await onPlatformSendDispatch?.();
        assertPlatformSendAuthorized?.();
        await params.editStreamMessage({
          laneName,
          messageId,
          text: activeSnapshot.sourceText,
          ...(activeSnapshot.sourceTextMode ? { textMode: activeSnapshot.sourceTextMode } : {}),
          buttons,
        });
        buttonsAttached = true;
      } catch (err) {
        buttonAttachmentError = err;
        params.log(`telegram: ${laneName} stream button edit failed: ${String(err)}`);
      }
    }
    if (!finalizePreview && buttonAttachmentError === undefined) {
      return {
        kind: "preview-updated",
        deliveryResult: {
          visibleReplySent: true,
          receipt: createPreviewMessageReceipt({ id: messageId }),
        },
      };
    }
    if (!activeSnapshot) {
      if (finalizePreview) {
        promptContextSequence.invalidate();
      }
      return undefined;
    }
    lane.finalized = true;
    const delivery = {
      content: previewText,
      messageId,
      buttonsAttached,
      receipt: createPreviewMessageReceipt({ id: messageId }),
    };
    const deliveryResult = {
      visibleReplySent: true,
      receipt: delivery.receipt,
      content: previewText,
    };
    try {
      await recordRetainedPromptContextPages(lane, promptContextSequence);
      await promptContextSequence.accept({ messageId, text: activeSnapshot.text });
      if (!followedByDurablePayload) {
        await promptContextSequence.finish();
      }
    } catch (error) {
      promptContextSequence.invalidate();
      return {
        kind: "preview-finalized-partial",
        delivery,
        deliveryResult,
        error,
        confirmedFinalContent:
          !buttonAttachmentError && !followedByDurablePayload ? true : undefined,
      };
    }
    return buttonAttachmentError
      ? {
          kind: "preview-finalized-partial",
          delivery,
          deliveryResult,
          error: buttonAttachmentError,
        }
      : { kind: "preview-finalized", delivery, deliveryResult };
  };

  return async ({
    laneName,
    text: initialText,
    payload: initialPayload,
    replyTargetBeforeRecovery = initialPayload,
    infoKind,
    buttons,
    finalizePreview: requestedFinalizePreview,
    durable: requestedDurable,
    allowStream = true,
    promptContextSequence: suppliedPromptContextSequence,
    onPlatformSendDispatch,
    assertPlatformSendAuthorized,
    bindPendingFinalDelivery,
    onMediaAccepted,
  }: DeliverLaneTextParams): Promise<LaneDeliveryResult> => {
    let text = initialText;
    let payload = initialPayload;
    const lane = params.lanes[laneName];
    const promptContextSequence =
      suppliedPromptContextSequence ?? params.createPromptContextSequence();
    const originalReplyToId = replyTargetBeforeRecovery.replyToId;
    let reply = resolveSendableOutboundReplyParts(payload, { text });
    const isDurableFinal = infoKind === "final";
    const finalizePreview = requestedFinalizePreview ?? isDurableFinal;
    const durable = requestedDurable ?? isDurableFinal;
    let streamedErrorDraftText =
      allowStream &&
      isDurableFinal &&
      payload.isError === true &&
      laneName === "answer" &&
      lane.stream &&
      lane.hasStreamedMessage &&
      !lane.finalized &&
      !reply.hasMedia &&
      text.trim()
        ? (() => {
            const existing = (
              lane.lastPartialText ||
              lane.stream?.lastDeliveredText() ||
              ""
            ).trimEnd();
            const notice = text.trim();
            return existing && !existing.endsWith(notice)
              ? `${existing}\n\n${notice}`
              : existing || notice;
          })()
        : undefined;
    const recoveryText = streamedErrorDraftText ?? text;
    const canRecoverFromTextPreview =
      allowStream && !reply.hasMedia && (!payload.isError || streamedErrorDraftText !== undefined);
    const canRecoverFromMediaPreview =
      allowStream &&
      finalizePreview &&
      reply.hasMedia &&
      lane.hasStreamedMessage &&
      !lane.finalized &&
      !payload.isError;
    if (
      isDurableFinal &&
      lane.stream &&
      (canRecoverFromTextPreview || canRecoverFromMediaPreview) &&
      isPotentialTruncatedFinal(recoveryText)
    ) {
      let candidate: ReplyPayload | undefined;
      await resolveTranscriptBackedChannelFinalText({
        payload,
        finalText: recoveryText,
        resolveCandidateText: async () => {
          candidate = await params.resolveFinalPayloadCandidate?.({
            finalText: recoveryText,
            laneName,
            payload,
            candidateTexts: [lane.stream?.lastDeliveredText(), lane.lastPartialText],
          });
          return candidate?.text;
        },
      });
      if (candidate) {
        payload = candidate;
        text = candidate.text ?? "";
        reply = resolveSendableOutboundReplyParts(payload, { text });
        streamedErrorDraftText = streamedErrorDraftText === undefined ? undefined : text;
      }
    }
    const preservesPreviewReplyTarget =
      payload.replyToId === undefined || payload.replyToId === originalReplyToId;
    const streamed =
      preservesPreviewReplyTarget && allowStream && !reply.hasMedia
        ? await streamText(
            laneName,
            lane,
            streamedErrorDraftText ?? text,
            payload,
            isDurableFinal,
            finalizePreview,
            buttons,
            promptContextSequence,
            false,
            streamedErrorDraftText !== undefined,
            onPlatformSendDispatch,
            assertPlatformSendAuthorized,
          )
        : undefined;
    if (streamed) {
      return streamed;
    }

    if (
      preservesPreviewReplyTarget &&
      allowStream &&
      finalizePreview &&
      reply.hasMedia &&
      lane.stream &&
      lane.hasStreamedMessage &&
      !lane.finalized &&
      text.trim().length > 0
    ) {
      const finalizedPreview = await streamText(
        laneName,
        lane,
        text,
        payload,
        isDurableFinal,
        true,
        buttons,
        promptContextSequence,
        true,
        false,
        onPlatformSendDispatch,
        assertPlatformSendAuthorized,
      );
      if (finalizedPreview) {
        if (finalizedPreview.kind === "preview-finalized-partial") {
          return finalizedPreview;
        }
        const stripButtons =
          finalizedPreview.kind === "preview-finalized" &&
          finalizedPreview.delivery.buttonsAttached === true;
        const mediaText =
          finalizedPreview.kind === "preview-finalized" ? finalizedPreview.delivery.content : text;
        try {
          const mediaDelivery = await params.sendPayload(
            mediaOnlyPayload(payload, mediaText, {
              stripButtons,
              fallbackButtons: stripButtons ? undefined : buttons,
            }),
            {
              afterAcceptedDraft: true,
              durable,
              promptContextSequence,
              onPlatformSendDispatch,
              assertPlatformSendAuthorized,
              bindPendingFinalDelivery,
              onMediaAccepted,
            },
          );
          const suppression =
            finalizedPreview.deliveryResult.suppression?.reason === "adapter_returned_no_identity"
              ? finalizedPreview.deliveryResult.suppression
              : (mediaDelivery.suppression ?? finalizedPreview.deliveryResult.suppression);
          return {
            ...finalizedPreview,
            deliveryResult: {
              ...(mediaDelivery.visibleReplySent
                ? createAcceptedChannelDeliveryResult({
                    deliveryResults: [finalizedPreview.deliveryResult, mediaDelivery],
                  })
                : finalizedPreview.deliveryResult),
              ...(suppression ? { suppression } : {}),
              ...(mediaDelivery.deliveryIntent
                ? { deliveryIntent: mediaDelivery.deliveryIntent }
                : {}),
            },
          };
        } catch (error) {
          if (durable && finalizedPreview.kind === "preview-finalized") {
            return { ...finalizedPreview, kind: "preview-finalized-partial", error };
          }
          throw error;
        }
      }
    }

    const retainedFinalContent =
      preservesPreviewReplyTarget && finalizePreview && lane.retainedPromptContextPages.length > 0
        ? lane.stream?.remainingFinalContent()
        : undefined;
    const afterAcceptedDraft =
      retainedFinalContent !== undefined || lane.stream?.hasConsumedReplyTarget() === true;

    if (finalizePreview) {
      await recordRetainedPromptContextPages(lane, promptContextSequence);
      await lane.stream?.discard().catch((error: unknown) => {
        params.log(`telegram: ${laneName} draft discard failed: ${String(error)}`);
      });
    }

    // Accepted pagination pages remain visible. If bounded final retries exhaust,
    // deliver only the unaccepted suffix so fallback cannot duplicate the prefix.
    const deliveryResult = await params.sendPayload(
      params.applyTextToPayload(payload, retainedFinalContent?.sourceText ?? text),
      {
        afterAcceptedDraft,
        durable,
        promptContextSequence,
        onPlatformSendDispatch,
        assertPlatformSendAuthorized,
        bindPendingFinalDelivery,
        onMediaAccepted,
        ...(retainedFinalContent?.sourceTextMode === "html" ? { textMode: "html" } : {}),
      },
    );
    if (deliveryResult.visibleReplySent && finalizePreview && !isDurableFinal) {
      await clearUnfinalizedStream(lane);
    }
    return { kind: deliveryResult.visibleReplySent ? "sent" : "skipped", deliveryResult };
  };
}
