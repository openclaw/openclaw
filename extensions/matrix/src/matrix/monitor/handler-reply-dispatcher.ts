import {
  createAcceptedChannelDeliveryResult,
  createChannelPartialDeliveryError,
  isChannelPartialDeliveryError,
  type ChannelInboundTurnPlan,
} from "openclaw/plugin-sdk/channel-inbound";
import {
  createChannelDeliveryAccumulator,
  createPreviewMessageReceipt,
  createReplyPrefixOptions,
  createTypingCallbacks,
  type MessageReceipt,
  type LivePreviewDeliveryResult,
} from "openclaw/plugin-sdk/channel-outbound";
import {
  buildTtsSupplementMediaPayload,
  getReplyPayloadTtsSupplement,
  resolveSendableOutboundReplyParts,
} from "openclaw/plugin-sdk/reply-payload";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { stripReasoningTagsFromText } from "openclaw/plugin-sdk/text-chunking";
import { resolveMatrixExtraContent } from "../../outbound.js";
import { getMatrixRuntime } from "../../runtime.js";
import type { CoreConfig, MatrixStreamingMode, ReplyToMode } from "../../types.js";
import type { MatrixClient } from "../sdk.js";
import { sendMessageMatrix } from "../send.js";
import { MATRIX_OPENCLAW_FINALIZED_PREVIEW_KEY, type MatrixSendResult } from "../send/types.js";
import type {
  createMatrixDraftController,
  MatrixReplyDispatchInfo,
} from "./handler-draft-controller.js";
import {
  loadMatrixSendModule,
  matrixTextWouldActivateMentions,
  type MatrixDraftStreamHandle,
} from "./handler-runtime.js";

type MatrixDraftController = Awaited<ReturnType<typeof createMatrixDraftController>>;
type MatrixReplyDeliveryResult = LivePreviewDeliveryResult;

function mergeMatrixReplyDeliveryResults(
  results: readonly MatrixReplyDeliveryResult[],
): MatrixReplyDeliveryResult {
  const single = results.length === 1 ? results[0] : undefined;
  if (single?.visibleReplySent) {
    return single;
  }
  const visibleResults = results.filter((result) => result.visibleReplySent);
  if (visibleResults.length === 0) {
    return { visibleReplySent: false, suppression: { reason: "no_visible_result" } };
  }
  const content = visibleResults
    .map((result) => result.content)
    .filter(Boolean)
    .join("\n");
  if (visibleResults.some((result) => result.receipt || result.messageIds?.length)) {
    return createAcceptedChannelDeliveryResult({ deliveryResults: visibleResults, content });
  }
  return { visibleReplySent: true, content };
}

function toMatrixPartialDeliveryError(
  error: unknown,
  settled: readonly MatrixReplyDeliveryResult[],
): unknown {
  const failedPartial = isChannelPartialDeliveryError(error) ? error.deliveryResult : undefined;
  const merged = mergeMatrixReplyDeliveryResults([
    ...settled,
    ...(failedPartial ? [failedPartial] : []),
  ]);
  return merged.visibleReplySent
    ? createChannelPartialDeliveryError(error, { ...merged, visibleReplySent: true })
    : error;
}

function resolveVisibleMatrixReplyText(text?: string): string | undefined {
  if (typeof text !== "string") {
    return undefined;
  }
  const trimmedStart = text.trimStart();
  if (!trimmedStart) {
    return text;
  }
  if (normalizeLowercaseStringOrEmpty(trimmedStart).startsWith("reasoning:")) {
    return undefined;
  }
  const visibleText = stripReasoningTagsFromText(text, { mode: "strict", trim: "none" });
  return visibleText.trim() ? visibleText : undefined;
}

