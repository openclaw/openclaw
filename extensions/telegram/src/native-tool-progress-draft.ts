import type { Bot } from "grammy";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { buildTelegramThreadParams, type TelegramThreadSpec } from "./bot/helpers.js";

const TELEGRAM_NATIVE_DRAFT_MAX_CHARS = 4096;
const TELEGRAM_NATIVE_DRAFT_IDLE_UPDATE_DELAY_MS = 900;
const TELEGRAM_NATIVE_DRAFT_MAX_UPDATE_INTERVAL_MS = 2_500;
const TELEGRAM_NATIVE_DRAFT_THINKING_KEEPALIVE_MS = 20_000;
const TELEGRAM_NATIVE_DRAFT_TYPING_KEEPALIVE_MS = 4_000;
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

type TelegramSendChatAction = (
  chatId: Parameters<Bot["api"]["sendChatAction"]>[0],
  action: Parameters<Bot["api"]["sendChatAction"]>[1],
  params?: Parameters<Bot["api"]["sendChatAction"]>[2],
  signal?: AbortSignal,
) => Promise<unknown>;

export type NativeTelegramToolProgressDraft = {
  update: (text: string) => Promise<boolean>;
  freeze: () => void;
  stop: () => void;
};

export type NativeTelegramToolProgressDraftMode = "text" | "smooth-thinking" | "status-with-typing";

function resolveSendMessageDraftApi(api: Bot["api"]): TelegramSendMessageDraft | undefined {
  const sendMessageDraft = (api as Bot["api"] & { sendMessageDraft?: TelegramSendMessageDraft })
    .sendMessageDraft;
  if (typeof sendMessageDraft !== "function") {
    return undefined;
  }
  return sendMessageDraft.bind(api as object);
}

