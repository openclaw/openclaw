// Telegram plugin module implements durable ingress enqueue + update_id mapping.
import os from "node:os";
import path from "node:path";
import {
  INGRESS_CLAIM_PROCESS_ID,
  processPidFromOwnerId,
  type ChannelIngressQueue,
  type ChannelIngressQueueClaim,
  type ChannelIngressQueueClaimRef,
  type ChannelIngressQueueCorruptClaim,
  type ChannelIngressQueueRecord,
} from "openclaw/plugin-sdk/channel-outbound";
import { computeBackoff, type BackoffPolicy } from "openclaw/plugin-sdk/runtime-env";
import { resolveStateDir } from "openclaw/plugin-sdk/state-paths";
import type { TelegramBotInfo } from "./bot-info.js";
import { getTelegramRuntime } from "./runtime.js";
import { getTelegramSequentialKey } from "./sequential-key.js";
import { normalizeTelegramStateAccountId } from "./state-account-id.js";
import {
  TELEGRAM_SPOOLED_UPDATE_PAYLOAD_VERSION,
  type TelegramSpooledUpdatePayload,
} from "./telegram-ingress-spool.payload.js";
import type {
  ClaimedTelegramSpooledUpdate,
  TelegramSpooledUpdate,
} from "./telegram-ingress-spool.types.js";

export type {
  ClaimedTelegramSpooledUpdate,
  TelegramSpooledUpdate,
} from "./telegram-ingress-spool.types.js";
export type { TelegramSpooledUpdatePayload } from "./telegram-ingress-spool.payload.js";

const TELEGRAM_INGRESS_SPOOL_PREFIX = "ingress-spool-";
const TELEGRAM_SPOOLED_UPDATE_FAILED_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const TELEGRAM_SPOOLED_UPDATE_FAILED_MAX_ENTRIES = 1000;
const TELEGRAM_SPOOLED_UPDATE_COMPLETED_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const TELEGRAM_SPOOLED_UPDATE_COMPLETED_MAX_ENTRIES = 1000;
const TELEGRAM_SPOOLED_COMPLETION_RETRY_POLICY: BackoffPolicy = {
  initialMs: 250,
  maxMs: 5_000,
  factor: 2,
  jitter: 0.2,
};

function isValidUpdateId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function resolveTelegramIngressSpoolDir(params: {
  accountId?: string;
  env?: NodeJS.ProcessEnv;
}): string {
  const stateDir = resolveStateDir(params.env, os.homedir);
  return path.join(
    stateDir,
    "telegram",
    `${TELEGRAM_INGRESS_SPOOL_PREFIX}${normalizeTelegramStateAccountId(params.accountId)}`,
  );
}

function resolveTelegramUpdateId(update: unknown): number | null {
  if (!update || typeof update !== "object") {
    return null;
  }
  const value = (update as { update_id?: unknown }).update_id;
  return isValidUpdateId(value) ? value : null;
}

export function telegramQueueEventId(updateId: number): string {
  return String(updateId).padStart(16, "0");
}

function spoolFileName(updateId: number): string {
  return `${telegramQueueEventId(updateId)}.json`;
}

function resolveQueueParts(spoolDir: string): {
  accountId: string;
  stateDir: string;
} {
  const basename = path.basename(spoolDir);
  const accountId = normalizeTelegramStateAccountId(
    basename.startsWith(TELEGRAM_INGRESS_SPOOL_PREFIX)
      ? basename.slice(TELEGRAM_INGRESS_SPOOL_PREFIX.length)
      : basename,
  );
  const stateDir =
    basename.startsWith(TELEGRAM_INGRESS_SPOOL_PREFIX) &&
    path.basename(path.dirname(spoolDir)) === "telegram"
      ? path.dirname(path.dirname(spoolDir))
      : spoolDir;
  return { accountId, stateDir };
}

/** Open the account-scoped durable ingress queue for this spool directory. */
export function openTelegramIngressQueue(
  spoolDir: string,
): ChannelIngressQueue<TelegramSpooledUpdatePayload> {
  const parts = resolveQueueParts(spoolDir);
  return getTelegramRuntime().state.openChannelIngressQueue<TelegramSpooledUpdatePayload>({
    accountId: parts.accountId,
    stateDir: parts.stateDir,
  });
}

export function telegramSpooledUpdateLaneKey(update: unknown, botInfo?: TelegramBotInfo): string {
  return getTelegramSequentialKey({
    update: update as Parameters<typeof getTelegramSequentialKey>[0]["update"],
    ...(botInfo ? { me: botInfo } : {}),
  });
}

async function pruneTelegramIngressQueue(
  queue: ChannelIngressQueue<TelegramSpooledUpdatePayload>,
  now?: number,
): Promise<void> {
  await queue.prune({
    completedTtlMs: TELEGRAM_SPOOLED_UPDATE_COMPLETED_TTL_MS,
    completedMaxEntries: TELEGRAM_SPOOLED_UPDATE_COMPLETED_MAX_ENTRIES,
    failedTtlMs: TELEGRAM_SPOOLED_UPDATE_FAILED_TTL_MS,
    failedMaxEntries: TELEGRAM_SPOOLED_UPDATE_FAILED_MAX_ENTRIES,
    ...(now === undefined ? {} : { now }),
  });
}

/**
 * Durable-before-ack accept path: commit the update to the ingress queue.
 * Polling advances offset only after this returns; webhook returns 200 only after.
 */
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
  const queue = openTelegramIngressQueue(params.spoolDir);
  await pruneTelegramIngressQueue(queue, params.now);
  await queue.enqueue(
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
      const update = parsePendingRecord(params.spoolDir, record);
      return update ? [update] : [];
    })
    .toSorted((a, b) => a.updateId - b.updateId);
}

