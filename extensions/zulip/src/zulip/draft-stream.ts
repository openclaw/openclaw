import { createFinalizableDraftLifecycle } from "../../../../src/channels/draft-stream-controls.js";
import {
  sendZulipStreamMessage,
  sendZulipDirectMessage,
  updateZulipMessage,
  type ZulipClient,
  type ZulipSendMessageResponse,
} from "./client.js";

/** Zulip messages have a generous limit, but keep previews reasonable. */
const ZULIP_STREAM_MAX_CHARS = 10000;
const DEFAULT_THROTTLE_MS = 1200;

export type ZulipDraftStream = {
  update: (text: string) => void;
  flush: () => Promise<void>;
  messageId: () => number | undefined;
  clear: () => Promise<void>;
  stop: () => Promise<void>;
  /** Reset internal state so the next update creates a new message instead of editing. */
  forceNewMessage: () => void;
};

export type ZulipDraftTarget =
  | { kind: "stream"; stream: string; topic: string }
  | { kind: "dm"; userIds: number[] };

export function createZulipDraftStream(params: {
  client: ZulipClient;
  target: ZulipDraftTarget;
  maxChars?: number;
  throttleMs?: number;
  /** Minimum chars before sending first message (debounce for push notifications). */
  minInitialChars?: number;
  log?: (message: string) => void;
  warn?: (message: string) => void;
}): ZulipDraftStream {
  const maxChars = Math.min(params.maxChars ?? ZULIP_STREAM_MAX_CHARS, ZULIP_STREAM_MAX_CHARS);
  const throttleMs = Math.max(250, params.throttleMs ?? DEFAULT_THROTTLE_MS);
  const minInitialChars = params.minInitialChars;
  const client = params.client;
  const target = params.target;

  const streamState = { stopped: false, final: false };
  let streamMessageId: number | undefined;
  let lastSentText = "";

  const sendOrEditStreamMessage = async (text: string): Promise<boolean> => {
    if (streamState.stopped && !streamState.final) {
      return false;
    }
    const trimmed = text.trimEnd();
    if (!trimmed) {
      return false;
    }
    if (trimmed.length > maxChars) {
      streamState.stopped = true;
      params.warn?.(`zulip stream preview stopped (text length ${trimmed.length} > ${maxChars})`);
      return false;
    }
    if (trimmed === lastSentText) {
      return true;
    }

    // Debounce first preview send for better notification quality.
    if (streamMessageId === undefined && minInitialChars != null && !streamState.final) {
      if (trimmed.length < minInitialChars) {
        return false;
      }
    }

    lastSentText = trimmed;
    try {
      if (streamMessageId !== undefined) {
        // Edit existing message
        await updateZulipMessage(client, {
          messageId: streamMessageId,
          content: trimmed,
        });
        return true;
      }
      // Send new message
      let res: ZulipSendMessageResponse;
      if (target.kind === "stream") {
        res = await sendZulipStreamMessage(client, {
          stream: target.stream,
          topic: target.topic,
          content: trimmed,
        });
      } else {
        res = await sendZulipDirectMessage(client, {
          to: target.userIds,
          content: trimmed,
        });
      }
      const sentId = res.id;
      if (typeof sentId !== "number" || !Number.isFinite(sentId)) {
        streamState.stopped = true;
        params.warn?.("zulip stream preview stopped (missing message id from send)");
        return false;
      }
      streamMessageId = sentId;
      return true;
    } catch (err) {
      streamState.stopped = true;
      params.warn?.(
        `zulip stream preview failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    }
  };

  const { loop, update, stop, clear } = createFinalizableDraftLifecycle({
    throttleMs,
    state: streamState,
    sendOrEditStreamMessage,
    readMessageId: () => streamMessageId,
    clearMessageId: () => {
      streamMessageId = undefined;
    },
    isValidMessageId: (value): value is number =>
      typeof value === "number" && Number.isFinite(value),
    deleteMessage: async (messageId) => {
      // Zulip doesn't let bots delete their own messages in all cases,
      // so we update the content to empty/placeholder instead.
      try {
        await updateZulipMessage(client, {
          messageId,
          content: "*(message cleared)*",
        });
      } catch {
        // Best-effort cleanup — if update fails, the preview message stays.
      }
    },
    warn: params.warn,
    warnPrefix: "zulip stream preview cleanup failed",
  });

  const forceNewMessage = () => {
    streamMessageId = undefined;
    lastSentText = "";
    loop.resetPending();
  };

  params.log?.(`zulip stream preview ready (maxChars=${maxChars}, throttleMs=${throttleMs})`);

  return {
    update,
    flush: loop.flush,
    messageId: () => streamMessageId,
    clear,
    stop,
    forceNewMessage,
  };
}
