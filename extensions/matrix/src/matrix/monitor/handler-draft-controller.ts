import {
  createChannelProgressDraftCompositor,
  createLivePreviewLifecycle,
} from "openclaw/plugin-sdk/channel-outbound";
import type {
  BlockReplyContext,
  GetReplyOptions,
  ReplyPayload,
} from "openclaw/plugin-sdk/reply-runtime";
import type { CoreConfig, MatrixConfig, MatrixStreamingMode, ReplyToMode } from "../../types.js";
import type { MatrixClient } from "../sdk.js";
import { formatMatrixToolProgressMarkdownCode } from "./handler-helpers.js";
import { loadMatrixDraftStream, type MatrixDraftStreamHandle } from "./handler-runtime.js";

export async function createMatrixDraftController(params: {
  streaming: MatrixStreamingMode;
  previewToolProgressEnabled: boolean;
  replyToMode: ReplyToMode;
  messageId: string;
  threadTarget?: string;
  accountConfig?: MatrixConfig;
  cfg: CoreConfig;
  accountId: string;
  roomId: string;
  client: MatrixClient;
  logVerboseMessage: (message: string) => void;
}) {
  const {
    streaming,
    previewToolProgressEnabled,
    replyToMode,
    messageId,
    threadTarget,
    accountConfig,
    cfg,
    accountId,
    roomId,
    client,
    logVerboseMessage,
  } = params;
  const draftStreamingEnabled = streaming !== "off";
  const quietDraftStreaming = streaming === "quiet" || streaming === "progress";
  const progressDraftStreaming = streaming === "progress";
  const draftReplyToId = replyToMode !== "off" && !threadTarget ? messageId : undefined;
  const draftStream: MatrixDraftStreamHandle | undefined = draftStreamingEnabled
    ? await loadMatrixDraftStream().then(({ createMatrixDraftStream }) =>
        createMatrixDraftStream({
          roomId,
          client,
          cfg,
          mode: quietDraftStreaming ? "quiet" : "partial",
          threadId: threadTarget,
          replyToId: draftReplyToId,
          preserveReplyId: replyToMode === "all",
          accountId,
          log: logVerboseMessage,
        }),
      )
    : undefined;
  const shouldStreamPreviewToolProgress = Boolean(draftStream) && previewToolProgressEnabled;
  const shouldSuppressDefaultToolProgressMessages =
    Boolean(draftStream) && (shouldStreamPreviewToolProgress || params.streaming === "progress");
  type PendingDraftBoundary = {
    messageGeneration: number;
    endOffset: number;
  };
  // Track the current draft block start plus any queued block-end offsets
  // inside the model's cumulative partial text so multiple block
  // boundaries can drain in order even when Matrix delivery lags behind.
  let currentDraftMessageGeneration = 0;
  let currentDraftBlockOffset = 0;
  let latestDraftFullText = "";
  const pendingDraftBoundaries: PendingDraftBoundary[] = [];
  const latestQueuedDraftBoundaryOffsets = new Map<number, number>();
  let currentDraftReplyToId = draftReplyToId;
  const progressConfigEntry = accountConfig ?? cfg.channels?.matrix;
  const progressSeed = `${accountId}:${roomId}`;
  const progressDraft = createChannelProgressDraftCompositor({
    preparedItems: true,
    entry: progressConfigEntry,
    mode: streaming === "quiet" ? "partial" : streaming,
    active: Boolean(draftStream),
    seed: progressSeed,
    formatLine: formatMatrixToolProgressMarkdownCode,
    update: async (text, options) => {
      const previewText = text.replace(/^• /gmu, "- ");
      if (!draftStream) {
        return false;
      }
      draftStream.update(previewText);
      if (options?.flush) {
        await draftStream.flush();
      }
      // A queued update is not visible until Matrix has accepted a draft event.
      return Boolean(draftStream.eventId());
    },
    deleteCurrent: () => draftStream?.deleteCurrentMessage(),
  });
  const previewLifecycle = createLivePreviewLifecycle<ReplyPayload, string>({
    draft: draftStream
      ? {
          flush: draftStream.flush,
          id: draftStream.eventId,
          seal: draftStream.seal,
          discardPending: draftStream.discardPending,
          clear: draftStream.clear,
        }
      : undefined,
    cleanupUndelivered: true,
    onFinalStarted: () => progressDraft.markFinalReplyStarted(),
    onFinalDelivered: () => progressDraft.markFinalReplyDelivered(),
    onCleanupFailure: (err) =>
      logVerboseMessage(`matrix draft preview cleanup failed: ${String(err)}`),
  });

  const buildPreviewToolProgressReplyOptions = (): Partial<GetReplyOptions> => {
    if (!shouldSuppressDefaultToolProgressMessages) {
      return {};
    }
    return {
      suppressDefaultToolProgressMessages: true,
      progressPreambleEnabled: true,
      commentaryProgressEnabled: progressDraft.commentaryProgressEnabled,
      onToolStart: progressDraft.pushToolEvent,
      onItemEvent: progressDraft.pushItemEvent,
      onPlanUpdate: async (payload) => {
        if (payload.phase !== "update") {
          return false;
        }
        return await progressDraft.pushPlanProgress(payload.steps, {
          explanation: payload.explanation,
          explanationFormat: payload.explanationFormat,
        });
      },
      onApprovalEvent: async (payload) => {
        return await progressDraft.pushApprovalEvent(payload);
      },
    };
  };

  const getDisplayableDraftText = () => {
    const nextDraftBoundaryOffset = pendingDraftBoundaries.find(
      (boundary) => boundary.messageGeneration === currentDraftMessageGeneration,
    )?.endOffset;
    return latestDraftFullText.slice(currentDraftBlockOffset, nextDraftBoundaryOffset);
  };

  const updateDraftFromLatestFullText = () => {
    const blockText = getDisplayableDraftText();
    if (blockText) {
      draftStream?.update(blockText);
    }
  };

  const queueDraftBlockBoundary = (payload: ReplyPayload, context?: BlockReplyContext) => {
    const payloadTextLength = payload.text?.length ?? 0;
    const messageGeneration = context?.assistantMessageIndex ?? currentDraftMessageGeneration;
    const lastQueuedDraftBoundaryOffset =
      latestQueuedDraftBoundaryOffsets.get(messageGeneration) ?? 0;
    // Logical block boundaries must follow emitted block text, not whichever
    // later partial preview has already arrived by the time the async
    // boundary callback drains.
    const nextDraftBoundaryOffset = lastQueuedDraftBoundaryOffset + payloadTextLength;
    latestQueuedDraftBoundaryOffsets.set(messageGeneration, nextDraftBoundaryOffset);
    pendingDraftBoundaries.push({
      messageGeneration,
      endOffset: nextDraftBoundaryOffset,
    });
  };

  const advanceDraftBlockBoundary = (options?: { fallbackToLatestEnd?: boolean }) => {
    const completedBoundary = pendingDraftBoundaries.shift();
    if (completedBoundary) {
      if (
        !pendingDraftBoundaries.some(
          (entry) => entry.messageGeneration === completedBoundary.messageGeneration,
        )
      ) {
        latestQueuedDraftBoundaryOffsets.delete(completedBoundary.messageGeneration);
      }
      if (completedBoundary.messageGeneration === currentDraftMessageGeneration) {
        currentDraftBlockOffset = completedBoundary.endOffset;
      }
      return;
    }
    if (options?.fallbackToLatestEnd) {
      currentDraftBlockOffset = latestDraftFullText.length;
    }
  };

  const resetDraftBlockOffsets = () => {
    currentDraftMessageGeneration += 1;
    currentDraftBlockOffset = 0;
    latestDraftFullText = "";
  };

  const resetDraftDeliveryState = async () => {
    await draftStream?.discardPending();
    draftStream?.reset();
    previewLifecycle.reset();
    currentDraftMessageGeneration = 0;
    currentDraftBlockOffset = 0;
    latestDraftFullText = "";
    pendingDraftBoundaries.length = 0;
    latestQueuedDraftBoundaryOffsets.clear();
    currentDraftReplyToId = draftReplyToId;
    progressDraft.beginNewTurn({ force: true });
  };

  const finalizeAcceptedPartialDraft = async () => {
    if (streaming !== "partial" || previewLifecycle.previewFinalized || !draftStream?.eventId()) {
      return;
    }
    // Only an already-visible partial may become the terminal reply. Drafts accepted
    // during shutdown stay active so the handler's final cleanup removes them.
    const draftEventId = await draftStream.stop().catch(() => undefined);
    if (draftEventId && (await draftStream.finalizeLive())) {
      previewLifecycle.retainPreview();
    }
  };

  const settleAcceptedDraftAfterError = async () => {
    if (previewLifecycle.previewFinalized || !draftStream?.eventId()) {
      return;
    }
    if (streaming === "partial") {
      await finalizeAcceptedPartialDraft();
      return;
    }
    // Quiet and progress previews are ordinary Matrix events rather than live
    // drafts. Preserve current behavior once Matrix has accepted the event.
    previewLifecycle.retainPreview();
  };

  return {
    draftStream,
    previewLifecycle,
    cancelProgressDraft: () => progressDraft.cancel(),
    buildPreviewToolProgressReplyOptions,
    queueDraftBlockBoundary,
    advanceDraftBlockBoundary,
    resetDraftBlockOffsets,
    beginAssistantMessage: () => progressDraft.beginAssistantMessage(),
    resetDraftDeliveryState,
    updateDraftFromLatestFullText,
    finalizeAcceptedPartialDraft,
    settleAcceptedDraftAfterError,
    beginDraftGeneration: () => {
      previewLifecycle.reset();
      progressDraft.beginNewTurn({ force: true });
    },
    currentReplyToId: () => currentDraftReplyToId,
    resetReplyToIdForNextBlock: () => {
      currentDraftReplyToId = replyToMode === "all" ? draftReplyToId : undefined;
    },
    onPartialReply: (text: string) => {
      if (progressDraftStreaming) {
        return false;
      }
      latestDraftFullText = text;
      if (text.trim()) {
        progressDraft.resetActivity({ suppressed: true });
      }
      updateDraftFromLatestFullText();
      return false;
    },
  };
}
