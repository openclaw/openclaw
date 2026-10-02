import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";
import type {
  QueuedSessionDelivery,
  SessionDeliverySettledOutcome,
} from "../infra/session-delivery-queue.records.js";
import type { OpenClawPluginAsyncToolCallbackStatus } from "../plugins/tool-types.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { isIncognitoSessionKey } from "../shared/incognito-session-key.js";
import {
  preparePluginCallbackExpiry,
  preparePluginCallbackResult,
} from "./plugin-async-callback-payload.js";
import {
  assertPluginAsyncCallbackCapacity,
  hashPluginAsyncCallbackToken as digest,
  pluginAsyncCallbackSlot,
  validatePluginAsyncCallbackDeadline,
  PLUGIN_CALLBACK_MAX_PENDING,
} from "./plugin-async-callback-policy.js";
import type { PluginAsyncCallbackBinding } from "./plugin-async-callback-policy.js";

export interface PluginCallbackMemoryLifetime {
  expiresAt: number;
  isCurrent(): boolean;
  verify(): Promise<boolean>;
  onRetire(retire: () => void): () => void;
}
type RecordEntry = {
  binding: PluginAsyncCallbackBinding;
  key: string;
  slot: string;
  expiresAt: number;
  status: "pending" | "accepted" | "expired" | "delivered" | "failed";
  lifetime: PluginCallbackMemoryLifetime;
  unsubscribe: () => void;
};
type Realm = {
  closed: boolean;
  runInOwner: ReturnType<typeof AsyncLocalStorage.snapshot>;
  records: Map<string, RecordEntry>;
  slots: Map<string, string>;
  pending: Map<string, QueuedSessionDelivery>;
  scheduleExpiry: (key: string, atMs: number, retire: () => void) => () => void;
};
const root = resolveGlobalSingleton<{ active?: Realm }>(
  Symbol.for("openclaw.pluginAsyncCallbackMemory"),
  () => ({}),
  (value) => {
    if (value.active) {
      close(value.active);
    }
  },
);
function forget(realm: Realm, record: RecordEntry) {
  record.unsubscribe();
  realm.records.delete(record.key);
  if (realm.slots.get(record.slot) === record.key) {
    realm.slots.delete(record.slot);
  }
  for (const [id, entry] of realm.pending) {
    if (entry.kind === "nativeChildFollowup" && entry.callbackKey === record.key) {
      realm.pending.delete(id);
    }
  }
}
function close(realm: Realm) {
  realm.closed = true;
  for (const record of realm.records.values()) {
    forget(realm, record);
  }
  realm.pending.clear();
  realm.slots.clear();
  if (root.active === realm) {
    root.active = undefined;
  }
}
/** The existing delivery runtime owns RAM lifetime; neither plugins nor lookups create it. */
export function startPluginCallbackMemory(scheduleExpiry: Realm["scheduleExpiry"]): () => void {
  if (root.active) {
    close(root.active);
  }
  const realm: Realm = {
    closed: false,
    runInOwner: AsyncLocalStorage.snapshot(),
    records: new Map(),
    slots: new Map(),
    pending: new Map(),
    scheduleExpiry,
  };
  root.active = realm;
  return () => close(realm);
}
/** Capture observers in the delivery runtime, not the short-lived issuing tool invocation. */
export async function withPluginCallbackMemoryOwner<T>(run: () => Promise<T>): Promise<T> {
  const realm = root.active;
  if (!realm || realm.closed) {
    throw new Error("Incognito callback runtime is unavailable");
  }
  const result = await realm.runInOwner(run);
  if (root.active !== realm || realm.closed) {
    throw new Error("Incognito callback runtime retired");
  }
  return result;
}

