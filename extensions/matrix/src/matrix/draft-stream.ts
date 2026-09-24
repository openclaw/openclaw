import { createFinalizableDraftLifecycle } from "openclaw/plugin-sdk/channel-outbound";
import type { CoreConfig } from "../types.js";
import type { MatrixClient } from "./sdk.js";
import { editMessageMatrix, prepareMatrixSingleText, sendSingleTextMessageMatrix } from "./send.js";
import { MsgType } from "./send/types.js";

const DEFAULT_THROTTLE_MS = 1000;
type MatrixDraftPreviewMode = "partial" | "quiet";

export function createMatrixDraftStream(params: {
  roomId: string;
  client: MatrixClient;
  cfg: CoreConfig;
  mode?: MatrixDraftPreviewMode;
  threadId?: string;
  replyToId?: string;
  /** When true, reset() restores the original replyToId instead of clearing it. */
  preserveReplyId?: boolean;
  accountId?: string;
  log?: (message: string) => void;
}) {
  const { roomId, client, cfg, threadId, accountId, log } = params;
  // MSC4357 live markers are only useful for "partial" mode where users see
  // the draft evolve. "quiet" mode uses m.notice for background previews
  // where a streaming animation would be unexpected.
  const useLive = params.mode !== "quiet";
  const previewOptions = {
    client,
    cfg,
    threadId,
    accountId,
    msgtype: useLive ? MsgType.Text : MsgType.Notice,
    // Partial model text and tool-progress paths must not notify mentioned users.
    includeMentions: false,
  };

  let currentEventId: string | undefined;
  let lastSentText = "";
  let lastSentContent = "";
  const streamState = { stopped: false, final: false };
  let sendFailed = false;
  let finalizeInPlaceBlocked = false;
  let liveFinalized = false;
  let replyToId = params.replyToId;

  const sendOrEdit = async (text: string): Promise<boolean> => {
    const trimmed = text.trimEnd();
    if (!trimmed.trim()) {
      return false;
    }
    const preparedText = prepareMatrixSingleText(trimmed, {
      cfg,
      accountId,
      preserveWhitespace: true,
    });
    if (!preparedText.fitsInSingleEvent) {
      finalizeInPlaceBlocked = true;
      if (!currentEventId) {
        sendFailed = true;
      }
      streamState.stopped = true;
      log?.(
        `draft-stream: preview exceeded single-event limit (${preparedText.convertedText.length} > ${preparedText.singleEventLimit})`,
      );
      return false;
    }
    if (sendFailed) {
      return false;
    }
    if (preparedText.trimmedText === lastSentText) {
      return true;
    }
    try {
      if (!currentEventId) {
        const result = await sendSingleTextMessageMatrix(roomId, preparedText.trimmedText, {
          ...previewOptions,
          replyToId,
          live: useLive,
        });
        currentEventId = result.messageId;
        lastSentText = preparedText.trimmedText;
        lastSentContent = preparedText.convertedText;
        log?.(`draft-stream: created message ${currentEventId}${useLive ? " (MSC4357 live)" : ""}`);
      } else {
        await editMessageMatrix(roomId, currentEventId, preparedText.trimmedText, {
          ...previewOptions,
          live: useLive,
        });
        lastSentText = preparedText.trimmedText;
        lastSentContent = preparedText.convertedText;
      }
      return true;
    } catch (err) {
      log?.(`draft-stream: send/edit failed: ${String(err)}`);
      const isPreviewLimitError =
        err instanceof Error && err.message.startsWith("Matrix single-message text exceeds limit");
      if (isPreviewLimitError) {
        finalizeInPlaceBlocked = true;
      }
      if (!currentEventId) {
        sendFailed = true;
      }
      streamState.stopped = true;
      return false;
    }
  };

  const {
    loop,
    update,
    stop: stopDraft,
    discardPending,
    seal,
    clear,
    retire,
    cleanupPending,
  } = createFinalizableDraftLifecycle({
    throttleMs: DEFAULT_THROTTLE_MS,
    state: streamState,
    sendOrEditStreamMessage: sendOrEdit,
    readMessageId: () => currentEventId,
    clearMessageId: () => {
      currentEventId = undefined;
      lastSentText = "";
      lastSentContent = "";
    },
    isValidMessageId: (id): id is string => typeof id === "string" && id.length > 0,
    deleteMessage: async (id) => {
      await client.redactEvent(roomId, id);
    },
    warn: log,
    warnPrefix: "matrix draft preview cleanup failed",
  });

  log?.(`draft-stream: ready (throttleMs=${DEFAULT_THROTTLE_MS})`);

  const finalizeLive = async (): Promise<boolean> => {
    // Send a final edit without the MSC4357 live marker to signal that
    // the stream is complete. Supporting clients will stop the streaming
    // animation and display the final content.
    if (useLive && !liveFinalized && currentEventId && lastSentText) {
      liveFinalized = true;
      try {
        await editMessageMatrix(roomId, currentEventId, lastSentText, {
          ...previewOptions,
          live: false,
        });
        log?.(`draft-stream: finalized ${currentEventId} (MSC4357 stream ended)`);
        return true;
      } catch (err) {
        log?.(`draft-stream: finalize edit failed: ${String(err)}`);
        // If the finalize edit fails, the live marker remains on the last
        // successful edit. Flag the stream so callers can fall back to
        // normal final delivery or redaction instead of leaving the message
        // stuck in a "still streaming" state for MSC4357 clients.
        finalizeInPlaceBlocked = true;
        return false;
      }
    }
    return true;
  };

  const stop = async (): Promise<string | undefined> => {
    await stopDraft();
    return currentEventId;
  };

  const resetCurrentMessage = (): void => {
    currentEventId = undefined;
    lastSentText = "";
    lastSentContent = "";
    sendFailed = false;
    finalizeInPlaceBlocked = false;
    liveFinalized = false;
    loop.resetPending();
    loop.resetThrottleWindow();
  };
  const reset = (): void => {
    // A new block consumes the first-only reply reference; retraction does not.
    replyToId = params.preserveReplyId ? params.replyToId : undefined;
    streamState.stopped = false;
    streamState.final = false;
    resetCurrentMessage();
  };
  const deleteCurrentMessage = async () => {
    loop.resetPending();
    await loop.waitForInFlight();
    const retiredEventId = currentEventId;
    resetCurrentMessage();
    if (retiredEventId) {
      await retire(retiredEventId);
    }
  };

  return {
    update,
    flush: loop.flush,
    stop,
    discardPending,
    seal,
    clear,
    cleanupPending,
    deleteCurrentMessage,
    finalizeLive,
    reset,
    eventId: () => currentEventId,
    content: () => lastSentContent || undefined,
    matchesPreparedText: (text: string) =>
      prepareMatrixSingleText(text.trimEnd(), {
        cfg,
        accountId,
        preserveWhitespace: true,
      }).trimmedText === lastSentText,
    mustDeliverFinalNormally: () => sendFailed || finalizeInPlaceBlocked,
  };
}
