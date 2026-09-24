// Telegram plugin module implements request timeouts behavior.
import { AsyncLocalStorage } from "node:async_hooks";
import type { Transformer } from "grammy";
import {
  finiteSecondsToTimerSafeMilliseconds,
  MAX_TIMER_TIMEOUT_MS,
} from "openclaw/plugin-sdk/number-runtime";

export const TELEGRAM_GET_UPDATES_REQUEST_TIMEOUT_MS = 45_000;
const TELEGRAM_DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
const TELEGRAM_DEFAULT_LONG_POLL_TIMEOUT_SECONDS = 30;
const TELEGRAM_LONG_POLL_ABORT_MARGIN_SECONDS = 5;
// The Bot API answers an upload with the sent Message, so the response cannot
// arrive before the file has reached Telegram. Uploads keep their table guard
// while the file fits inside it; larger files get the time to move them at an
// assumed 2 MiB/s plus a response margin, capped so a bad size cannot pin a lane.
const TELEGRAM_UPLOAD_ASSUMED_BYTES_PER_SECOND = 2 * 1024 * 1024;
const TELEGRAM_UPLOAD_RESPONSE_MARGIN_MS = 15_000;
const TELEGRAM_UPLOAD_MAX_TIMEOUT_MS = 30 * 60_000;
// grammY races every API call against one client-wide timer (500 s unless
// client.timeoutSeconds is set) and has no per-call override. Clients that
// install createTelegramClientFetch set it past the longest guard here, so the
// per-method guard decides: 45 s for getUpdates, up to 30 minutes for uploads.
export const TELEGRAM_CLIENT_TIMEOUT_BACKSTOP_SECONDS = TELEGRAM_UPLOAD_MAX_TIMEOUT_MS / 1000 + 60;

const TELEGRAM_REQUEST_TIMEOUTS_MS = {
  // Bound startup/control-plane calls so the gateway cannot report Telegram as
  // healthy while provider startup is still hung on Bot API setup.
  deletemycommands: 15_000,
  deletewebhook: 15_000,
  deletemessage: 15_000,
  editforumtopic: 15_000,
  editmessagetext: 15_000,
  getchat: 15_000,
  getfile: 30_000,
  getme: 15_000,
  getupdates: TELEGRAM_GET_UPDATES_REQUEST_TIMEOUT_MS,
  pinchatmessage: 15_000,
  sendanimation: 30_000,
  sendaudio: 30_000,
  sendchataction: TELEGRAM_DEFAULT_REQUEST_TIMEOUT_MS,
  senddocument: 30_000,
  sendmessage: TELEGRAM_DEFAULT_REQUEST_TIMEOUT_MS,
  sendmessagedraft: TELEGRAM_DEFAULT_REQUEST_TIMEOUT_MS,
  sendphoto: 30_000,
  sendvideo: 30_000,
  sendvoice: 30_000,
  setmessagereaction: 10_000,
  setmycommands: 15_000,
  setwebhook: 15_000,
} as const;

function resolveConfiguredTelegramRequestTimeoutMs(timeoutSeconds: unknown): number | undefined {
  if (typeof timeoutSeconds !== "number" || !Number.isFinite(timeoutSeconds)) {
    return undefined;
  }
  return (
    finiteSecondsToTimerSafeMilliseconds(Math.max(1, timeoutSeconds), {
      floorSeconds: true,
    }) ?? MAX_TIMER_TIMEOUT_MS
  );
}

function resolveTelegramUploadTimeoutMs(uploadBytes: number | undefined): number {
  if (typeof uploadBytes !== "number" || !Number.isFinite(uploadBytes) || uploadBytes <= 0) {
    return 0;
  }
  const transferMs = Math.ceil(uploadBytes / TELEGRAM_UPLOAD_ASSUMED_BYTES_PER_SECOND) * 1000;
  return Math.min(transferMs + TELEGRAM_UPLOAD_RESPONSE_MARGIN_MS, TELEGRAM_UPLOAD_MAX_TIMEOUT_MS);
}

