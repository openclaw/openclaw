import { createHash } from "node:crypto";
import path from "node:path";
import type { WAMessage } from "baileys";
import { withFileLock } from "openclaw/plugin-sdk/file-lock";
import { readJsonFileWithFallback, writeJsonFileAtomically } from "openclaw/plugin-sdk/json-store";
import { BufferJSON } from "../session.runtime.js";

const STORE_FILE = "inbound-queue.json";
const LOCK_OPTIONS = {
  retries: { retries: 6, factor: 1.35, minTimeout: 8, maxTimeout: 180 },
  stale: 60_000,
};
// `withFileLock` is process-local re-entrant; serialize same-file store cycles here.
const storeOperationQueues = new Map<string, Promise<unknown>>();

export type DurableInboundUpsertType = "notify" | "append";

export type DurableInboundRecord = {
  id: string;
  accountId: string;
  upsertType: DurableInboundUpsertType;
  message: WAMessage;
  receivedAt: number;
};

export type DurableInboundReadReceiptTarget = {
  id: string;
  remoteJid: string;
  participantJid?: string;
  isSelfChat: boolean;
};

type DurableInboundCompletedEntry =
  | number
  | {
      completedAt: number;
      readReceiptTarget?: DurableInboundReadReceiptTarget;
    };

type QueueStore = {
  pending: DurableInboundRecord[];
  completed: Record<string, DurableInboundCompletedEntry>;
};

export type DurableInboundAcceptResult =
  | { kind: "accepted"; record: DurableInboundRecord }
  | { kind: "duplicate"; id: string; readReceiptTarget?: DurableInboundReadReceiptTarget }
  | { kind: "untracked" };

function isRecordObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function trimNonEmpty(value: string | null | undefined): string | null {
  return value?.trim() || null;
}

function durableId(params: {
  accountId: string;
  remoteJid?: string | null;
  messageId?: string | null;
  participantJid?: string | null;
}): string | null {
  const accountId = trimNonEmpty(params.accountId);
  const remoteJid = trimNonEmpty(params.remoteJid);
  const messageId = trimNonEmpty(params.messageId);
  if (!accountId || !remoteJid || !messageId || messageId === "unknown") {
    return null;
  }
  return createHash("sha256")
    .update([accountId, remoteJid, messageId, trimNonEmpty(params.participantJid) ?? ""].join("\0"))
    .digest("hex");
}

function coerceMessageTimestamp(raw: unknown): number | undefined {
  if (raw == null) {
    return undefined;
  }
  if (typeof raw === "object" && typeof (raw as { toNumber?: unknown }).toNumber === "function") {
    const value = Number((raw as { toNumber: () => unknown }).toNumber());
    return Number.isFinite(value) ? value : undefined;
  }
  if (isRecordObject(raw) && typeof raw.low === "number" && typeof raw.high === "number") {
    const low = raw.unsigned === true ? raw.low >>> 0 : raw.low;
    const high = raw.unsigned === true ? raw.high >>> 0 : raw.high;
    const value = low + high * 0x100000000;
    return Number.isSafeInteger(value) ? value : undefined;
  }
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

function prepareMessage(message: WAMessage): WAMessage {
  const messageTimestamp = coerceMessageTimestamp(message.messageTimestamp);
  const storable = messageTimestamp === undefined ? message : { ...message, messageTimestamp };
  return JSON.parse(JSON.stringify(storable, BufferJSON.replacer)) as WAMessage;
}

function reviveMessage(message: WAMessage): WAMessage {
  const revived = JSON.parse(JSON.stringify(message), BufferJSON.reviver) as WAMessage;
  const messageTimestamp = coerceMessageTimestamp(revived.messageTimestamp);
  return messageTimestamp === undefined ? revived : { ...revived, messageTimestamp };
}

async function readStore(filePath: string): Promise<QueueStore> {
  const { value } = await readJsonFileWithFallback<unknown>(filePath, null);
  if (!isRecordObject(value)) {
    return { pending: [], completed: {} };
  }
  const pending = Array.isArray(value.pending) ? (value.pending as DurableInboundRecord[]) : [];
  return {
    pending: pending
      .filter((record) => isRecordObject(record.message))
      .map((record) => Object.assign({}, record, { message: reviveMessage(record.message) })),
    completed: isRecordObject(value.completed)
      ? (value.completed as Record<string, DurableInboundCompletedEntry>)
      : {},
  };
}

function completedEntryTime(entry: DurableInboundCompletedEntry): number {
  return typeof entry === "number" ? entry : entry.completedAt;
}

function pruneCompleted(
  completed: Record<string, DurableInboundCompletedEntry>,
): Record<string, DurableInboundCompletedEntry> {
  return Object.fromEntries(
    Object.entries(completed)
      .toSorted(([, a], [, b]) => completedEntryTime(b) - completedEntryTime(a))
      .slice(0, 10_000),
  );
}

function enqueueStoreOperation<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
  const previous = storeOperationQueues.get(filePath) ?? Promise.resolve();
  const next = previous.then(fn, fn);
  storeOperationQueues.set(filePath, next);
  next
    .finally(() => {
      if (storeOperationQueues.get(filePath) === next) {
        storeOperationQueues.delete(filePath);
      }
    })
    .catch(() => {});
  return next;
}

