import type { ChannelIngressQueue } from "openclaw/plugin-sdk/channel-outbound";
import { computeBackoff, type BackoffPolicy } from "openclaw/plugin-sdk/runtime-env";
import { getTelegramRuntime } from "./runtime.js";
import { normalizeTelegramStateAccountId } from "./state-account-id.js";
import type { TelegramSpooledUpdatePayload } from "./telegram-ingress-spool.payload.js";
const TELEGRAM_SPOOLED_COMPLETION_RETRY_POLICY: BackoffPolicy = {
  initialMs: 250,
  maxMs: 5_000,
  factor: 2,
  jitter: 0.2,
};

function isValidUpdateId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function resolveTelegramUpdateId(update: unknown): number | null {
  if (!update || typeof update !== "object") {
    return null;
  }
  const value = (update as { update_id?: unknown }).update_id;
  return isValidUpdateId(value) ? value : null;
}

export function telegramQueueEventId(updateId: number): string {
  return String(updateId).padStart(16, "0");
}

export function openTelegramIngressQueue(params: {
  accountId?: string;
  stateDir?: string;
}): ChannelIngressQueue<TelegramSpooledUpdatePayload> {
  return getTelegramRuntime().state.openChannelIngressQueue<TelegramSpooledUpdatePayload>({
    accountId: normalizeTelegramStateAccountId(params.accountId),
    stateDir: params.stateDir,
  });
}

/** Backoff for irrevocable-adoption completion retries (bot-message only). */
export function resolveSpooledUpdatePersistenceRetryDelayMs(attempt: number): number {
  return computeBackoff(TELEGRAM_SPOOLED_COMPLETION_RETRY_POLICY, attempt);
}