export function createMatrixReplyDispatcher(config: {
  cfg: CoreConfig;
  prefixOptions: Omit<ReturnType<typeof createReplyPrefixOptions>, "onModelSelected">;
  humanDelay: ReturnType<
    typeof import("openclaw/plugin-sdk/agent-runtime").resolveHumanDelayConfig
  >;
  typingCallbacks: ReturnType<typeof createTypingCallbacks>;
  streaming: MatrixStreamingMode;
  draftStream: MatrixDraftStreamHandle | undefined;
  draftController: MatrixDraftController;
  client: MatrixClient;
  roomId: string;
  runtime: RuntimeEnv;
  replyToMode: ReplyToMode;
  threadTarget?: string;
  replyToEventId?: string;
  accountId: string;
  mediaLocalRoots: readonly string[];
  logVerboseMessage: (message: string) => void;
}) {
  const {
    cfg,
    prefixOptions,
    humanDelay,
    typingCallbacks,
    streaming,
    draftStream,
    draftController,
    client,
    roomId,
    runtime,
    replyToMode,
    threadTarget,
    replyToEventId,
    accountId,
    mediaLocalRoots,
    logVerboseMessage,
  } = config;
  const quietDraftStreaming = streaming === "quiet" || streaming === "progress";
  const progressDraftStreaming = streaming === "progress";
  // Tool, block, and final payloads are delivered separately but share one first-reply slot.
  let hasReplied = false;
  const resolveReplyTargets = (reply: ReplyPayload) => {
    const explicitReplyToId =
      reply.replyToTag || reply.replyToCurrent ? reply.replyToId?.trim() : undefined;
    const ambientReplyToId = threadTarget ?? replyToEventId;
    return {
      replyToId:
        explicitReplyToId ||
        (!threadTarget && replyToMode !== "off" && (replyToMode === "all" || !hasReplied)
          ? (reply.replyToId ?? ambientReplyToId)?.trim()
          : undefined),
      fallbackReplyToId: threadTarget ? (reply.replyToId ?? ambientReplyToId)?.trim() : undefined,
    };
  };
  const durable: ChannelInboundTurnPlan["delivery"]["durable"] = (payload, info) => {
    // A preview finalizes an existing event; only ordinary finals need a new durable send.
    if (
      info.kind !== "final" ||
      draftStream ||
      payload.isReasoning ||
      (payload.text && resolveVisibleMatrixReplyText(payload.text) === undefined)
    ) {
      return false;
    }
    const { replyToId, fallbackReplyToId } = resolveReplyTargets(payload);
    const send: typeof sendMessageMatrix = async (to, text, options) =>
      await sendMessageMatrix(to, text, {
        ...options,
        client,
        mediaLocalRoots: options.mediaLocalRoots ?? mediaLocalRoots,
        replyToId,
        fallbackReplyToId,
        onDeliveryResult: async (result) => {
          if (replyToId) {
            hasReplied = true;
          }
          await options.onDeliveryResult?.(result);
        },
      });
    return {
      deps: { matrix: send },
      replyToId: replyToId ?? null,
      replyToMode,
      threadId: threadTarget,
    };
  };
  const deliverPayload = async (reply: ReplyPayload): Promise<MatrixReplyDeliveryResult> => {
    const core = getMatrixRuntime();
    const logVerbose = (message: string) => {
      if (core.logging.shouldLogVerbose()) {
        runtime.log?.(message);
      }
    };
    const accepted = createChannelDeliveryAccumulator();
    const visibleText = resolveVisibleMatrixReplyText(reply.text);
    const { hasMedia, hasText, mediaUrls } = resolveSendableOutboundReplyParts(reply);
    if (reply.isReasoning === true || (!hasMedia && reply.text && visibleText === undefined)) {
      logVerbose("matrix reply suppressed as reasoning-only");
      return accepted.result();
    }
    if (!hasText && !hasMedia) {
      if (reply.audioAsVoice) {
        logVerbose("matrix reply has audioAsVoice without media/text; skipping");
      } else {
        runtime.error?.("matrix reply missing text/media");
      }
      return accepted.result();
    }
    const { replyToId: replyToIdForReply, fallbackReplyToId } = resolveReplyTargets(reply);
    const onDeliveryResult = (result: MatrixSendResult) => {
      // A concrete event consumes the first-reply slot even when a later event fails.
      accepted.add({ receipt: result.receipt }, result.content);
      if (replyToIdForReply) {
        hasReplied = true;
      }
    };
    // The reply's own event fields ride its first event, not a later chunk.
    const extraContent = resolveMatrixExtraContent(reply);
    const targets = mediaUrls.length > 0 ? mediaUrls : [undefined];
    try {
      for (const [index, mediaUrl] of targets.entries()) {
        await sendMessageMatrix(roomId, index === 0 ? (visibleText ?? "") : "", {
          client,
          cfg,
          ...(mediaUrl !== undefined
            ? { mediaUrl, mediaLocalRoots, audioAsVoice: reply.audioAsVoice }
            : {}),
          replyToId: replyToIdForReply,
          fallbackReplyToId,
          threadId: threadTarget,
          accountId,
          extraContent: index === 0 ? extraContent : undefined,
          onDeliveryResult,
        });
      }
    } catch (error: unknown) {
      throw toMatrixPartialDeliveryError(error, [accepted.result()]);
    }
    return accepted.result();
  };
  const { previewLifecycle } = draftController;
  let nonFinalReplyDeliveryFailed = false;
  const beginNextBlockDraft = (
    boundary: ReturnType<MatrixDraftController["captureDraftBlockBoundary"]>,
  ) => {
    // Each block owns a new draft generation; prior retained/consumed state must not
    // suppress settlement or cleanup for the next provider-visible event.
    draftController.beginDraftGeneration();
    draftController.advanceDraftBlockBoundary(boundary);
    draftStream?.reset();
    draftController.resetReplyToIdForNextBlock();
    draftController.updateDraftFromLatestFullText();
  };

  return {
    durable,
    turnDispatcherOptions: {
      ...prefixOptions,
      humanDelay,
      onReplyStart: typingCallbacks.onReplyStart,
      onIdle: typingCallbacks.onIdle,
    },
    deliverReply: async (payload: ReplyPayload, info: MatrixReplyDispatchInfo) => {
      const createDraftReceipt = (id: string): MessageReceipt =>
        createPreviewMessageReceipt({
          id,
          ...(threadTarget ? { threadId: threadTarget } : {}),
          ...(draftController.currentReplyToId()
            ? { replyToId: draftController.currentReplyToId() }
            : {}),
        });
      const createDraftDeliveryResult = (
        id: string,
        content: string,
      ): MatrixReplyDeliveryResult => {
        const receipt = createDraftReceipt(id);
        return {
          messageIds: receipt.platformMessageIds,
          receipt,
          visibleReplySent: true,
          content,
        };
      };
      const settlesPreview =
        Boolean(draftStream) && info.kind !== "tool" && !payload.isCompactionNotice;
      const ttsSupplement = getReplyPayloadTtsSupplement(payload);
      const fallbackPayload =
        settlesPreview &&
        ttsSupplement &&
        ttsSupplement.visibleTextAlreadyDelivered !== true &&
        !payload.text?.trim()
          ? { ...payload, text: ttsSupplement.spokenText }
          : payload;
      const { hasMedia } = resolveSendableOutboundReplyParts(payload);
      const payloadText = payload.text ?? ttsSupplement?.spokenText;
      // Capture before transport can yield to a newer assistant message.
      const blockBoundary =
        info.kind === "block" && !payload.isCompactionNotice
          ? draftController.captureDraftBlockBoundary(payloadText, info)
          : undefined;
      const payloadReplyMismatch =
        ((!threadTarget && replyToMode !== "off") ||
          payload.replyToTag ||
          payload.replyToCurrent) &&
        normalizeOptionalString(payload.replyToId) !== draftController.currentReplyToId();
      let retainedDraftDelivery: MatrixReplyDeliveryResult | undefined;
      let deliveryResult: MatrixReplyDeliveryResult | undefined;
      try {
        const result = await previewLifecycle.deliver<{ text: string }>({
          // Matrix block events are durable finals of their own draft generation.
          kind: payload.isCompactionNotice ? "tool" : info.kind === "block" ? "final" : info.kind,
          payload,
          isError: payload.isError,
          adapter: draftStream
            ? {
                buildFinalEdit: () =>
                  payloadText?.trim() &&
                  !payload.isError &&
                  !payloadReplyMismatch &&
                  !draftStream.mustDeliverFinalNormally() &&
                  !(hasMedia && !ttsSupplement && progressDraftStreaming)
                    ? { text: payloadText }
                    : undefined,
                editFinal: async (draftEventId, edit) => {
                  // A flush can discover a single-event limit, and mentions require a
                  // fresh event because draft mentions are deliberately inert.
                  if (
                    draftStream.mustDeliverFinalNormally() ||
                    (await matrixTextWouldActivateMentions(client, edit.text))
                  ) {
                    return { visibleReplySent: false };
                  }
                  const { editMessageMatrix, prepareMatrixSingleText } =
                    await loadMatrixSendModule();
                  const presentationContent = hasMedia
                    ? undefined
                    : resolveMatrixExtraContent(payload);
                  const extraContent = {
                    ...(quietDraftStreaming
                      ? { [MATRIX_OPENCLAW_FINALIZED_PREVIEW_KEY]: true }
                      : {}),
                    ...presentationContent,
                  };
                  if (
                    !quietDraftStreaming &&
                    !presentationContent &&
                    draftStream.matchesPreparedText(edit.text)
                  ) {
                    if (!(await draftStream.finalizeLive())) {
                      return { visibleReplySent: false };
                    }
                  } else {
                    await editMessageMatrix(roomId, draftEventId, edit.text, {
                      client,
                      cfg,
                      threadId: threadTarget,
                      accountId,
                      ...(Object.keys(extraContent).length > 0 ? { extraContent } : {}),
                    });
                  }
                  return createDraftDeliveryResult(
                    draftEventId,
                    prepareMatrixSingleText(edit.text, {
                      cfg,
                      accountId,
                    }).convertedText,
                  );
                },
                createPreviewReceipt: createDraftReceipt,
                buildSupplementalPayload: () =>
                  hasMedia
                    ? ttsSupplement
                      ? buildTtsSupplementMediaPayload(payload)
                      : { ...payload, text: undefined }
                    : undefined,
                deliverSupplemental: deliverPayload,
                logPreviewEditFailure: (err) => {
                  logVerboseMessage(`matrix: preview final edit failed: ${String(err)}`);
                },
              }
            : undefined,
          deliverNormally: async (normalPayload) => {
            if (
              settlesPreview &&
              !previewLifecycle.previewFinalized &&
              (hasMedia ||
                payloadText?.trim() ||
                payload.isError ||
                payloadReplyMismatch ||
                draftStream?.mustDeliverFinalNormally())
            ) {
              const id = draftStream?.eventId();
              const content = draftStream?.content();
              if (id && content) {
                retainedDraftDelivery = createDraftDeliveryResult(id, content);
              }
            }
            return await deliverPayload(
              normalPayload === payload ? fallbackPayload : normalPayload,
            );
          },
        });
        deliveryResult = result.deliveryResult;
      } catch (error: unknown) {
        if (retainedDraftDelivery) {
          previewLifecycle.retainPreview();
        }
        if (blockBoundary) {
          // A retained cumulative preview already shows its suffix. Do not replay it.
          beginNextBlockDraft(
            retainedDraftDelivery
              ? {
                  ...blockBoundary,
                  messageGeneration: blockBoundary.previewMessageGeneration,
                  endOffset:
                    blockBoundary.messageGeneration === blockBoundary.previewMessageGeneration
                      ? Math.max(blockBoundary.endOffset, blockBoundary.previewEndOffset)
                      : blockBoundary.previewEndOffset,
                }
              : blockBoundary,
          );
        }
        throw toMatrixPartialDeliveryError(
          error,
          retainedDraftDelivery ? [retainedDraftDelivery] : [],
        );
      }
      if (retainedDraftDelivery && !deliveryResult?.visibleReplySent) {
        previewLifecycle.retainPreview();
      }
      const retainedDraft = retainedDraftDelivery?.messageIds?.includes(
        draftStream?.eventId() ?? "",
      )
        ? retainedDraftDelivery
        : undefined;
      const mergedDelivery = mergeMatrixReplyDeliveryResults(
        [retainedDraft, deliveryResult].filter(
          (result): result is MatrixReplyDeliveryResult => result !== undefined,
        ),
      );
      if (blockBoundary) {
        beginNextBlockDraft(blockBoundary);
        await typingCallbacks.onReplyStart();
      }
      return mergedDelivery;
    },
    onReplyError: (err: unknown, info: { kind: "tool" | "block" | "final" }) => {
      if (info.kind === "final") {
        previewLifecycle.observeFailure();
      } else {
        nonFinalReplyDeliveryFailed = true;
      }
      runtime.error?.(`matrix ${info.kind} reply failed: ${String(err)}`);
    },
    nonFinalReplyDeliveryFailed: () => nonFinalReplyDeliveryFailed,
  };
}
