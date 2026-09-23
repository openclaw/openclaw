import { createFinalizableDraftLifecycle } from "openclaw/plugin-sdk/channel-outbound";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import {
  createChannelMessage,
  deleteChannelMessage,
  editChannelMessage,
  type RequestClient,
} from "./internal/discord.js";
import { resolveDiscordMessageFlags } from "./send.shared.js";

/** Discord messages cap at 2000 characters. */
const DISCORD_STREAM_MAX_CHARS = 2000;
const DEFAULT_THROTTLE_MS = 1200;
const DISCORD_PREVIEW_ALLOWED_MENTIONS = { parse: [] };

type DiscordDraftStream = {
  update: (text: string, options?: { complete?: boolean }) => void;
  flush: () => Promise<void>;
  messageId: () => string | undefined;
  lastDeliveredText: () => string;
  clear: () => Promise<void>;
  deleteCurrentMessage: () => Promise<void>;
  discardPending: () => Promise<void>;
  seal: () => Promise<void>;
  stop: () => Promise<void>;
  /** Move the active draft to another Discord channel, preserving its current text. */
  retarget: (channelId: string) => Promise<void>;
  /** Retry failed preview deletes at the owning turn's cleanup boundary. */
  cleanupPendingMessages: () => Promise<void>;
  /** Reset internal state so the next update creates a new message instead of editing. */
  forceNewMessage: (mode?: "preserve" | "discard") => void;
};

type DiscordDraftMessage = { channelId: string; messageId: string };
type DiscordDraftUpdate = { text: string; complete: boolean };

