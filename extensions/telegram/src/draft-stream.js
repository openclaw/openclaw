import { createFinalizableDraftLifecycle } from "../../../src/channels/draft-stream-controls.js";
import { resolveGlobalSingleton } from "../../../src/shared/global-singleton.js";
import { buildTelegramThreadParams } from "./bot/helpers.js";
import { isSafeToRetrySendError, isTelegramClientRejection } from "./network-errors.js";
const TELEGRAM_STREAM_MAX_CHARS = 4096;
const DEFAULT_THROTTLE_MS = 1e3;
const TELEGRAM_DRAFT_ID_MAX = 2147483647;
const THREAD_NOT_FOUND_RE = /400:\s*Bad Request:\s*message thread not found/i;
const DRAFT_METHOD_UNAVAILABLE_RE = /(unknown method|method .*not (found|available|supported)|unsupported)/i;
const DRAFT_CHAT_UNSUPPORTED_RE = /(can't be used|can be used only)/i;
const TELEGRAM_DRAFT_STREAM_STATE_KEY = /* @__PURE__ */ Symbol.for("openclaw.telegramDraftStreamState");
const draftStreamState = resolveGlobalSingleton(TELEGRAM_DRAFT_STREAM_STATE_KEY, () => ({
  nextDraftId: 0
}));
function allocateTelegramDraftId() {
  draftStreamState.nextDraftId = draftStreamState.nextDraftId >= TELEGRAM_DRAFT_ID_MAX ? 1 : draftStreamState.nextDraftId + 1;
  return draftStreamState.nextDraftId;
}
function resolveSendMessageDraftApi(api) {
  const sendMessageDraft = api.sendMessageDraft;
  if (typeof sendMessageDraft !== "function") {
    return void 0;
  }
  return sendMessageDraft.bind(api);
}
function shouldFallbackFromDraftTransport(err) {
  const text = typeof err === "string" ? err : err instanceof Error ? err.message : typeof err === "object" && err && "description" in err ? typeof err.description === "string" ? err.description : "" : "";
  if (!/sendMessageDraft/i.test(text)) {
    return false;
  }
  return DRAFT_METHOD_UNAVAILABLE_RE.test(text) || DRAFT_CHAT_UNSUPPORTED_RE.test(text);
}
function createTelegramDraftStream(params) {
  const maxChars = Math.min(
    params.maxChars ?? TELEGRAM_STREAM_MAX_CHARS,
    TELEGRAM_STREAM_MAX_CHARS
  );
  const throttleMs = Math.max(250, params.throttleMs ?? DEFAULT_THROTTLE_MS);
  const minInitialChars = params.minInitialChars;
  const chatId = params.chatId;
  const requestedPreviewTransport = params.previewTransport ?? "auto";
  const prefersDraftTransport = requestedPreviewTransport === "draft" ? true : requestedPreviewTransport === "message" ? false : params.thread?.scope === "dm";
  const threadParams = buildTelegramThreadParams(params.thread);
  const replyParams = params.replyToMessageId != null ? { ...threadParams, reply_to_message_id: params.replyToMessageId } : threadParams;
  const resolvedDraftApi = prefersDraftTransport ? resolveSendMessageDraftApi(params.api) : void 0;
  const usesDraftTransport = Boolean(prefersDraftTransport && resolvedDraftApi);
  if (prefersDraftTransport && !usesDraftTransport) {
    params.warn?.(
      "telegram stream preview: sendMessageDraft unavailable; falling back to sendMessage/editMessageText"
    );
  }
  const streamState = { stopped: false, final: false };
  let messageSendAttempted = false;
  let streamMessageId;
  let streamDraftId = usesDraftTransport ? allocateTelegramDraftId() : void 0;
  let previewTransport = usesDraftTransport ? "draft" : "message";
  let lastSentText = "";
  let lastDeliveredText = "";
  let lastSentParseMode;
  let previewRevision = 0;
  let generation = 0;
  const sendRenderedMessageWithThreadFallback = async (sendArgs) => {
    const sendParams = sendArgs.renderedParseMode ? {
      ...replyParams,
      parse_mode: sendArgs.renderedParseMode
    } : replyParams;
    const usedThreadParams = "message_thread_id" in (sendParams ?? {}) && typeof sendParams.message_thread_id === "number";
    try {
      return {
        sent: await params.api.sendMessage(chatId, sendArgs.renderedText, sendParams),
        usedThreadParams
      };
    } catch (err) {
      if (!usedThreadParams || !THREAD_NOT_FOUND_RE.test(String(err))) {
        throw err;
      }
      const threadlessParams = {
        ...sendParams
      };
      delete threadlessParams.message_thread_id;
      params.warn?.(sendArgs.fallbackWarnMessage);
      return {
        sent: await params.api.sendMessage(
          chatId,
          sendArgs.renderedText,
          Object.keys(threadlessParams).length > 0 ? threadlessParams : void 0
        ),
        usedThreadParams: false
      };
    }
  };
  const sendMessageTransportPreview = async ({
    renderedText,
    renderedParseMode,
    sendGeneration
  }) => {
    if (typeof streamMessageId === "number") {
      if (renderedParseMode) {
        await params.api.editMessageText(chatId, streamMessageId, renderedText, {
          parse_mode: renderedParseMode
        });
      } else {
        await params.api.editMessageText(chatId, streamMessageId, renderedText);
      }
      return true;
    }
    messageSendAttempted = true;
    let sent;
    try {
      ({ sent } = await sendRenderedMessageWithThreadFallback({
        renderedText,
        renderedParseMode,
        fallbackWarnMessage: "telegram stream preview send failed with message_thread_id, retrying without thread"
      }));
    } catch (err) {
      if (isSafeToRetrySendError(err) || isTelegramClientRejection(err)) {
        messageSendAttempted = false;
      }
      throw err;
    }
    const sentMessageId = sent?.message_id;
    if (typeof sentMessageId !== "number" || !Number.isFinite(sentMessageId)) {
      streamState.stopped = true;
      params.warn?.("telegram stream preview stopped (missing message id from sendMessage)");
      return false;
    }
    const normalizedMessageId = Math.trunc(sentMessageId);
    if (sendGeneration !== generation) {
      params.onSupersededPreview?.({
        messageId: normalizedMessageId,
        textSnapshot: renderedText,
        parseMode: renderedParseMode
      });
      return true;
    }
    streamMessageId = normalizedMessageId;
    return true;
  };
  const sendDraftTransportPreview = async ({
    renderedText,
    renderedParseMode
  }) => {
    const draftId = streamDraftId ?? allocateTelegramDraftId();
    streamDraftId = draftId;
    const draftParams = {
      ...threadParams?.message_thread_id != null ? { message_thread_id: threadParams.message_thread_id } : {},
      ...renderedParseMode ? { parse_mode: renderedParseMode } : {}
    };
    await resolvedDraftApi(
      chatId,
      draftId,
      renderedText,
      Object.keys(draftParams).length > 0 ? draftParams : void 0
    );
    return true;
  };
  const sendOrEditStreamMessage = async (text) => {
    if (streamState.stopped && !streamState.final) {
      return false;
    }
    const trimmed = text.trimEnd();
    if (!trimmed) {
      return false;
    }
    const rendered = params.renderText?.(trimmed) ?? { text: trimmed };
    const renderedText = rendered.text.trimEnd();
    const renderedParseMode = rendered.parseMode;
    if (!renderedText) {
      return false;
    }
    if (renderedText.length > maxChars) {
      streamState.stopped = true;
      params.warn?.(
        `telegram stream preview stopped (text length ${renderedText.length} > ${maxChars})`
      );
      return false;
    }
    if (renderedText === lastSentText && renderedParseMode === lastSentParseMode) {
      return true;
    }
    const sendGeneration = generation;
    if (typeof streamMessageId !== "number" && minInitialChars != null && !streamState.final) {
      if (renderedText.length < minInitialChars) {
        return false;
      }
    }
    lastSentText = renderedText;
    lastSentParseMode = renderedParseMode;
    try {
      let sent = false;
      if (previewTransport === "draft") {
        try {
          sent = await sendDraftTransportPreview({
            renderedText,
            renderedParseMode,
            sendGeneration
          });
        } catch (err) {
          if (!shouldFallbackFromDraftTransport(err)) {
            throw err;
          }
          previewTransport = "message";
          streamDraftId = void 0;
          params.warn?.(
            "telegram stream preview: sendMessageDraft rejected by API; falling back to sendMessage/editMessageText"
          );
          sent = await sendMessageTransportPreview({
            renderedText,
            renderedParseMode,
            sendGeneration
          });
        }
      } else {
        sent = await sendMessageTransportPreview({
          renderedText,
          renderedParseMode,
          sendGeneration
        });
      }
      if (sent) {
        previewRevision += 1;
        lastDeliveredText = trimmed;
      }
      return sent;
    } catch (err) {
      streamState.stopped = true;
      params.warn?.(
        `telegram stream preview failed: ${err instanceof Error ? err.message : String(err)}`
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
      streamMessageId = void 0;
    },
    isValidMessageId: (value) => typeof value === "number" && Number.isFinite(value),
    deleteMessage: async (messageId) => {
      await params.api.deleteMessage(chatId, messageId);
    },
    onDeleteSuccess: (messageId) => {
      params.log?.(`telegram stream preview deleted (chat=${chatId}, message=${messageId})`);
    },
    warn: params.warn,
    warnPrefix: "telegram stream preview cleanup failed"
  });
  const forceNewMessage = () => {
    streamState.final = false;
    generation += 1;
    messageSendAttempted = false;
    streamMessageId = void 0;
    if (previewTransport === "draft") {
      streamDraftId = allocateTelegramDraftId();
    }
    lastSentText = "";
    lastSentParseMode = void 0;
    loop.resetPending();
    loop.resetThrottleWindow();
  };
  const materialize = async () => {
    await stop();
    if (previewTransport === "message" && typeof streamMessageId === "number") {
      return streamMessageId;
    }
    const renderedText = lastSentText || lastDeliveredText;
    if (!renderedText) {
      return void 0;
    }
    const renderedParseMode = lastSentText ? lastSentParseMode : void 0;
    try {
      const { sent, usedThreadParams } = await sendRenderedMessageWithThreadFallback({
        renderedText,
        renderedParseMode,
        fallbackWarnMessage: "telegram stream preview materialize send failed with message_thread_id, retrying without thread"
      });
      const sentId = sent?.message_id;
      if (typeof sentId === "number" && Number.isFinite(sentId)) {
        streamMessageId = Math.trunc(sentId);
        if (resolvedDraftApi != null && streamDraftId != null) {
          const clearDraftId = streamDraftId;
          const clearThreadParams = usedThreadParams && threadParams?.message_thread_id != null ? { message_thread_id: threadParams.message_thread_id } : void 0;
          try {
            await resolvedDraftApi(chatId, clearDraftId, "", clearThreadParams);
          } catch {
          }
        }
        return streamMessageId;
      }
    } catch (err) {
      params.warn?.(
        `telegram stream preview materialize failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }
    return void 0;
  };
  params.log?.(`telegram stream preview ready (maxChars=${maxChars}, throttleMs=${throttleMs})`);
  return {
    update,
    flush: loop.flush,
    messageId: () => streamMessageId,
    previewMode: () => previewTransport,
    previewRevision: () => previewRevision,
    lastDeliveredText: () => lastDeliveredText,
    clear,
    stop,
    materialize,
    forceNewMessage,
    sendMayHaveLanded: () => messageSendAttempted && typeof streamMessageId !== "number"
  };
}
const __testing = {
  resetTelegramDraftStreamForTests() {
    draftStreamState.nextDraftId = 0;
  }
};
export {
  __testing,
  createTelegramDraftStream
};
