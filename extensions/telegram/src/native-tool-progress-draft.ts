import type { Bot } from "grammy";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { buildTelegramThreadParams, type TelegramThreadSpec } from "./bot/helpers.js";

const TELEGRAM_NATIVE_DRAFT_MAX_CHARS = 4096;
const TELEGRAM_NATIVE_DRAFT_IDLE_UPDATE_DELAY_MS = 1_200;
const TELEGRAM_NATIVE_DRAFT_MAX_UPDATE_INTERVAL_MS = 5_000;
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
  idleUpdateDelayMs?: number;
  minUpdateIntervalMs?: number;
}): NativeTelegramToolProgressDraft | undefined {
  const sendMessageDraft = resolveSendMessageDraftApi(params.api);
  if (!sendMessageDraft) {
    return undefined;
  }

  const draftId = allocateTelegramDraftId();
  const threadParams = buildTelegramThreadParams(params.thread) ?? {};
  const rawIdleUpdateDelayMs =
    params.idleUpdateDelayMs ?? TELEGRAM_NATIVE_DRAFT_IDLE_UPDATE_DELAY_MS;
  const idleUpdateDelayMs = Math.max(
    0,
    Math.trunc(
      Number.isFinite(rawIdleUpdateDelayMs)
        ? rawIdleUpdateDelayMs
        : TELEGRAM_NATIVE_DRAFT_IDLE_UPDATE_DELAY_MS,
    ),
  );
  const rawMaxUpdateIntervalMs =
    params.minUpdateIntervalMs ?? TELEGRAM_NATIVE_DRAFT_MAX_UPDATE_INTERVAL_MS;
  const maxUpdateIntervalMs = Math.max(
    0,
    Math.trunc(
      Number.isFinite(rawMaxUpdateIntervalMs)
        ? rawMaxUpdateIntervalMs
        : TELEGRAM_NATIVE_DRAFT_MAX_UPDATE_INTERVAL_MS,
    ),
  );
  let stopped = false;
  let lastSentText: string | undefined;
  let lastSendStartedAt = 0;
  let inFlight: Promise<boolean> | undefined;
  let inFlightText: string | undefined;
  let inFlightAbortController: AbortController | undefined;
  let queuedText: string | undefined;
  let firstQueuedAt = 0;
  let idleQueuedTimer: ReturnType<typeof setTimeout> | undefined;
  let maxQueuedTimer: ReturnType<typeof setTimeout> | undefined;

  const clearQueuedTimers = () => {
    if (idleQueuedTimer !== undefined) {
      clearTimeout(idleQueuedTimer);
      idleQueuedTimer = undefined;
    }
    if (maxQueuedTimer !== undefined) {
      clearTimeout(maxQueuedTimer);
      maxQueuedTimer = undefined;
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
        firstQueuedAt = 0;
        clearQueuedTimers();
        params.log?.(`telegram native tool-progress draft disabled: ${formatErrorMessage(err)}`);
        return false;
      })
      .finally(() => {
        if (inFlightAbortController === abortController) {
          inFlightAbortController = undefined;
        }
        inFlight = undefined;
        inFlightText = undefined;
        scheduleQueuedSendAfterInFlight();
      });
  };

  const flushQueuedSend = (): boolean => {
    clearQueuedTimers();
    if (stopped || inFlight || !queuedText) {
      return false;
    }
    const nextText = queuedText;
    queuedText = undefined;
    firstQueuedAt = 0;
    if (nextText === lastSentText) {
      return true;
    }
    sendNow(nextText);
    return true;
  };

  function scheduleQueuedSend(options?: { resetIdle?: boolean }) {
    if (stopped || inFlight || !queuedText) {
      return;
    }
    const now = Date.now();
    if (firstQueuedAt <= 0) {
      firstQueuedAt = now;
    }
    if (options?.resetIdle && idleQueuedTimer !== undefined) {
      clearTimeout(idleQueuedTimer);
      idleQueuedTimer = undefined;
    }
    if (idleQueuedTimer === undefined) {
      idleQueuedTimer = setTimeout(() => {
        idleQueuedTimer = undefined;
        flushQueuedSend();
      }, idleUpdateDelayMs);
    }
    if (maxQueuedTimer === undefined) {
      const elapsedMs = now - firstQueuedAt;
      const delayMs = Math.max(0, maxUpdateIntervalMs - elapsedMs);
      maxQueuedTimer = setTimeout(() => {
        maxQueuedTimer = undefined;
        flushQueuedSend();
      }, delayMs);
    }
  }

  function queueSend(text: string) {
    queuedText = text;
    if (firstQueuedAt <= 0) {
      firstQueuedAt = Date.now();
    }
    scheduleQueuedSend({ resetIdle: true });
  }

  function scheduleQueuedSendAfterInFlight() {
    if (stopped || !queuedText) {
      return;
    }
    const elapsedMs = lastSendStartedAt > 0 ? Date.now() - lastSendStartedAt : maxUpdateIntervalMs;
    if (elapsedMs >= maxUpdateIntervalMs) {
      flushQueuedSend();
      return;
    }
    scheduleQueuedSend();
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
      queueSend(normalizedText);
      return true;
    },
    stop: () => {
      stopped = true;
      queuedText = undefined;
      firstQueuedAt = 0;
      clearQueuedTimers();
      inFlightAbortController?.abort();
      inFlightAbortController = undefined;
    },
  };
}