export function createDiscordDraftStream(params: {
  rest: RequestClient;
  channelId: string;
  maxChars?: number;
  replyToMessageId?: string | (() => string | undefined);
  throttleMs?: number;
  /** Minimum chars before sending first message (debounce for push notifications) */
  minInitialChars?: number;
  suppressEmbeds?: boolean;
  log?: (message: string) => void;
  warn?: (message: string) => void;
}): DiscordDraftStream {
  const maxChars = Math.min(params.maxChars ?? DISCORD_STREAM_MAX_CHARS, DISCORD_STREAM_MAX_CHARS);
  const throttleMs = Math.max(250, params.throttleMs ?? DEFAULT_THROTTLE_MS);
  const minInitialChars = params.minInitialChars;
  let channelId = params.channelId;
  const rest = params.rest;
  const flags = resolveDiscordMessageFlags({ suppressEmbeds: params.suppressEmbeds });
  const resolveReplyToMessageId = () =>
    typeof params.replyToMessageId === "function"
      ? params.replyToMessageId()
      : params.replyToMessageId;

  const streamState = { stopped: false, final: false };
  let streamMessage: DiscordDraftMessage | undefined;
  let lastSentText = "";
  let streamGeneration = 0;
  let activeCreateGeneration: number | undefined;
  let discardActiveCreate = false;

  const sendOrEditStreamMessage = async ({
    text,
    complete,
  }: DiscordDraftUpdate): Promise<boolean> => {
    const generation = streamGeneration;
    const targetChannelId = channelId;
    // Allow final flush even if stopped (e.g., after clear()).
    if (streamState.stopped && !streamState.final) {
      return false;
    }
    const trimmed = text.trimEnd();
    if (!trimmed) {
      return false;
    }
    if (trimmed.length > maxChars) {
      // Discord messages cap at 2000 chars.
      // Stop streaming once we exceed the cap to avoid repeated API failures.
      streamState.stopped = true;
      params.warn?.(`discord stream preview stopped (text length ${trimmed.length} > ${maxChars})`);
      return false;
    }
    if (trimmed === lastSentText) {
      return true;
    }

    // Debounce first preview send for better push notification quality.
    if (streamMessage === undefined && minInitialChars != null && !streamState.final && !complete) {
      if (trimmed.length < minInitialChars) {
        return false;
      }
    }

    try {
      if (streamMessage !== undefined) {
        await editChannelMessage(rest, streamMessage.channelId, streamMessage.messageId, {
          body: {
            content: trimmed,
            allowed_mentions: DISCORD_PREVIEW_ALLOWED_MENTIONS,
            ...(flags ? { flags } : {}),
          },
        });
        if (generation === streamGeneration) {
          lastSentText = trimmed;
        }
        return true;
      }
      // Send new message
      const replyToMessageId = resolveReplyToMessageId()?.trim();
      const messageReference = replyToMessageId
        ? { message_id: replyToMessageId, fail_if_not_exists: false }
        : undefined;
      activeCreateGeneration = generation;
      const sent = await createChannelMessage<{ id?: string }>(rest, targetChannelId, {
        body: {
          content: trimmed,
          allowed_mentions: DISCORD_PREVIEW_ALLOWED_MENTIONS,
          ...(flags ? { flags } : {}),
          ...(messageReference ? { message_reference: messageReference } : {}),
        },
      });
      const sentMessageId = sent?.id;
      const shouldDiscardStaleCreate = activeCreateGeneration === generation && discardActiveCreate;
      activeCreateGeneration = undefined;
      discardActiveCreate = false;
      if (generation !== streamGeneration) {
        if (shouldDiscardStaleCreate && typeof sentMessageId === "string" && sentMessageId) {
          await lifecycle.retire({ channelId: targetChannelId, messageId: sentMessageId });
        }
        return true;
      }
      if (typeof sentMessageId !== "string" || !sentMessageId) {
        streamState.stopped = true;
        params.warn?.("discord stream preview stopped (missing message id from send)");
        return false;
      }
      streamMessage = { channelId: targetChannelId, messageId: sentMessageId };
      lastSentText = trimmed;
      return true;
    } catch (err) {
      if (activeCreateGeneration === generation) {
        activeCreateGeneration = undefined;
        discardActiveCreate = false;
      }
      if (generation !== streamGeneration) {
        return true;
      }
      streamState.stopped = true;
      params.warn?.(`discord stream preview failed: ${formatErrorMessage(err)}`);
      return false;
    }
  };

  const clearMessageId = () => {
    streamMessage = undefined;
    lastSentText = "";
    loop.resetThrottleWindow();
  };
  const lifecycle = createFinalizableDraftLifecycle<DiscordDraftMessage, DiscordDraftUpdate>({
    throttleMs,
    coalesceInFlight: true,
    state: streamState,
    sendOrEditStreamMessage,
    emptyValue: { text: "", complete: false },
    isEmpty: (value) => !value.text,
    readMessageId: () => streamMessage,
    clearMessageId,
    isValidMessageId: (value): value is DiscordDraftMessage => value !== undefined,
    deleteMessage: (message) => deleteChannelMessage(rest, message.channelId, message.messageId),
    warn: params.warn,
    warnPrefix: "discord stream preview cleanup failed",
  });
  const { loop, update: updateDraft, stop, discardPending, seal } = lifecycle;
  const update: DiscordDraftStream["update"] = (text, options) =>
    updateDraft({ text, complete: options?.complete === true });

  const forceNewMessage = (mode: "preserve" | "discard" = "preserve") => {
    // In-flight REST calls may finish after a turn boundary. Advance identity
    // synchronously so their result cannot overwrite the next turn's state.
    // Block mode preserves the prior block; progress mode discards its draft.
    if (mode === "discard" && activeCreateGeneration !== undefined) {
      discardActiveCreate = true;
    }
    streamGeneration += 1;
    streamState.stopped = false;
    streamState.final = false;
    streamMessage = undefined;
    lastSentText = "";
    loop.resetPending();
    loop.resetThrottleWindow();
  };
  const retarget = async (nextChannelId: string) => {
    const normalized = nextChannelId.trim();
    if (!normalized || normalized === channelId) {
      return;
    }
    await loop.waitForInFlight();
    const pending = loop.takePending();
    const previousMessage = streamMessage;
    const previousText = pending.text || lastSentText;
    streamGeneration += 1;
    channelId = normalized;
    streamMessage = undefined;
    lastSentText = "";
    streamState.stopped = false;
    streamState.final = false;
    loop.resetThrottleWindow();
    if (previousText) {
      update(previousText, { complete: pending.text ? pending.complete : true });
      await loop.flush();
    }
    if (previousMessage) {
      if (!streamMessage) {
        await lifecycle.retire(previousMessage, { defer: true });
        throw new Error("discord stream preview retarget replacement failed");
      }
      await lifecycle.retire(previousMessage);
    }
  };
  const retireCurrentMessage = async (stopForClear: () => Promise<void>) => {
    const generation = streamGeneration;
    await stopForClear();
    if (generation !== streamGeneration) {
      return;
    }
    const message = streamMessage;
    clearMessageId();
    if (message) {
      await lifecycle.retire(message);
    }
  };

  params.log?.(`discord stream preview ready (maxChars=${maxChars}, throttleMs=${throttleMs})`);

  return {
    update,
    flush: loop.flush,
    messageId: () => streamMessage?.messageId,
    lastDeliveredText: () => lastSentText,
    clear: () => retireCurrentMessage(discardPending),
    deleteCurrentMessage: () =>
      retireCurrentMessage(async () => {
        loop.resetPending();
        await loop.waitForInFlight();
      }),
    discardPending,
    seal,
    stop,
    retarget,
    cleanupPendingMessages: async () => {
      await lifecycle.cleanupPending();
    },
    forceNewMessage,
  };
}
