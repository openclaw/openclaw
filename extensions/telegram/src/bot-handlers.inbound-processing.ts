import {
  isAbortRequestText,
  isBtwRequestText,
} from "openclaw/plugin-sdk/command-primitives-runtime";
import type { DmPolicy } from "openclaw/plugin-sdk/config-contracts";
import { buildTelegramInboundDebounceKey } from "./bot-handlers.debounce-key.js";
import {
  createTelegramInboundBuffers,
  type TelegramDebounceEntry,
  type TelegramInboundMediaHydration,
} from "./bot-handlers.inbound-buffer.js";
import {
  createTelegramInboundMedia,
  type TelegramMediaGroupInput,
} from "./bot-handlers.inbound-media.js";
import {
  isDurablyRetryableInboundMediaError,
  isMediaSizeLimitError,
  TelegramBotApiFileTooLargeError,
} from "./bot-handlers.media.js";
import { promptContextBoundaryOptions } from "./bot-handlers.message-context.js";
import type { TelegramMessagePipeline } from "./bot-handlers.message-pipeline.js";
import type {
  RegisterTelegramHandlerParams,
  TelegramInboundDisposition,
} from "./bot-handlers.types.js";
import type {
  TelegramChannelIngressResolver,
  TelegramMediaRef,
} from "./bot-message-context.types.js";
import {
  isTelegramSpooledReplayUpdate,
  recordTelegramMessageProcessingResult,
} from "./bot-processing-outcome.js";
import { resolveMedia } from "./bot/delivery.resolve-media.js";
import {
  buildTelegramGroupPeerId,
  getTelegramTextParts,
  resolveTelegramPrimaryMedia,
} from "./bot/helpers.js";
import { resolveTelegramCommandIngressAuthorization } from "./ingress.js";
import { isTelegramControlLaneText } from "./sequential-key.js";

type TelegramInboundMessage = Omit<TelegramMediaGroupInput, "channelIngressResolvers"> & {
  dmPolicy: DmPolicy;
  channelIngressResolver: TelegramChannelIngressResolver;
  sendOversizeWarning: boolean;
  oversizeLogMessage: string;
};

