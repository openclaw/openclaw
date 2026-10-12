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
import { resolveTelegramReplyId } from "./bot/helpers.js";
import type { TelegramInlineButtons } from "./button-types.js";
import type { TelegramDraftStream } from "./draft-stream.js";
import { applyTextToPayload } from "./interactive-fallback.js";
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

export type TelegramSendPayloadOptions = {
  afterAcceptedDraft?: boolean;
  durable?: boolean;
  silent?: boolean;
  promptContextSequence?: TelegramPromptContextProjectionSequence;
  textMode?: "html";
  onPlatformSendDispatch?: () => Promise<void>;
  assertPlatformSendAuthorized?: () => void;
  bindPendingFinalDelivery?: <T extends ReplyPayload>(payload: T) => T;
  onMediaAccepted?: (mediaUrls: readonly string[]) => void;
};

type CreateLaneTextDelivererParams = {
  lanes: Record<LaneName, DraftLaneState>;
  sendPayload: (
    payload: ReplyPayload,
    options?: TelegramSendPayloadOptions,
  ) => Promise<LivePreviewDeliveryResult>;
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

type DeliverLaneTextParams = Omit<
  TelegramSendPayloadOptions,
  "afterAcceptedDraft" | "silent" | "textMode"
> & {
  laneName: LaneName;
  text: string;
  payload: ReplyPayload;
  infoKind: string;
  buttons?: TelegramInlineButtons;
  finalizePreview?: boolean;
  allowStream?: boolean;
};

export type LaneTextDeliverer = (params: DeliverLaneTextParams) => Promise<LaneDeliveryResult>;

export function createLaneTextDeliverer(params: CreateLaneTextDelivererParams): LaneTextDeliverer {
  const recordRetainedPromptContextPages = async (
    lane: DraftLaneState,
    sequence: TelegramPromptContextProjectionSequence,
  ): Promise<void> => {
    for (const page of lane.retainedPromptContextPages.splice(0)) {
      await sequence.accept(page);
    }
  };

  return async ({
    laneName,
    text: initialText,
    payload: initialPayload,
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
    let reply = resolveSendableOutboundReplyParts(payload, { text });
    const isDurableFinal = infoKind === "final";
    const finalizePreview = requestedFinalizePreview ?? isDurableFinal;
    const durable = requestedDurable ?? isDurableFinal;
    const sendOptions = {
      durable,
      promptContextSequence,
      onPlatformSendDispatch,
      assertPlatformSendAuthorized,
      bindPendingFinalDelivery,
      onMediaAccepted,
    };
    let streamedErrorDraftText: string | undefined;
    if (
      allowStream &&
      isDurableFinal &&
      payload.isError === true &&
      laneName === "answer" &&
      lane.stream &&
      lane.hasStreamedMessage &&
      !lane.finalized &&
      !reply.hasMedia &&
      text.trim()
    ) {
      const existing = (lane.lastPartialText || lane.stream.lastDeliveredText() || "").trimEnd();
      const notice = text.trim();
      streamedErrorDraftText =
        existing && !existing.endsWith(notice) ? `${existing}\n\n${notice}` : existing || notice;
    }
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
    // Telegram edits cannot retarget an already-sent preview.
    const preservesPreviewReplyTarget =
      payload.replyToId === undefined ||
      resolveTelegramReplyId(payload.replyToId) ===
        lane.stream?.currentMessageSnapshot()?.replyToMessageId;
    const canFinalizeMediaPreview =
      finalizePreview &&
      lane.stream &&
      lane.hasStreamedMessage &&
      !lane.finalized &&
      text.trim().length > 0;
    const streamText = async (): Promise<LaneDeliveryResult | undefined> => {
      const previewInput = streamedErrorDraftText ?? text;
      const followedByDurablePayload = reply.hasMedia;
      const allowErrorPayload = !reply.hasMedia && streamedErrorDraftText !== undefined;
      const stream = lane.stream;
      if (!stream || previewInput.length === 0 || (payload.isError && !allowErrorPayload)) {
        return undefined;
      }
      if (lane.finalized) {
        stream.forceNewMessage();
        lane.lastPartialText = "";
        lane.hasStreamedMessage = false;
        lane.finalized = false;
      }

      const finalText = previewInput.trimEnd();
      const recoveredText = isDurableFinal
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
          await lane.stream?.stop().catch(() => undefined);
        } else {
          await lane.stream?.stop();
        }
      } else {
        await lane.stream?.flush();
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
          const unmaterializedStream = lane.stream;
          if (unmaterializedStream) {
            await unmaterializedStream.discard();
            unmaterializedStream.forceNewMessage();
          }
          lane.lastPartialText = "";
          lane.hasStreamedMessage = false;
          lane.finalized = false;
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
      const activeSnapshot =
        finalizePreview || buttons ? stream.currentMessageSnapshot() : undefined;
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

    const finalizedPreview =
      preservesPreviewReplyTarget && allowStream && (!reply.hasMedia || canFinalizeMediaPreview)
        ? await streamText()
        : undefined;
    if (finalizedPreview) {
      if (!reply.hasMedia || finalizedPreview.kind === "preview-finalized-partial") {
        return finalizedPreview;
      }
      const stripButtons =
        finalizedPreview.kind === "preview-finalized" &&
        finalizedPreview.delivery.buttonsAttached === true;
      const mediaText =
        finalizedPreview.kind === "preview-finalized" ? finalizedPreview.delivery.content : text;
      try {
        let mediaPayload: ReplyPayload;
        if (getReplyPayloadTtsSupplement(payload)) {
          mediaPayload = buildTtsSupplementMediaPayload(applyTextToPayload(payload, mediaText));
        } else {
          const {
            text: _text,
            presentation: _presentation,
            interactive: _interactive,
            btw: _btw,
            ...rest
          } = payload.audioAsVoice === true ? applyTextToPayload(payload, mediaText) : payload;
          mediaPayload = copyReplyPayloadMetadata(
            payload,
            payload.audioAsVoice === true ? { ...rest, spokenText: mediaText } : rest,
          );
        }
        if (stripButtons || buttons) {
          const channelData = mediaPayload.channelData ?? {};
          const telegramData = asOptionalRecord(channelData.telegram);
          if (stripButtons && telegramData && telegramData.buttons !== undefined) {
            const { buttons: _buttons, ...telegramRest } = telegramData;
            const remainingChannelData = { ...channelData };
            if (Object.keys(telegramRest).length > 0) {
              remainingChannelData.telegram = telegramRest;
            } else {
              delete remainingChannelData.telegram;
            }
            const { channelData: _channelData, ...rest } = mediaPayload;
            mediaPayload = copyReplyPayloadMetadata(
              mediaPayload,
              Object.keys(remainingChannelData).length > 0
                ? { ...rest, channelData: remainingChannelData }
                : rest,
            );
          } else if (!stripButtons && buttons && !(telegramData && "buttons" in telegramData)) {
            mediaPayload = copyReplyPayloadMetadata(mediaPayload, {
              ...mediaPayload,
              channelData: { ...channelData, telegram: { ...telegramData, buttons } },
            });
          }
        }
        const mediaDelivery = await params.sendPayload(mediaPayload, {
          afterAcceptedDraft: true,
          ...sendOptions,
        });
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
      applyTextToPayload(payload, retainedFinalContent?.sourceText ?? text),
      {
        afterAcceptedDraft,
        ...sendOptions,
        ...(retainedFinalContent?.sourceTextMode === "html" ? { textMode: "html" } : {}),
      },
    );
    if (
      deliveryResult.visibleReplySent &&
      finalizePreview &&
      !isDurableFinal &&
      lane.stream &&
      !lane.finalized
    ) {
      await lane.stream.clear();
      lane.lastPartialText = "";
      lane.hasStreamedMessage = false;
    }
    return { kind: deliveryResult.visibleReplySent ? "sent" : "skipped", deliveryResult };
  };
}