function resolveSendChatActionApi(api: Bot["api"]): TelegramSendChatAction | undefined {
  const sendChatAction = (api as Bot["api"] & { sendChatAction?: TelegramSendChatAction })
    .sendChatAction;
  if (typeof sendChatAction !== "function") {
    return undefined;
  }
  return sendChatAction.bind(api as object);
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
  mode?: NativeTelegramToolProgressDraftMode;
  idleUpdateDelayMs?: number;
  maxUpdateIntervalMs?: number;
  minUpdateIntervalMs?: number;
  thinkingKeepAliveMs?: number;
  typingKeepAliveMs?: number;
}): NativeTelegramToolProgressDraft | undefined {
  const sendMessageDraft = resolveSendMessageDraftApi(params.api);
  if (!sendMessageDraft) {
    return undefined;
  }
  const sendChatAction = resolveSendChatActionApi(params.api);

  const draftId = allocateTelegramDraftId();
  const threadParams = buildTelegramThreadParams(params.thread) ?? {};
  const mode = params.mode ?? "text";
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
    params.maxUpdateIntervalMs ??
    params.minUpdateIntervalMs ??
    TELEGRAM_NATIVE_DRAFT_MAX_UPDATE_INTERVAL_MS;
  const maxUpdateIntervalMs = Math.max(
    0,
    Math.trunc(
      Number.isFinite(rawMaxUpdateIntervalMs)
        ? rawMaxUpdateIntervalMs
        : TELEGRAM_NATIVE_DRAFT_MAX_UPDATE_INTERVAL_MS,
    ),
  );
  const rawThinkingKeepAliveMs =
    params.thinkingKeepAliveMs ?? TELEGRAM_NATIVE_DRAFT_THINKING_KEEPALIVE_MS;
  const thinkingKeepAliveMs = Math.max(
    0,
    Math.trunc(
      Number.isFinite(rawThinkingKeepAliveMs)
        ? rawThinkingKeepAliveMs
        : TELEGRAM_NATIVE_DRAFT_THINKING_KEEPALIVE_MS,
    ),
  );
  const rawTypingKeepAliveMs =
    params.typingKeepAliveMs ?? TELEGRAM_NATIVE_DRAFT_TYPING_KEEPALIVE_MS;
  const typingKeepAliveMs = Math.max(
    0,
    Math.trunc(
      Number.isFinite(rawTypingKeepAliveMs)
        ? rawTypingKeepAliveMs
        : TELEGRAM_NATIVE_DRAFT_TYPING_KEEPALIVE_MS,
    ),
  );
  let stopped = false;
  let frozen = false;
  let hasSentDraft = false;
  let typingInFlight = false;
  let lastSentText: string | undefined;
  let lastSendStartedAt = 0;
  let inFlight: Promise<boolean> | undefined;
  let inFlightText: string | undefined;
  let inFlightAbortController: AbortController | undefined;
  let queuedText: string | undefined;
  let firstQueuedAt = 0;
  let idleQueuedTimer: ReturnType<typeof setTimeout> | undefined;
  let maxQueuedTimer: ReturnType<typeof setTimeout> | undefined;
  let thinkingKeepAliveTimer: ReturnType<typeof setTimeout> | undefined;
  let typingKeepAliveTimer: ReturnType<typeof setTimeout> | undefined;

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

  const clearThinkingKeepAliveTimer = () => {
    if (thinkingKeepAliveTimer !== undefined) {
      clearTimeout(thinkingKeepAliveTimer);
      thinkingKeepAliveTimer = undefined;
    }
  };

  const clearTypingKeepAliveTimer = () => {
    if (typingKeepAliveTimer !== undefined) {
      clearTimeout(typingKeepAliveTimer);
      typingKeepAliveTimer = undefined;
    }
  };

  const sendTypingAction = () => {
    if (!sendChatAction || stopped || frozen || typingInFlight) {
      return;
    }
    typingInFlight = true;
    void sendChatAction(
      params.chatId,
      "typing",
      Object.keys(threadParams).length > 0
        ? (threadParams as Parameters<Bot["api"]["sendChatAction"]>[2])
        : undefined,
    )
      .catch((err) => {
        params.log?.(`telegram native typing indicator failed: ${formatErrorMessage(err)}`);
      })
      .finally(() => {
        typingInFlight = false;
      });
  };

  const scheduleTypingKeepAlive = () => {
    if (mode !== "status-with-typing" || stopped || frozen || typingKeepAliveMs <= 0) {
      return;
    }
    clearTypingKeepAliveTimer();
    typingKeepAliveTimer = setTimeout(() => {
      typingKeepAliveTimer = undefined;
      if (stopped || frozen) {
        return;
      }
      sendTypingAction();
      scheduleTypingKeepAlive();
    }, typingKeepAliveMs);
  };

  const startTypingKeepAlive = () => {
    if (mode !== "status-with-typing") {
      return;
    }
    sendTypingAction();
    scheduleTypingKeepAlive();
  };

  const scheduleThinkingKeepAlive = () => {
    if (mode !== "smooth-thinking" || stopped || frozen || thinkingKeepAliveMs <= 0) {
      return;
    }
    clearThinkingKeepAliveTimer();
    thinkingKeepAliveTimer = setTimeout(() => {
      thinkingKeepAliveTimer = undefined;
      if (stopped || frozen) {
        return;
      }
      if (inFlight) {
        scheduleThinkingKeepAlive();
        return;
      }
      sendNow("", { force: true });
    }, thinkingKeepAliveMs);
  };

  const sendNow = (text: string, options?: { force?: boolean }): void => {
    const abortController = new AbortController();
    if (stopped || frozen) {
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
          hasSentDraft = true;
          lastSentText = text;
          if (mode === "smooth-thinking" && options?.force) {
            scheduleThinkingKeepAlive();
          }
          startTypingKeepAlive();
        }
        return true;
      })
      .catch((err) => {
        if ((stopped || frozen) && abortController.signal.aborted) {
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
        if (!frozen) {
          scheduleQueuedSendAfterInFlight();
        }
      });
  };

  const flushQueuedSend = (): boolean => {
    clearQueuedTimers();
    if (stopped || frozen || inFlight || !queuedText) {
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
    if (stopped || frozen || inFlight || !queuedText) {
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
    if (stopped || frozen || !queuedText) {
      return;
    }
    const elapsedMs = lastSendStartedAt > 0 ? Date.now() - lastSendStartedAt : maxUpdateIntervalMs;
    if (elapsedMs >= maxUpdateIntervalMs) {
      flushQueuedSend();
      return;
    }
    scheduleQueuedSend();
  }

  const freeze = () => {
    frozen = true;
    queuedText = undefined;
    firstQueuedAt = 0;
    clearQueuedTimers();
    clearThinkingKeepAliveTimer();
    clearTypingKeepAliveTimer();
    inFlightAbortController?.abort();
    inFlightAbortController = undefined;
  };

  return {
    update: async (text: string): Promise<boolean> => {
      if (stopped || frozen) {
        return false;
      }
      if (mode === "smooth-thinking") {
        if (!hasSentDraft && !inFlight) {
          sendNow("", { force: true });
        }
        return true;
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
      if (!hasSentDraft && !inFlight) {
        sendNow(normalizedText);
        return true;
      }
      queueSend(normalizedText);
      return true;
    },
    freeze,
    stop: () => {
      stopped = true;
      freeze();
    },
  };
}
