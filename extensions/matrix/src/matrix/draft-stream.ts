import { createDraftStreamLoop } from "openclaw/plugin-sdk/channel-lifecycle";
import type { CoreConfig } from "../types.js";
import type { MatrixClient } from "./sdk.js";
import { editMessageMatrix, prepareMatrixSingleText, sendSingleTextMessageMatrix } from "./send.js";
import { MsgType } from "./send/types.js";

const DEFAULT_THROTTLE_MS = 1000;
const DRAFT_PREVIEW_MSGTYPE = MsgType.Notice;

export type MatrixDraftStream = {
  /** Update the draft with the latest accumulated text for the current block. */
  update: (text: string) => void;
  /** Ensure the last pending update has been sent. */
  flush: () => Promise<void>;
  /** Flush and mark this block as done. Returns the event ID if a message was sent. */
  stop: () => Promise<string | undefined>;
  /** Reset state for the next text block (after tool calls). */
  reset: () => void;
  /** The event ID of the current draft message, if any. */
  eventId: () => string | undefined;
  /** The last text successfully sent or edited. */
  lastSentText: () => string;
};

export function createMatrixDraftStream(params: {
  roomId: string;
  client: MatrixClient;
  cfg: CoreConfig;
  threadId?: string;
  replyToId?: string;
  /** When true, reset() restores the original replyToId instead of clearing it. */
  preserveReplyId?: boolean;
  accountId?: string;
  log?: (message: string) => void;
}): MatrixDraftStream {
  const { roomId, client, cfg, threadId, accountId, log } = params;

  let currentEventId: string | undefined;
  let lastSentText = "";
  let stopped = false;
  let replyToId = params.replyToId;

  const sendOrEdit = async (text: string): Promise<boolean> => {
    const trimmed = text.trimEnd();
    if (!trimmed) {
      return false;
    }
    const preparedText = prepareMatrixSingleText(trimmed, { cfg, accountId });
    if (!preparedText.fitsInSingleEvent) {
      stopped = true;
      log?.(
        `draft-stream: preview exceeded single-event limit (${preparedText.convertedText.length} > ${preparedText.singleEventLimit})`,
      );
      return false;
    }
    if (preparedText.trimmedText === lastSentText) {
      return true;
    }
    try {
      if (!currentEventId) {
        const result = await sendSingleTextMessageMatrix(roomId, preparedText.trimmedText, {
          client,
          cfg,
          replyToId,
          threadId,
          accountId,
          msgtype: DRAFT_PREVIEW_MSGTYPE,
          includeMentions: false,
        });
        currentEventId = result.messageId;
        lastSentText = preparedText.trimmedText;
        log?.(`draft-stream: created message ${currentEventId}`);
      } else {
        await editMessageMatrix(roomId, currentEventId, preparedText.trimmedText, {
          client,
          cfg,
          threadId,
          accountId,
          msgtype: DRAFT_PREVIEW_MSGTYPE,
          includeMentions: false,
        });
        lastSentText = preparedText.trimmedText;
      }
      return true;
    } catch (err) {
      log?.(`draft-stream: send/edit failed: ${String(err)}`);
      stopped = true;
      return false;
    }
  };

  const loop = createDraftStreamLoop({
    throttleMs: DEFAULT_THROTTLE_MS,
    isStopped: () => stopped,
    sendOrEditStreamMessage: sendOrEdit,
  });

  log?.(`draft-stream: ready (throttleMs=${DEFAULT_THROTTLE_MS})`);

  const stop = async (): Promise<string | undefined> => {
    // Flush before marking stopped so the loop can drain pending text.
    await loop.flush();
    stopped = true;
    return currentEventId;
  };

  const reset = (): void => {
    // Clear reply context unless preserveReplyId is set (replyToMode "all"),
    // in which case subsequent blocks should keep replying to the original.
    replyToId = params.preserveReplyId ? params.replyToId : undefined;
    currentEventId = undefined;
    lastSentText = "";
    stopped = false;
    loop.resetPending();
    loop.resetThrottleWindow();
  };

  return {
    update: (text: string) => {
      if (stopped) {
        return;
      }
      loop.update(text);
    },
    flush: loop.flush,
    stop,
    reset,
    eventId: () => currentEventId,
    lastSentText: () => lastSentText,
  };
}
