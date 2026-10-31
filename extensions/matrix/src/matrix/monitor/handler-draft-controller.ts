import {
  createChannelProgressDraftCompositor,
  createLivePreviewLifecycle,
} from "openclaw/plugin-sdk/channel-outbound";
import type {
  ReplyDispatchRuntimeInfo,
  GetReplyOptions,
  ReplyPayload,
} from "openclaw/plugin-sdk/reply-runtime";
import type { CoreConfig, MatrixConfig, MatrixStreamingMode, ReplyToMode } from "../../types.js";
import type { MatrixClient } from "../sdk.js";
import { formatMatrixToolProgressMarkdownCode } from "./handler-helpers.js";
import { loadMatrixDraftStream, type MatrixDraftStreamHandle } from "./handler-runtime.js";

/** Host-owned source coverage projected onto block deliveries, not a public SDK field. */
export type MatrixReplyDispatchInfo = ReplyDispatchRuntimeInfo & {
  blockSourceRange?: readonly [start: number, end: number];
};

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
  const shouldSuppressDefaultToolProgressMessages =
    Boolean(draftStream) && (previewToolProgressEnabled || progressDraftStreaming);
  let currentDraftMessageGeneration = 0;
  let currentDraftBlockOffset = 0;
  let latestDraftFullText = "";
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
      onApprovalEvent: (payload) => progressDraft.pushApprovalEvent(payload),
    };
  };

  const updateDraftFromLatestFullText = () => {
    const blockText = latestDraftFullText.slice(currentDraftBlockOffset);
    if (blockText) {
      draftStream?.update(blockText);
    }
  };

  const captureDraftBlockBoundary = (
    text: string | undefined,
    info: Pick<MatrixReplyDispatchInfo, "assistantMessageIndex" | "blockSourceRange">,
  ) => ({
    messageGeneration: info.assistantMessageIndex ?? currentDraftMessageGeneration,
    previewMessageGeneration: currentDraftMessageGeneration,
    previewEndOffset: latestDraftFullText.length,
    // Source positions include stripped separators and exclude synthetic Markdown framing.
    endOffset: info.blockSourceRange?.[1] ?? currentDraftBlockOffset + (text?.length ?? 0),
  });

  const advanceDraftBlockBoundary = (boundary: ReturnType<typeof captureDraftBlockBoundary>) => {
    if (boundary.messageGeneration === currentDraftMessageGeneration) {
      currentDraftBlockOffset = Math.max(currentDraftBlockOffset, boundary.endOffset);
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
    currentDraftReplyToId = draftReplyToId;
    progressDraft.beginNewTurn({ force: true });
  };

  return {
    draftStream,
    previewLifecycle,
    cancelProgressDraft: () => progressDraft.cancel(),
    buildPreviewToolProgressReplyOptions,
    captureDraftBlockBoundary,
    advanceDraftBlockBoundary,
    resetDraftBlockOffsets,
    beginAssistantMessage: () => progressDraft.beginAssistantMessage(),
    resetDraftDeliveryState,
    updateDraftFromLatestFullText,
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
