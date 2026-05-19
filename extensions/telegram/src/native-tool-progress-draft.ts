import type { Bot } from "grammy";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { buildTelegramThreadParams, type TelegramThreadSpec } from "./bot/helpers.js";

const TELEGRAM_NATIVE_DRAFT_MAX_CHARS = 4096;
const TELEGRAM_NATIVE_DRAFT_MIN_UPDATE_INTERVAL_MS = 750;
const TELEGRAM_DRAFT_ID_STATE_KEY = Symbol.for("openclaw.telegramNativeDraftIdState");

type TelegramSendMessageDraft = (
  chatId: Parameters<Bot["api"]["sendMessage"]>[0],
  draftId: number,
  text: string,
  params?: {
    message_thread_id?: number;
    parse_mode?: "HTML";
    entities?: unknown[];
  },
  signal?: AbortSignal,
) => Promise<unknown>;

export type NativeTelegramToolProgressDraft = {
  update: (text: string) => Promise<boolean>;
  stop: () => void;
};

function resolveSendMessageDraftApi(api: Bot["api"]): TelegramSendMessageDraft | undefined {
  const sendMessageDraft = (api as Bot["api"] & { sendMessageDraft?: TelegramSendMessageDraft })
    .sendMessageDraft;
  if (typeof sendMessageDraft !== "function") {
    return undefined;
  }
  return sendMessageDraft.bind(api as object);
}

function allocateTelegramDraftId(): number {
  const globalStore = globalThis as Record<PropertyKey, unknown>;
  const state =
    (globalStore[TELEGRAM_DRAFT_ID_STATE_KEY] as { nextDraftId?: number } | undefined) ?? {};
  const nextDraftId = Math.trunc(state.nextDraftId ?? 0) + 1;
  state.nextDraftId = nextDraftId;
  globalStore[TELEGRAM_DRAFT_ID_STATE_KEY] = state;
  return nextDraftId;
}

function normalizeDraftText(text: string): string {
  const trimmed = text.trimEnd();
  return trimmed.length > TELEGRAM_NATIVE_DRAFT_MAX_CHARS
    ? trimmed.slice(0, TELEGRAM_NATIVE_DRAFT_MAX_CHARS)
    : trimmed;
}

export function createNativeTelegramToolProgressDraft(params: {
  api: Bot["api"];
  chatId: Parameters<Bot["api"]["sendMessage"]>[0];
  thread?: TelegramThreadSpec | null;
  log?: (message: string) => void;
  minUpdateIntervalMs?: number;
}): NativeTelegramToolProgressDraft | undefined {
  const sendMessageDraft = resolveSendMessageDraftApi(params.api);
  if (!sendMessageDraft) {
    return undefined;
  }

  const draftId = allocateTelegramDraftId();
  const threadParams = buildTelegramThreadParams(params.thread) ?? {};
  const rawMinUpdateIntervalMs =
    params.minUpdateIntervalMs ?? TELEGRAM_NATIVE_DRAFT_MIN_UPDATE_INTERVAL_MS;
  const minUpdateIntervalMs = Math.max(
    0,
    Math.trunc(
      Number.isFinite(rawMinUpdateIntervalMs)
        ? rawMinUpdateIntervalMs
        : TELEGRAM_NATIVE_DRAFT_MIN_UPDATE_INTERVAL_MS,
    ),
  );
  let stopped = false;
  let lastSentText: string | undefined;
  let lastSendStartedAt = 0;
  let inFlight: Promise<boolean> | undefined;
  let inFlightText: string | undefined;
  let inFlightAbortController: AbortController | undefined;
  let queuedText: string | undefined;
  let queuedTimer: ReturnType<typeof setTimeout> | undefined;

  const clearQueuedTimer = () => {
    if (queuedTimer !== undefined) {
      clearTimeout(queuedTimer);
      queuedTimer = undefined;
    }
  };

  const sendNow = (text: string): void => {
    const abortController = new AbortController();
    if (stopped) {
      return;
    }
    inFlightText = text;
    inFlightAbortController = abortController;
    lastSendStartedAt = Date.now();
    inFlight = sendMessageDraft(
      params.chatId,
      draftId,
      text,
      Object.keys(threadParams).length > 0 ? threadParams : undefined,
      abortController.signal,
    )
      .then(() => {
        if (!stopped) {
          lastSentText = text;
        }
        return true;
      })
      .catch((err) => {
        if (stopped && abortController.signal.aborted) {
          return false;
        }
        stopped = true;
        queuedText = undefined;
        clearQueuedTimer();
        params.log?.(`telegram native tool-progress draft disabled: ${formatErrorMessage(err)}`);
        return false;
      })
      .finally(() => {
        if (inFlightAbortController === abortController) {
          inFlightAbortController = undefined;
        }
        inFlight = undefined;
        inFlightText = undefined;
        scheduleQueuedSend();
      });
  };

  const flushQueuedSend = (): boolean => {
    clearQueuedTimer();
    if (stopped || inFlight || !queuedText) {
      return false;
    }
    const nextText = queuedText;
    queuedText = undefined;
    if (nextText === lastSentText) {
      return true;
    }
    sendNow(nextText);
    return true;
  };

  function scheduleQueuedSend() {
    if (stopped || inFlight || queuedTimer !== undefined || !queuedText) {
      return;
    }
    const elapsedMs = lastSendStartedAt > 0 ? Date.now() - lastSendStartedAt : minUpdateIntervalMs;
    const delayMs = Math.max(0, minUpdateIntervalMs - elapsedMs);
    queuedTimer = setTimeout(() => {
      queuedTimer = undefined;
      flushQueuedSend();
    }, delayMs);
  }

  return {
    update: async (text: string): Promise<boolean> => {
      if (stopped) {
        return false;
      }
      const normalizedText = normalizeDraftText(text);
      if (!normalizedText) {
        return false;
      }
      if (normalizedText === lastSentText) {
        return true;
      }
      if (normalizedText === inFlightText || normalizedText === queuedText) {
        return true;
      }
      if (!lastSentText && !inFlight) {
        sendNow(normalizedText);
        return true;
      }
      queuedText = normalizedText;
      scheduleQueuedSend();
      return true;
    },
    stop: () => {
      stopped = true;
      queuedText = undefined;
      clearQueuedTimer();
      inFlightAbortController?.abort();
      inFlightAbortController = undefined;
    },
  };
}