function parsePendingRecord(
  spoolDir: string,
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
    path: path.join(spoolDir, spoolFileName(payload.updateId)),
    update: payload.update,
    receivedAt: payload.receivedAt,
    attempts: record.attempts,
    ...(record.lastAttemptAt === undefined ? {} : { lastAttemptAt: record.lastAttemptAt }),
    ...(record.lastError === undefined ? {} : { lastError: record.lastError }),
  };
}

/** Backoff for irrevocable-adoption completion retries (bot-message only). */
export function resolveSpooledUpdatePersistenceRetryDelayMs(attempt: number): number {
  return computeBackoff(TELEGRAM_SPOOLED_COMPLETION_RETRY_POLICY, attempt);
}

// --- Thin queue claim helpers (transport tests + recovery tools) ---
// Drain loops live in core; these wrap openTelegramIngressQueue only.

function processingFileName(updateId: number): string {
  return `${spoolFileName(updateId)}.processing`;
}

function parseQueueClaim(
  spoolDir: string,
  record: ChannelIngressQueueClaim<TelegramSpooledUpdatePayload>,
): ClaimedTelegramSpooledUpdate | null {
  const update = parsePendingRecord(spoolDir, record);
  if (!update) {
    return null;
  }
  const claimRef = record.claim.token;
  return {
    ...update,
    path: path.join(spoolDir, processingFileName(update.updateId)),
    pendingPath: path.join(spoolDir, spoolFileName(update.updateId)),
    claim: {
      processId: record.claim.ownerId,
      processPid: processPidFromOwnerId(record.claim.ownerId),
      claimedAt: record.claim.claimedAt,
      claimToken: claimRef,
    },
  };
}

function queueMutationTarget(update: TelegramSpooledUpdate): string | ChannelIngressQueueClaimRef {
  const id = telegramQueueEventId(update.updateId);
  const claimRef = update.claim?.claimToken;
  return claimRef ? { id, claim: { token: claimRef } } : id;
}

export async function claimNextTelegramSpooledUpdate(params: {
  spoolDir: string;
  blockedLaneKeys?: Iterable<string>;
  botInfo?: TelegramBotInfo;
  candidateUpdateIds?: Iterable<number>;
  scanLimit?: number;
}): Promise<ClaimedTelegramSpooledUpdate | null> {
  const queue = openTelegramIngressQueue(params.spoolDir);
  const claimed = await queue.claimNext({
    ownerId: INGRESS_CLAIM_PROCESS_ID,
    blockedLaneKeys: params.blockedLaneKeys,
    ...(params.candidateUpdateIds === undefined
      ? {}
      : { candidateIds: [...params.candidateUpdateIds].map(telegramQueueEventId) }),
    orderBy: "id",
    scanLimit: params.scanLimit,
    deriveLaneKey: (record) => telegramSpooledUpdateLaneKey(record.payload.update, params.botInfo),
  });
  if (!claimed) {
    return null;
  }
  const update = parseQueueClaim(params.spoolDir, claimed);
  if (update) {
    return update;
  }
  await queue.fail(claimed, {
    reason: "invalid-spooled-update",
    message: "Telegram spooled update payload was invalid.",
  });
  return null;
}

export async function listTelegramSpooledUpdateClaims(params: {
  spoolDir: string;
}): Promise<ClaimedTelegramSpooledUpdate[]> {
  const claims = await openTelegramIngressQueue(params.spoolDir).listClaims();
  return claims
    .flatMap((claim) => {
      const update = parseQueueClaim(params.spoolDir, claim);
      return update ? [update] : [];
    })
    .toSorted((a, b) => a.updateId - b.updateId);
}

export async function recoverStaleTelegramSpooledUpdateClaims(params: {
  spoolDir: string;
  staleMs?: number;
  now?: number;
  shouldRecover?: (claim: ClaimedTelegramSpooledUpdate) => boolean | Promise<boolean>;
  shouldRecoverCorrupt?: (claim: ChannelIngressQueueCorruptClaim) => boolean | Promise<boolean>;
}): Promise<number> {
  const shouldRecover = params.shouldRecover;
  const shouldRecoverCorrupt = params.shouldRecoverCorrupt;
  return await openTelegramIngressQueue(params.spoolDir).recoverStaleClaims({
    staleMs: params.staleMs ?? 0,
    ...(params.now === undefined ? {} : { now: params.now }),
    ...(shouldRecover
      ? {
          shouldRecover: async (claim) => {
            const update = parseQueueClaim(params.spoolDir, claim);
            return update ? await shouldRecover(update) : false;
          },
        }
      : {}),
    ...(shouldRecoverCorrupt ? { shouldRecoverCorrupt } : {}),
  });
}

export async function releaseTelegramSpooledUpdateClaim(
  update: ClaimedTelegramSpooledUpdate,
  options?: { lastError?: string; releasedAt?: number },
): Promise<void> {
  await openTelegramIngressQueue(path.dirname(update.pendingPath)).release(
    queueMutationTarget(update),
    options,
  );
}

export async function failTelegramSpooledUpdateClaim(params: {
  update: ClaimedTelegramSpooledUpdate;
  reason: string;
  message: string;
  now?: number;
}): Promise<boolean> {
  return await openTelegramIngressQueue(path.dirname(params.update.pendingPath)).fail(
    queueMutationTarget(params.update),
    {
      reason: params.reason,
      message: params.message,
      ...(params.now === undefined ? {} : { failedAt: params.now }),
    },
  );
}