export function resolveTelegramRequestTimeoutMs(
  method: string | null,
  timeoutSeconds?: unknown,
  uploadBytes?: number,
): number | undefined {
  if (!method) {
    return undefined;
  }
  if (method === "getupdates") {
    return TELEGRAM_REQUEST_TIMEOUTS_MS.getupdates;
  }
  const baseTimeoutMs =
    TELEGRAM_REQUEST_TIMEOUTS_MS[method as keyof typeof TELEGRAM_REQUEST_TIMEOUTS_MS] ??
    TELEGRAM_DEFAULT_REQUEST_TIMEOUT_MS;
  return Math.max(
    baseTimeoutMs,
    resolveTelegramUploadTimeoutMs(uploadBytes),
    resolveConfiguredTelegramRequestTimeoutMs(timeoutSeconds) ?? 0,
  );
}

const telegramUploadBytesByFile = new WeakMap<object, number>();
const telegramUploadBytesStore = new AsyncLocalStorage<number>();

/** Remember how many bytes an outgoing InputFile carries. */
export function recordTelegramUploadBytes<T extends object>(file: T, uploadBytes: number): T {
  telegramUploadBytesByFile.set(file, uploadBytes);
  return file;
}

function readRecordedUploadBytes(value: unknown): number {
  return (typeof value === "object" && value !== null && telegramUploadBytesByFile.get(value)) || 0;
}

function readTelegramPayloadUploadBytes(payload: unknown): number {
  let uploadBytes = 0;
  for (const value of Object.values(payload ?? {})) {
    if (Array.isArray(value)) {
      // sendMediaGroup nests each file under media[].media.
      for (const item of value) {
        if (typeof item === "object" && item !== null && "media" in item) {
          uploadBytes += readRecordedUploadBytes(item.media);
        }
      }
    } else {
      uploadBytes += readRecordedUploadBytes(value);
    }
  }
  return uploadBytes;
}

/**
 * Carry a request's upload size to the client fetch guard. Install inside the
 * account throttler: its queue runs requests from its own drain loop, so a size
 * taken from the caller's async context would be lost or cross-attributed.
 */
export const telegramUploadTimeoutTransformer: Transformer = (prev, method, payload, signal) => {
  const uploadBytes = readTelegramPayloadUploadBytes(payload);
  return uploadBytes > 0
    ? telegramUploadBytesStore.run(uploadBytes, () => prev(method, payload, signal))
    : prev(method, payload, signal);
};

export function getTelegramUploadBytes(): number | undefined {
  return telegramUploadBytesStore.getStore();
}

export function resolveTelegramLongPollTimeoutSeconds(timeoutSeconds: unknown): number {
  const maxLongPollTimeoutSeconds = Math.max(
    1,
    Math.floor(TELEGRAM_GET_UPDATES_REQUEST_TIMEOUT_MS / 1000) -
      TELEGRAM_LONG_POLL_ABORT_MARGIN_SECONDS,
  );
  const configuredTimeoutSeconds =
    typeof timeoutSeconds === "number" && Number.isFinite(timeoutSeconds)
      ? Math.max(1, Math.floor(timeoutSeconds))
      : TELEGRAM_DEFAULT_LONG_POLL_TIMEOUT_SECONDS;
  return Math.min(configuredTimeoutSeconds, maxLongPollTimeoutSeconds);
}

export function resolveTelegramStartupProbeTimeoutMs(timeoutSeconds: unknown): number {
  const getMeTimeoutMs = resolveTelegramRequestTimeoutMs("getme") ?? 15_000;
  if (typeof timeoutSeconds !== "number" || !Number.isFinite(timeoutSeconds)) {
    return getMeTimeoutMs;
  }
  const configuredTimeoutMs = resolveConfiguredTelegramRequestTimeoutMs(timeoutSeconds) ?? 1_000;
  return Math.max(getMeTimeoutMs, configuredTimeoutMs);
}
