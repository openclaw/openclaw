import type { ChannelIngressQueueRecord } from "openclaw/plugin-sdk/channel-outbound";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type { TelegramSpooledReplayDeferredParticipant } from "./bot-processing-outcome.js";
import { commitTelegramMessageDispatchReplay } from "./message-dispatch-dedupe.js";
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

export function createHeldTelegramReplay(operation: "commit" | "rollback" | "introduction") {
  const operationStarted = createDeferred<void>();
  const releaseOperation = createDeferred<void>();
  const recorded = new Set<string>();
  const wait = async () => {
    operationStarted.resolve();
    await releaseOperation.promise;
  };
  return {
    operationStarted,
    releaseOperation,
    recorded,
    async settle(participant: TelegramSpooledReplayDeferredParticipant) {
      const hold = participant.beginSettlementHold();
      if (!hold) {
        throw new Error("Expected accepted replay settlement ownership");
      }
      try {
        if (operation === "introduction") {
          await wait();
          recorded.add("introduction");
        } else {
          await commitTelegramMessageDispatchReplay({
            requirePersistent: true,
            guard: {
              claim: async () => ({ kind: "invalid" }),
              warmup: async () => 0,
              forget: async (event) => {
                await wait();
                for (const key of "keys" in event ? (event.keys ?? []) : []) {
                  recorded.delete(key);
                }
                return true;
              },
            },
            claims: ["first", "second"].map((key) => ({
              keys: [key],
              commit: async (options) => {
                if (operation === "commit" && key === "first") {
                  await wait();
                }
                recorded.add(key);
                if (operation === "rollback" && key === "second") {
                  options?.onDiskError?.(new Error("synthetic commit failure"));
                }
                return true;
              },
              release: () => undefined,
            })),
          });
        }
        hold.release("discard-pending");
        participant.settle({ kind: "completed" });
      } catch (error) {
        hold.release("replay-pending");
        participant.settle({ kind: "failed-retryable", error });
      }
    },
  };
}

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
    .map(({ payload: { updateId, update, receivedAt }, attempts, lastAttemptAt, lastError }) =>
      Object.assign(
        { updateId, update, receivedAt, attempts },
        lastAttemptAt === undefined ? {} : { lastAttemptAt },
        lastError === undefined ? {} : { lastError },
      ),
    )
    .toSorted((a, b) => a.updateId - b.updateId);
}

export async function listTelegramSpooledUpdates(params: QueueScope & { limit?: number | "all" }) {
  const records = await openTelegramIngressQueue(params).listPending({
    limit: params.limit ?? 100,
    orderBy: "id",
  });
  return parseRecords(records);
}

export async function listTelegramSpooledUpdateClaims(params: QueueScope) {
  return parseRecords(await openTelegramIngressQueue(params).listClaims());
}
