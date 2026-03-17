import { Routes } from "discord-api-types/v10";
import { createFinalizableDraftLifecycle } from "../../../src/channels/draft-stream-controls.js";
const DISCORD_STREAM_MAX_CHARS = 2e3;
const DEFAULT_THROTTLE_MS = 1200;
function createDiscordDraftStream(params) {
  const maxChars = Math.min(params.maxChars ?? DISCORD_STREAM_MAX_CHARS, DISCORD_STREAM_MAX_CHARS);
  const throttleMs = Math.max(250, params.throttleMs ?? DEFAULT_THROTTLE_MS);
  const minInitialChars = params.minInitialChars;
  const channelId = params.channelId;
  const rest = params.rest;
  const resolveReplyToMessageId = () => typeof params.replyToMessageId === "function" ? params.replyToMessageId() : params.replyToMessageId;
  const streamState = { stopped: false, final: false };
  let streamMessageId;
  let lastSentText = "";
  const sendOrEditStreamMessage = async (text) => {
    if (streamState.stopped && !streamState.final) {
      return false;
    }
    const trimmed = text.trimEnd();
    if (!trimmed) {
      return false;
    }
    if (trimmed.length > maxChars) {
      streamState.stopped = true;
      params.warn?.(`discord stream preview stopped (text length ${trimmed.length} > ${maxChars})`);
      return false;
    }
    if (trimmed === lastSentText) {
      return true;
    }
    if (streamMessageId === void 0 && minInitialChars != null && !streamState.final) {
      if (trimmed.length < minInitialChars) {
        return false;
      }
    }
    lastSentText = trimmed;
    try {
      if (streamMessageId !== void 0) {
        await rest.patch(Routes.channelMessage(channelId, streamMessageId), {
          body: { content: trimmed }
        });
        return true;
      }
      const replyToMessageId = resolveReplyToMessageId()?.trim();
      const messageReference = replyToMessageId ? { message_id: replyToMessageId, fail_if_not_exists: false } : void 0;
      const sent = await rest.post(Routes.channelMessages(channelId), {
        body: {
          content: trimmed,
          ...messageReference ? { message_reference: messageReference } : {}
        }
      });
      const sentMessageId = sent?.id;
      if (typeof sentMessageId !== "string" || !sentMessageId) {
        streamState.stopped = true;
        params.warn?.("discord stream preview stopped (missing message id from send)");
        return false;
      }
      streamMessageId = sentMessageId;
      return true;
    } catch (err) {
      streamState.stopped = true;
      params.warn?.(
        `discord stream preview failed: ${err instanceof Error ? err.message : String(err)}`
      );
      return false;
    }
  };
  const readMessageId = () => streamMessageId;
  const clearMessageId = () => {
    streamMessageId = void 0;
  };
  const isValidStreamMessageId = (value) => typeof value === "string";
  const deleteStreamMessage = async (messageId) => {
    await rest.delete(Routes.channelMessage(channelId, messageId));
  };
  const { loop, update, stop, clear } = createFinalizableDraftLifecycle({
    throttleMs,
    state: streamState,
    sendOrEditStreamMessage,
    readMessageId,
    clearMessageId,
    isValidMessageId: isValidStreamMessageId,
    deleteMessage: deleteStreamMessage,
    warn: params.warn,
    warnPrefix: "discord stream preview cleanup failed"
  });
  const forceNewMessage = () => {
    streamMessageId = void 0;
    lastSentText = "";
    loop.resetPending();
  };
  params.log?.(`discord stream preview ready (maxChars=${maxChars}, throttleMs=${throttleMs})`);
  return {
    update,
    flush: loop.flush,
    messageId: () => streamMessageId,
    clear,
    stop,
    forceNewMessage
  };
}
export {
  createDiscordDraftStream
};
