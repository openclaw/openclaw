import {
  createPreviewMessageReceipt,
  createReplyPrefixOptions,
  createTypingCallbacks,
  type MessageReceipt,
} from "openclaw/plugin-sdk/channel-outbound";
import {
  buildTtsSupplementMediaPayload,
  getReplyPayloadTtsSupplement,
  resolveSendableOutboundReplyParts,
} from "openclaw/plugin-sdk/reply-payload";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { resolveMatrixExtraContent } from "../../outbound.js";
import type { CoreConfig, MatrixStreamingMode, ReplyToMode } from "../../types.js";
import type { MatrixClient } from "../sdk.js";
import { MATRIX_OPENCLAW_FINALIZED_PREVIEW_KEY } from "../send/types.js";
import type { createMatrixDraftController } from "./handler-draft-controller.js";
import {
  loadMatrixSendModule,
  matrixTextWouldActivateMentions,
  type MatrixDraftStreamHandle,
} from "./handler-runtime.js";
import {
  deliverMatrixReplies,
  mergeMatrixReplyDeliveryResults,
  toMatrixPartialDeliveryError,
  type MatrixReplyDeliveryResult,
} from "./replies.js";

type MatrixDraftController = Awaited<ReturnType<typeof createMatrixDraftController>>;

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
  // Tool, block, and final payloads are delivered separately but share one first-reply slot.
  const hasRepliedRef = { value: false };
  const deliverPayload = (reply: ReplyPayload) =>
    deliverMatrixReplies({
      cfg,
      replies: [reply],
      roomId,
      client,
      runtime,
      replyToMode,
      hasRepliedRef,
      threadId: threadTarget,
      replyToId: threadTarget ?? replyToEventId ?? undefined,
      accountId,
      mediaLocalRoots,
    });
  const { previewLifecycle } = draftController;
  let nonFinalReplyDeliveryFailed = false;
  const beginNextBlockDraft = () => {
    // Each block owns a new draft generation; prior retained/consumed state must not
    // suppress settlement or cleanup for the next provider-visible event.
    draftController.beginDraftGeneration();
    draftController.advanceDraftBlockBoundary({ fallbackToLatestEnd: true });
    draftStream?.reset();
    draftController.resetReplyToIdForNextBlock();
    draftController.updateDraftFromLatestFullText();
  };

  const dispatcherOptions = {
    ...prefixOptions,
    humanDelay,
    deliver: async (payload: ReplyPayload, info: { kind: "tool" | "block" | "final" }) => {
      const completeDelivery = async (
        result: MatrixReplyDeliveryResult,
      ): Promise<MatrixReplyDeliveryResult> => {
        if (info.kind === "block") {
          beginNextBlockDraft();
          await typingCallbacks.onReplyStart();
        }
        return result;
      };
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
                  !draftStream.mustDeliverFinalNormally()
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
                      preserveWhitespace: true,
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
      return await completeDelivery(
        mergeMatrixReplyDeliveryResults(
          [retainedDraft, deliveryResult].filter(
            (result): result is MatrixReplyDeliveryResult => result !== undefined,
          ),
        ),
      );
    },
    onError: (err: unknown, info: { kind: "tool" | "block" | "final" }) => {
      if (info.kind === "final") {
        previewLifecycle.observeFailure();
      } else {
        nonFinalReplyDeliveryFailed = true;
      }
      if (info.kind === "block") {
        beginNextBlockDraft();
      }
      runtime.error?.(`matrix ${info.kind} reply failed: ${String(err)}`);
    },
    onReplyStart: typingCallbacks.onReplyStart,
    onIdle: typingCallbacks.onIdle,
  };
  const {
    deliver: deliverReply,
    onError: onReplyError,
    ...turnDispatcherOptions
  } = dispatcherOptions;

  return {
    deliverReply,
    onReplyError,
    turnDispatcherOptions,
    nonFinalReplyDeliveryFailed: () => nonFinalReplyDeliveryFailed,
  };
}
