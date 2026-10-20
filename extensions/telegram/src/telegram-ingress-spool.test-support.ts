import type { ChannelIngressQueueRecord } from "openclaw/plugin-sdk/channel-outbound";
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

type QueueScope = { stateDir: string; accountId?: string };

export function telegramSpooledUpdateLaneKey(update: unknown): string {
  return getTelegramSequentialKey({
    update: update as Parameters<typeof getTelegramSequentialKey>[0]["update"],
  });
}

export async function writeTelegramSpooledUpdate(
  params: QueueScope & {
    update: unknown;
    laneKey?: string;
    now?: number;
  },
): Promise<number> {
  const updateId = resolveTelegramUpdateId(params.update);
  if (updateId === null) {
    throw new Error("Telegram update missing numeric update_id.");
  }
  const receivedAt = params.now ?? Date.now();
  await openTelegramIngressQueue(params).enqueue(
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

function parseRecords(records: ChannelIngressQueueRecord<TelegramSpooledUpdatePayload>[]) {
  return records
    .filter(
      ({ payload }) =>
        payload.version === TELEGRAM_SPOOLED_UPDATE_PAYLOAD_VERSION &&
        resolveTelegramUpdateId({ update_id: payload.updateId }) !== null,
    )
    .map(({ payload, attempts, lastAttemptAt, lastError }) =>
      Object.assign(
        {
          updateId: payload.updateId,
          update: payload.update,
          receivedAt: payload.receivedAt,
          attempts,
        },
        lastAttemptAt === undefined ? {} : { lastAttemptAt },
        lastError === undefined ? {} : { lastError },
      ),
    )
    .toSorted((a, b) => a.updateId - b.updateId);
}

export async function listTelegramSpooledUpdates(
  params: QueueScope & {
    limit?: number | "all";
  },
) {
  const records = await openTelegramIngressQueue(params).listPending({
    limit: params.limit ?? 100,
    orderBy: "id",
  });
  return parseRecords(records);
}

export async function listTelegramSpooledUpdateClaims(params: QueueScope) {
  return parseRecords(await openTelegramIngressQueue(params).listClaims());
}