export function isMemoryPluginCallbackToken(token: string): boolean {
  return token.startsWith("memory:");
}
export function isMemorySessionDelivery(id: string): boolean {
  return id.startsWith("memory:");
}
function current(realm: Realm, record: RecordEntry): boolean {
  if (realm.closed || root.active !== realm || realm.records.get(record.key) !== record) {
    return false;
  }
  if (!record.lifetime.isCurrent() || Date.now() >= record.lifetime.expiresAt) {
    forget(realm, record);
    return false;
  }
  return true;
}
function receipt(realm: Realm, record: RecordEntry): OpenClawPluginAsyncToolCallbackStatus {
  if (!current(realm, record)) {
    return { status: "unknown" };
  }
  if (record.status === "pending" && Date.now() >= record.expiresAt) {
    record.status = "expired";
  }
  return { status: record.status, expiresAt: record.expiresAt, storage: "memory" };
}

export function issueMemoryPluginCallback(
  binding: PluginAsyncCallbackBinding,
  ttlMs: number,
  lifetime: PluginCallbackMemoryLifetime,
) {
  const now = Date.now();
  const expiresAt = Math.min(
    validatePluginAsyncCallbackDeadline(binding, ttlMs, now),
    lifetime.expiresAt,
  );
  const realm = root.active;
  if (!realm || realm.closed) {
    throw new Error(
      "Incognito callback delivery is unavailable until the Gateway runtime is ready",
    );
  }
  if (
    !isIncognitoSessionKey(binding.childSessionKey) ||
    !lifetime.isCurrent() ||
    expiresAt <= now
  ) {
    throw new Error("Incognito callback session is unavailable");
  }
  for (const record of realm.records.values()) {
    current(realm, record);
  }
  const slot = pluginAsyncCallbackSlot(binding);
  let pluginPending = 0;
  for (const key of realm.slots.values()) {
    if (realm.records.get(key)?.binding.pluginId === binding.pluginId) {
      pluginPending++;
    }
  }
  assertPluginAsyncCallbackCapacity({
    occupied: realm.slots.has(slot),
    pluginPending,
    totalPending: realm.slots.size,
  });
  // Receipt-only entries are bounded too; never evict outstanding work to admit more.
  if (realm.records.size >= 2 * PLUGIN_CALLBACK_MAX_PENDING) {
    for (const record of realm.records.values()) {
      if (realm.slots.get(record.slot) !== record.key) {
        forget(realm, record);
      }
      if (realm.records.size < 2 * PLUGIN_CALLBACK_MAX_PENDING) {
        break;
      }
    }
  }
  const token = "memory:" + randomBytes(32).toString("base64url");
  const key = digest(token);
  const record: RecordEntry = {
    binding: { ...binding },
    key,
    slot,
    expiresAt,
    status: "pending",
    lifetime,
    unsubscribe: () => {},
  };
  const expiry = preparePluginCallbackExpiry({ binding, key, expiresAt, now, memory: true });
  realm.records.set(key, record);
  realm.slots.set(slot, key);
  realm.pending.set(expiry.id, expiry);
  const retire = () => forget(realm, record);
  const stopObserving = lifetime.onRetire(retire);
  const stopExpiry = realm.scheduleExpiry(key, lifetime.expiresAt, retire);
  record.unsubscribe = () => {
    stopObserving();
    stopExpiry();
  };
  if (!current(realm, record)) {
    throw new Error("Incognito callback session retired during issuance");
  }
  return { token, expiresAt, queueId: expiry.id };
}

