import type { Bot } from "grammy";
import { createFinalizableDraftStreamControlsForState } from "openclaw/plugin-sdk/channel-lifecycle";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { buildTelegramThreadParams, type TelegramThreadSpec } from "./bot/helpers.js";
import type { TelegramDraftStream } from "./draft-stream.js";
import {
  allocateTelegramDraftId,
  normalizeDraftText,
  resolveSendMessageDraftApi,
  TELEGRAM_NATIVE_DRAFT_MAX_CHARS,
} from "./native-draft-api.js";

const DEFAULT_THROTTLE_MS = 1000;

type TelegramDraftPreview = {
  text: string;
  parseMode?: "HTML";
};

type SupersededTelegramPreview = {
  messageId: number;
  textSnapshot: string;
  parseMode?: "HTML";
  visibleSinceMs?: number;
  retain?: boolean;
};

export function createNativeTelegramAnswerDraftStream(params: {
  api: Bot["api"];
  chatId: Parameters<Bot["api"]["sendMessage"]>[0];
  maxChars?: number;
  thread?: TelegramThreadSpec | null;
  replyToMessageId?: number;
  throttleMs?: number;
  minInitialChars?: number;
  renderText?: (text: string) => TelegramDraftPreview;
  onSupersededPreview?: (preview: SupersededTelegramPreview) => void;
  log?: (message: string) => void;
  warn?: (message: string) => void;
}): TelegramDraftStream | undefined {
  const sendMessageDraft = resolveSendMessageDraftApi(params.api);
  if (!sendMessageDraft) {
    return undefined;
  }

  const throttleMs = Math.max(250, params.throttleMs ?? DEFAULT_THROTTLE_MS);
  const minInitialChars = params.minInitialChars;
  const chatId = params.chatId;
  const threadParams = buildTelegramThreadParams(params.thread);

  const streamState = { stopped: false, final: false };
  let draftId = allocateTelegramDraftId();
  let streamVisibleSinceMs: number | undefined;
  let lastSentText = "";
  let lastDeliveredText = "";
  let lastSentParseMode: "HTML" | undefined;
  let previewRevision = 0;
  let suppressNonFinalFallback = false;

  const draftThreadParams =
    threadParams && Object.keys(threadParams).length > 0 ? threadParams : undefined;

  const sendOrEditStreamMessage = async (text: string): Promise<boolean> => {
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

    const draftText =
      renderedParseMode && renderedText.length > TELEGRAM_NATIVE_DRAFT_MAX_CHARS
        ? normalizeDraftText(trimmed)
        : normalizeDraftText(renderedText);
    const draftParseMode =
      renderedParseMode && renderedText.length <= TELEGRAM_NATIVE_DRAFT_MAX_CHARS
        ? renderedParseMode
        : undefined;

    if (draftText === lastSentText && draftParseMode === lastSentParseMode) {
      return true;
    }

    if (minInitialChars != null && previewRevision === 0) {
      if (renderedText.length < minInitialChars) {
        return false;
      }
    }

    if (!draftText) {
      return false;
    }

    lastSentText = draftText;
    lastSentParseMode = draftParseMode;

    try {
      await sendMessageDraft(
        chatId,
        draftId,
        draftText,
        draftParseMode ? { ...draftThreadParams, parse_mode: draftParseMode } : draftThreadParams,
      );
      previewRevision += 1;
      streamVisibleSinceMs ??= Date.now();
      lastDeliveredText = trimmed;
      return true;
    } catch (err) {
      streamState.stopped = true;
      suppressNonFinalFallback = true;
      params.warn?.(`telegram native answer draft failed: ${formatErrorMessage(err)}`);
      return false;
    }
  };

  const controls = createFinalizableDraftStreamControlsForState({
    throttleMs,
    state: streamState,
    sendOrEditStreamMessage,
  });
  const { loop, update } = controls;

  const stop = async () => {
    await controls.stop();
  };

  const clear = async () => {
    await controls.stopForClear();
  };

  const discard = async () => {
    await controls.stopForClear();
  };

  const forceNewMessage = () => {
    streamState.stopped = false;
    streamState.final = false;
    draftId = allocateTelegramDraftId();
    streamVisibleSinceMs = undefined;
    lastSentText = "";
    lastSentParseMode = undefined;
    lastDeliveredText = "";
    previewRevision = 0;
    suppressNonFinalFallback = false;
    loop.resetPending();
    loop.resetThrottleWindow();
  };

  const materialize = async (): Promise<number | undefined> => {
    await stop();
    return undefined;
  };

  params.log?.(`telegram native answer draft ready (throttleMs=${throttleMs}, draftId=${draftId})`);

  return {
    update,
    flush: loop.flush,
    messageId: () => undefined,
    visibleSinceMs: () => streamVisibleSinceMs,
    previewRevision: () => previewRevision,
    lastDeliveredText: () => lastDeliveredText,
    clear,
    stop: async () => {
      await stop();
    },
    discard,
    materialize,
    forceNewMessage,
    sendMayHaveLanded: () => false,
    isActive: () => !streamState.stopped && !streamState.final && previewRevision > 0,
    suppressNonFinalFallback: () => suppressNonFinalFallback,
  };
}