export function createTelegramInboundProcessing({
  params: handlerParams,
  message,
}: {
  params: RegisterTelegramHandlerParams;
  message: TelegramMessagePipeline;
}) {
  const { accountId, mediaMaxBytes, logger } = handlerParams;
  const {
    resolveMediaRuntime,
    recordMessageResolvedMedia,
    releaseDispatchDedupeClaims,
    createSpooledReplayParticipantForBufferedWork,
  } = message;
  const { cancelPending, inboundDebouncer, resolveTelegramDebounceLane } =
    createTelegramInboundBuffers({ params: handlerParams, message });

  const { handleMediaGroup, resolveUnaddressedGroupMediaDisposition, sendMediaWarning } =
    createTelegramInboundMedia({
      params: handlerParams,
      message,
    });
  const processInboundMessage = async (
    params: TelegramInboundMessage,
  ): Promise<TelegramInboundDisposition> => {
    const {
      dmPolicy,
      channelIngressResolver,
      sendOversizeWarning,
      oversizeLogMessage,
      ...mediaInput
    } = params;
    const {
      authorizationCfg,
      ctx,
      msg,
      chatId,
      isGroup,
      threadSpec,
      storeAllowFrom,
      senderId,
      effectiveGroupAllow,
      effectiveDmAllow,
      promptContextMinTimestampMs,
      promptContextAmbientWatermark,
      dispatchDedupeClaims,
    } = mediaInput;
    const resolvedThreadId =
      threadSpec.scope === "forum" || threadSpec.scope === "direct-messages"
        ? threadSpec.id
        : undefined;

    const messageText = getTelegramTextParts(msg).text;
    const botUsername = ctx.me?.username;
    const isAbortControlMessage = isAbortRequestText(messageText, { botUsername });
    const bypassTextBuffer =
      isTelegramControlLaneText({ rawText: messageText, botUsername }) ||
      isBtwRequestText(messageText, { botUsername });
    const abortControlAuthorized =
      isAbortControlMessage && senderId
        ? resolveTelegramCommandIngressAuthorization({
            accountId,
            cfg: authorizationCfg,
            dmPolicy,
            isGroup,
            chatId,
            resolvedThreadId,
            senderId,
            effectiveDmAllow,
            effectiveGroupAllow,
            eventKind: "message",
            allowTextCommands: true,
            hasControlCommand: true,
            modeWhenAccessGroupsOff: "allow",
            includeDmAllowForGroupCommands: false,
          }).then((gate) => gate.authorized)
        : Promise.resolve(false);

    if (await abortControlAuthorized) {
      cancelPending({ chatId, threadSpec, senderId });
    }

    if (
      handleMediaGroup({
        ...mediaInput,
        channelIngressResolvers: [channelIngressResolver],
      })
    ) {
      return { kind: "buffered", buffer: "media-group" };
    }

    const mediaDisposition = await resolveUnaddressedGroupMediaDisposition(mediaInput);
    if (mediaDisposition === "skip") {
      releaseDispatchDedupeClaims(dispatchDedupeClaims);
      return { kind: "ignored" };
    }

    const nativeMedia = resolveTelegramPrimaryMedia(msg);
    const replayingSpooledUpdate = isTelegramSpooledReplayUpdate(ctx.update);
    const hydrateMedia = async (
      abortSignals: readonly AbortSignal[],
    ): Promise<TelegramInboundMediaHydration> => {
      const mediaRuntime = resolveMediaRuntime(...abortSignals);
      let media: Awaited<ReturnType<typeof resolveMedia>> = null;
      let unavailable: TelegramMediaRef["unavailable"];
      try {
        media = await resolveMedia({
          ctx,
          maxBytes: mediaMaxBytes,
          ...mediaRuntime,
        });
        if (mediaRuntime.abortSignal?.aborted) {
          return {
            kind: "retry",
            error:
              mediaRuntime.abortSignal.reason ??
              new Error("telegram media hydration owner aborted"),
          };
        }
        if (media) {
          await recordMessageResolvedMedia({ msg, media, botUserId: ctx.me?.id });
        }
      } catch (mediaErr) {
        if (mediaRuntime.abortSignal?.aborted && isDurablyRetryableInboundMediaError(mediaErr)) {
          // Abort mid-media-resolution must stay retryable for live updates too;
          // a clean claim release would settle the update as handled and silently
          // drop the message during shutdown or deadline cancellation.
          return { kind: "retry", error: mediaErr };
        }
        if (isMediaSizeLimitError(mediaErr)) {
          const limitMb =
            mediaErr instanceof TelegramBotApiFileTooLargeError
              ? Math.min(mediaErr.limitMb, Math.round(mediaMaxBytes / (1024 * 1024)))
              : Math.round(mediaMaxBytes / (1024 * 1024));
          unavailable = { reason: "oversize", limitMb };
          if (sendOversizeWarning && mediaDisposition !== "silent-ingest") {
            await sendMediaWarning(mediaInput, `⚠️ File too large. Maximum size is ${limitMb}MB.`);
          }
          logger.warn({ chatId, error: String(mediaErr) }, oversizeLogMessage);
        } else {
          logger.warn({ chatId, error: String(mediaErr) }, "media fetch failed");
          if (replayingSpooledUpdate && isDurablyRetryableInboundMediaError(mediaErr)) {
            return { kind: "retry", error: mediaErr };
          }
          unavailable = { reason: "download-failed" };
          if (mediaDisposition !== "silent-ingest") {
            await sendMediaWarning(mediaInput, "⚠️ Failed to download media. Please try again.");
          }
        }
      }
      const allMedia: TelegramMediaRef[] = nativeMedia
        ? [
            media
              ? {
                  path: media.path,
                  contentType: media.contentType,
                  ...(media.fileName ? { fileName: media.fileName } : {}),
                  kind: media.kind,
                  stickerMetadata: media.stickerMetadata,
                }
              : { kind: nativeMedia.kind, unavailable },
          ]
        : [];
      return { kind: "ready", allMedia };
    };
    const conversationKey = buildTelegramGroupPeerId(chatId, threadSpec);
    const debounceLane = resolveTelegramDebounceLane(msg);
    const debounceSenderId = senderId || (msg.from?.id != null ? String(msg.from.id) : "");
    const debounceKey = debounceSenderId
      ? buildTelegramInboundDebounceKey({
          accountId,
          conversationKey,
          senderId: debounceSenderId,
        })
      : null;
    const createDebounceEntry = (allMedia: TelegramMediaRef[]): TelegramDebounceEntry => ({
      ctx,
      msg,
      allMedia,
      storeAllowFrom,
      receivedAtMs: Date.now(),
      // Waiting here would hold the shared control lane and block /stop in other topics.
      debounceKey: bypassTextBuffer ? null : debounceKey,
      debounceLane,
      botUsername,
      threadSpec,
      ...promptContextBoundaryOptions(promptContextMinTimestampMs, promptContextAmbientWatermark),
      dispatchDedupeClaims,
      channelIngressResolvers: [channelIngressResolver],
    });
    let debounceEntry = createDebounceEntry([]);
    if (nativeMedia && debounceLane === "forward" && inboundDebouncer.shouldBuffer(debounceEntry)) {
      // Downloading here would spend the forward quiet window and split the burst.
      debounceEntry.hydrateMedia = hydrateMedia;
    } else {
      const hydration = await hydrateMedia([]);
      if (hydration.kind === "retry") {
        recordTelegramMessageProcessingResult({ kind: "failed-retryable", error: hydration.error });
        releaseDispatchDedupeClaims(dispatchDedupeClaims, hydration.error);
        return { kind: "ignored" };
      }
      debounceEntry = createDebounceEntry(hydration.allMedia);
    }
    const shouldBufferDebounce = inboundDebouncer.shouldBuffer(debounceEntry);
    if (shouldBufferDebounce) {
      debounceEntry.spooledReplayParticipant = createSpooledReplayParticipantForBufferedWork(
        `inbound-debounce:${debounceEntry.debounceKey}`,
      );
    }
    await inboundDebouncer.enqueue(debounceEntry);
    return shouldBufferDebounce ? { kind: "buffered", buffer: "debounce" } : { kind: "processed" };
  };

  return { processInboundMessage };
}
