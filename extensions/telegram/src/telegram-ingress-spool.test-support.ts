// Test-only queue fixtures and inspection over the production ingress queue.
import type { ChannelIngressQueueRecord } from "openclaw/plugin-sdk/channel-outbound";
import type { TelegramBotInfo } from "./bot-info.js";
import { getTelegramSequentialKey } from "./sequential-key.js";
import {
  openTelegramIngressQueue,
  resolveTelegramUpdateId,
  telegramQueueEventId,
} from "./telegram-ingress-spool.js";
import {
  TELEGRAM_SPOOLED_UPDATE_PAYLOAD_VERSION,
  type TelegramSpooledUpdatePayload,
} from "./telegram-ingress-spool.payload.js";

type TelegramSpooledUpdate = {
  updateId: number;
  update: unknown;
  receivedAt: number;
  attempts?: number;
  lastAttemptAt?: number;
  lastError?: string;
};

export function telegramSpooledUpdateLaneKey(update: unknown, botInfo?: TelegramBotInfo): string {
  return getTelegramSequentialKey({
    update: update as Parameters<typeof getTelegramSequentialKey>[0]["update"],
    ...(botInfo ? { me: botInfo } : {}),
  });
}

export async function writeTelegramSpooledUpdate(params: {
  spoolDir: string;
  update: unknown;
  laneKey?: string;
  now?: number;
}): Promise<number> {
  const updateId = resolveTelegramUpdateId(params.update);
  if (updateId === null) {
    throw new Error("Telegram update missing numeric update_id.");
  }
  const receivedAt = params.now ?? Date.now();
  await openTelegramIngressQueue(params.spoolDir).enqueue(
    telegramQueueEventId(updateId),
    {
      version: TELEGRAM_SPOOLED_UPDATE_PAYLOAD_VERSION,
      updateId,
      receivedAt,
      update: params.update,
    },
    {
      receivedAt,
      laneKey: params.laneKey ?? telegramSpooledUpdateLaneKey(params.update),
    },
  );
  return updateId;
}

function isValidUpdateId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function parsePendingRecord(
  record: ChannelIngressQueueRecord<TelegramSpooledUpdatePayload>,
): TelegramSpooledUpdate | null {
  const payload = record.payload;
  if (
    payload.version !== TELEGRAM_SPOOLED_UPDATE_PAYLOAD_VERSION ||
    !isValidUpdateId(payload.updateId)
  ) {
    return null;
  }
  return {
    updateId: payload.updateId,
    update: payload.update,
    receivedAt: payload.receivedAt,
    attempts: record.attempts,
    ...(record.lastAttemptAt === undefined ? {} : { lastAttemptAt: record.lastAttemptAt }),
    ...(record.lastError === undefined ? {} : { lastError: record.lastError }),
  };
}

export async function listTelegramSpooledUpdates(params: {
  spoolDir: string;
  limit?: number | "all";
}): Promise<TelegramSpooledUpdate[]> {
  const records = await openTelegramIngressQueue(params.spoolDir).listPending({
    limit: params.limit ?? 100,
    orderBy: "id",
  });
  return records
    .flatMap((record) => {
      const update = parsePendingRecord(record);
      return update ? [update] : [];
    })
    .toSorted((a, b) => a.updateId - b.updateId);
}

export async function listTelegramSpooledUpdateClaims(params: {
  spoolDir: string;
}): Promise<TelegramSpooledUpdate[]> {
  const claims = await openTelegramIngressQueue(params.spoolDir).listClaims();
  return claims
    .flatMap((claim) => {
      const update = parsePendingRecord(claim);
      return update ? [update] : [];
    })
    .toSorted((a, b) => a.updateId - b.updateId);
}
