import { Routes } from "discord-api-types/v10";
import { createFinalizableDraftLifecycle } from "openclaw/plugin-sdk/channel-outbound";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import {
  deleteChannelMessage,
  editChannelMessage,
  type RequestClient,
} from "./internal/discord.js";
import { resolveDiscordMessageFlags } from "./send.shared.js";

/** Discord messages cap at 2000 characters. */
const DISCORD_STREAM_MAX_CHARS = 2000;
const DEFAULT_THROTTLE_MS = 1200;
const DISCORD_PREVIEW_ALLOWED_MENTIONS = { parse: [] };

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
}) {
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

  const sendOrEditStreamMessage = async ({
    text,
    complete,
  }: DiscordDraftUpdate): Promise<boolean> => {
    const generation = lifecycle.generation;
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
      const body = {
        content: trimmed,
        allowed_mentions: DISCORD_PREVIEW_ALLOWED_MENTIONS,
        ...(flags ? { flags } : {}),
      };
      if (streamMessage !== undefined) {
        await editChannelMessage(rest, streamMessage.channelId, streamMessage.messageId, {
          body,
        });
        if (generation === lifecycle.generation) {
          lastSentText = trimmed;
        }
        return true;
      }
      const replyToMessageId = resolveReplyToMessageId()?.trim();
      const messageReference = replyToMessageId
        ? { message_id: replyToMessageId, fail_if_not_exists: false }
        : undefined;
      return await lifecycle.createMessage(
        async () => {
          const sent = (await rest.post(Routes.channelMessages(targetChannelId), {
            body: {
              ...body,
              ...(messageReference ? { message_reference: messageReference } : {}),
            },
          })) as { id?: string }; // SAFETY: The create response's ID is checked before use.
          return typeof sent?.id === "string" && sent.id
            ? { channelId: targetChannelId, messageId: sent.id }
            : undefined;
        },
        (message) => {
          if (!message) {
            streamState.stopped = true;
            params.warn?.("discord stream preview stopped (missing message id from send)");
            return false;
          }
          streamMessage = message;
          lastSentText = trimmed;
          return true;
        },
      );
    } catch (err) {
      if (generation !== lifecycle.generation) {
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
  const update = (text: string, options?: { complete?: boolean }) =>
    updateDraft({ text, complete: options?.complete === true });

  /** Move the draft to another channel, preserving its current text. */
  const retarget = async (nextChannelId: string) => {
    const normalized = nextChannelId.trim();
    if (!normalized || normalized === channelId) {
      return;
    }
    await loop.waitForInFlight();
    const pending = loop.takePending();
    const previousMessage = streamMessage;
    const previousText = pending.text || lastSentText;
    channelId = normalized;
    lifecycle.reset();
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

  params.log?.(`discord stream preview ready (maxChars=${maxChars}, throttleMs=${throttleMs})`);

  return {
    update,
    flush: loop.flush,
    messageId: () => streamMessage?.messageId,
    lastDeliveredText: () => lastSentText,
    clear: () => lifecycle.retireCurrent(discardPending),
    deleteCurrentMessage: () =>
      lifecycle.retireCurrent(async () => {
        loop.resetPending();
        await loop.waitForInFlight();
      }),
    discardPending,
    seal,
    stop,
    retarget,
    cleanupPendingMessages: lifecycle.cleanupPending,
    forceNewMessage: lifecycle.reset,
  };
}