async function updateStore<T>(
  authDir: string,
  fn: (store: QueueStore, now: number, filePath: string) => Promise<T>,
) {
  const filePath = path.join(authDir, STORE_FILE);
  return await enqueueStoreOperation(filePath, () =>
    withFileLock(filePath, LOCK_OPTIONS, async () => {
      const now = Date.now();
      const store = await readStore(filePath);
      store.completed = pruneCompleted(store.completed);
      return await fn(store, now, filePath);
    }),
  );
}

export async function acceptDurableInboundMessage(params: {
  authDir: string;
  accountId: string;
  upsertType: DurableInboundUpsertType;
  message: WAMessage;
  receivedAt?: number;
}): Promise<DurableInboundAcceptResult> {
  const messageId = params.message.key?.id ?? undefined;
  const remoteJid = params.message.key?.remoteJid ?? undefined;
  const participantJid = params.message.key?.participant ?? undefined;
  const id = durableId({ accountId: params.accountId, remoteJid, messageId, participantJid });
  if (!id || !remoteJid || !messageId) {
    return { kind: "untracked" };
  }
  return await updateStore(params.authDir, async (store, now, filePath) => {
    const completed = store.completed[id];
    if (completed !== undefined) {
      return {
        kind: "duplicate",
        id,
        readReceiptTarget: typeof completed === "number" ? undefined : completed.readReceiptTarget,
      };
    }
    const pending = store.pending.find((record) => record.id === id);
    if (pending) {
      return { kind: "accepted", record: pending };
    }
    const record: DurableInboundRecord = {
      id,
      accountId: params.accountId,
      upsertType: params.upsertType,
      message: prepareMessage(params.message),
      receivedAt: params.receivedAt ?? now,
    };
    await writeJsonFileAtomically(filePath, {
      ...store,
      pending: [...store.pending, record],
    });
    return { kind: "accepted", record: { ...record, message: params.message } };
  });
}

export async function loadPendingDurableInboundMessages(params: {
  authDir: string;
  accountId: string;
}): Promise<DurableInboundRecord[]> {
  return await updateStore(params.authDir, async (store) =>
    store.pending
      .filter(
        (record) =>
          record.accountId === params.accountId && store.completed[record.id] === undefined,
      )
      .toSorted((a, b) => a.receivedAt - b.receivedAt || a.id.localeCompare(b.id)),
  );
}

export async function completeDurableInboundMessage(params: {
  authDir: string;
  record: DurableInboundRecord;
  readReceiptTarget?: DurableInboundReadReceiptTarget;
}): Promise<void> {
  await updateStore(params.authDir, async (store, now, filePath) => {
    const completedEntry: DurableInboundCompletedEntry = params.readReceiptTarget
      ? { completedAt: now, readReceiptTarget: params.readReceiptTarget }
      : now;
    await writeJsonFileAtomically(filePath, {
      ...store,
      pending: store.pending.filter((record) => record.id !== params.record.id),
      completed: pruneCompleted({ ...store.completed, [params.record.id]: completedEntry }),
    });
  });
}

export async function recordDurableInboundRetry(params: {
  authDir: string;
  record: DurableInboundRecord;
}): Promise<void> {
  await updateStore(params.authDir, async (store, _now, filePath) => {
    if (store.completed[params.record.id] !== undefined) {
      return;
    }
    const current = store.pending.find((record) => record.id === params.record.id) ?? params.record;
    const next = {
      ...current,
      message: prepareMessage(current.message),
    };
    await writeJsonFileAtomically(filePath, {
      ...store,
      pending: [next, ...store.pending.filter((record) => record.id !== next.id)],
    });
  });
}