/** Access retains the original realm and record across every asynchronous host check. */
export async function getMemoryPluginCallbackAccess(token: string, pluginId: string) {
  const realm = root.active;
  if (!realm || !/^memory:[A-Za-z0-9_-]{43}$/.test(token)) {
    return undefined;
  }
  const record = realm.records.get(digest(token));
  if (!record || record.binding.pluginId !== pluginId || !current(realm, record)) {
    return undefined;
  }
  if (!(await record.lifetime.verify()) || !current(realm, record)) {
    forget(realm, record);
    return undefined;
  }
  return {
    binding: record.binding,
    revoke: () => forget(realm, record),
    status: () => receipt(realm, record),
    complete(
      resultText: string,
    ): { status: "accepted"; queueId: string } | { status: "duplicate" | "expired" | "unknown" } {
      const state = receipt(realm, record).status;
      if (state === "unknown" || state === "expired") {
        return { status: state };
      }
      if (state !== "pending") {
        return { status: "duplicate" };
      }
      const entry = preparePluginCallbackResult({
        binding: record.binding,
        key: record.key,
        resultText,
        now: Date.now(),
        memory: true,
      });
      record.status = "accepted";
      realm.pending.set(entry.id, entry);
      return { status: "accepted", queueId: entry.id };
    },
  };
}
function ownedRecord(
  entry: QueuedSessionDelivery,
): { realm: Realm; record: RecordEntry } | undefined {
  const realm = root.active;
  if (
    !realm ||
    !isMemorySessionDelivery(entry.id) ||
    entry.kind !== "nativeChildFollowup" ||
    !entry.callbackKey
  ) {
    return undefined;
  }
  const record = realm.records.get(entry.callbackKey);
  if (!record || !current(realm, record) || realm.pending.get(entry.id) !== entry) {
    return undefined;
  }
  return { realm, record };
}
export function assertMemoryCallbackDeliveryCurrent(entry: QueuedSessionDelivery): void {
  if (!ownedRecord(entry)) {
    throw new Error("Incognito callback delivery owner retired");
  }
}
export async function verifyMemoryCallbackDelivery(entry: QueuedSessionDelivery): Promise<boolean> {
  const owner = ownedRecord(entry);
  return (
    owner !== undefined &&
    (await owner.record.lifetime.verify()) &&
    ownedRecord(entry) !== undefined
  );
}
export function expireMemoryPluginCallback(entry: QueuedSessionDelivery): boolean {
  const owner = ownedRecord(entry);
  if (!owner) {
    return false;
  }
  const { record } = owner;
  if (record.status !== "pending" && record.status !== "expired") {
    return false;
  }
  if (Date.now() < record.expiresAt) {
    return false;
  }
  record.status = "expired";
  return true;
}
export function settleMemoryPluginCallback(
  entry: QueuedSessionDelivery,
  outcome: SessionDeliverySettledOutcome,
): void {
  const owner = ownedRecord(entry);
  if (!owner || entry.kind !== "nativeChildFollowup") {
    return;
  }
  const { realm, record } = owner;
  if (entry.callbackExpiryKey && record.status !== "expired") {
    if (record.status !== "pending" || outcome !== "moved-to-failed") {
      return;
    }
    record.status = "failed";
  }
  if (!entry.callbackExpiryKey) {
    record.status = outcome === "recovered" ? "delivered" : "failed";
  }
  if (realm.slots.get(record.slot) === record.key) {
    realm.slots.delete(record.slot);
  }
}
export function loadMemorySessionDelivery(id: string): QueuedSessionDelivery | null {
  const entry = root.active?.pending.get(id);
  return entry && ownedRecord(entry) ? entry : null;
}
export function listMemorySessionDeliveries(): QueuedSessionDelivery[] {
  return [...(root.active?.pending.values() ?? [])].filter((entry) => Boolean(ownedRecord(entry)));
}
export function updateMemorySessionDelivery(
  id: string,
  update: Partial<
    Pick<
      QueuedSessionDelivery,
      "availableAt" | "deliveryStartedAt" | "settlementOutcome" | "acknowledgedAt"
    >
  >,
): void {
  const entry = loadMemorySessionDelivery(id);
  if (entry) {
    Object.assign(entry, update);
  }
}
export function failMemorySessionDelivery(id: string): void {
  const entry = loadMemorySessionDelivery(id);
  if (entry) {
    entry.retryCount++;
    entry.lastAttemptAt = Date.now();
  }
}
export function removeMemorySessionDelivery(id: string): void {
  root.active?.pending.delete(id);
}
