// Feishu plugin module implements outbound send rate limiting.
import { resolveTimerTimeoutMs } from "openclaw/plugin-sdk/number-runtime";
import type { FeishuConfig } from "./types.js";

type FeishuSendRateLimitOptions = {
  accountId: string;
  receiveId: string;
  receiveIdType: string;
  minIntervalMs: number;
};

const sendRateLimitQueues = new Map<string, Promise<unknown>>();
const sendRateLimitLastSentAt = new Map<string, number>();
const sendRateLimitCleanupTimers = new Map<string, ReturnType<typeof setTimeout>>();

export function resolveFeishuSendRateLimitMinIntervalMs(config: FeishuConfig | undefined): number {
  const raw = config?.sendRateLimit?.minIntervalMs;
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) {
    return 0;
  }
  return resolveTimerTimeoutMs(raw, 0, 0);
}

export function buildFeishuSendRateLimitKey(params: {
  accountId: string;
  receiveId: string;
  receiveIdType: string;
}): string {
  return JSON.stringify([params.accountId, params.receiveIdType, params.receiveId]);
}

export async function runWithFeishuSendRateLimit<T>(
  options: FeishuSendRateLimitOptions,
  task: () => Promise<T>,
): Promise<T> {
  if (options.minIntervalMs <= 0) {
    return task();
  }

  const key = buildFeishuSendRateLimitKey(options);
  const cleanupTimer = sendRateLimitCleanupTimers.get(key);
  if (cleanupTimer) {
    clearTimeout(cleanupTimer);
    sendRateLimitCleanupTimers.delete(key);
  }

  const previous = sendRateLimitQueues.get(key) ?? Promise.resolve();
  const run = () => reserveSendSlot(key, options.minIntervalMs).then(task);
  const next = previous.then(run, run);
  sendRateLimitQueues.set(key, next);
  next.then(
    () => cleanupQueue(key, next, options.minIntervalMs),
    () => cleanupQueue(key, next, options.minIntervalMs),
  );
  return next;
}

async function reserveSendSlot(key: string, minIntervalMs: number): Promise<void> {
  const lastSentAt = sendRateLimitLastSentAt.get(key);
  if (lastSentAt !== undefined) {
    const waitMs = lastSentAt + minIntervalMs - Date.now();
    if (waitMs > 0) {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, waitMs);
      });
    }
  }
  sendRateLimitLastSentAt.set(key, Date.now());
}

function cleanupQueue(key: string, promise: Promise<unknown>, minIntervalMs: number): void {
  if (sendRateLimitQueues.get(key) !== promise) {
    return;
  }
  sendRateLimitQueues.delete(key);
  const lastSentAt = sendRateLimitLastSentAt.get(key);
  if (lastSentAt === undefined) {
    return;
  }
  const staleInMs = lastSentAt + minIntervalMs - Date.now();
  if (staleInMs <= 0) {
    sendRateLimitLastSentAt.delete(key);
    return;
  }
  const timer = setTimeout(() => {
    if (!sendRateLimitQueues.has(key) && sendRateLimitLastSentAt.get(key) === lastSentAt) {
      sendRateLimitLastSentAt.delete(key);
    }
    sendRateLimitCleanupTimers.delete(key);
  }, staleInMs);
  if (typeof timer === "object" && "unref" in timer && typeof timer.unref === "function") {
    timer.unref();
  }
  sendRateLimitCleanupTimers.set(key, timer);
}
