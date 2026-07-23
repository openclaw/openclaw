// Rcs plugin module persists recent outbound delivery status callbacks.
//
// Twilio posts message status callbacks (queued/sent/delivered/read/failed) to
// the status route. Store them in OpenClaw's shared SQLite plugin state so
// receipts survive gateway restarts and remain available to probes/status.
import type { PluginStateSyncKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import { getRcsRuntime } from "./runtime.js";
import type { RcsStatusEvent } from "./types.js";

const MAX_EVENTS_PER_ACCOUNT = 50;
const STATUS_STORE_MAX_ENTRIES = 5_000;
const STATUS_STORE_TTL_MS = 90 * 24 * 60 * 60 * 1_000;

type StoredRcsStatusEvent = {
  accountId: string;
  event: RcsStatusEvent;
  receivedAt: number;
};

let lastReceivedAt = 0;

function openRcsStatusStore(): PluginStateSyncKeyedStore<StoredRcsStatusEvent> {
  return getRcsRuntime().state.openSyncKeyedStore<StoredRcsStatusEvent>({
    namespace: "delivery-receipts",
    maxEntries: STATUS_STORE_MAX_ENTRIES,
    overflowPolicy: "evict-oldest",
    defaultTtlMs: STATUS_STORE_TTL_MS,
  });
}

export function recordRcsStatusEvent(accountId: string, event: RcsStatusEvent): void {
  const receivedAt = Math.max(Date.now(), lastReceivedAt + 1);
  lastReceivedAt = receivedAt;
  openRcsStatusStore().register(`${accountId}:${event.messageSid}`, {
    accountId,
    event,
    receivedAt,
  });
}

export function listRcsStatusEvents(accountId: string): RcsStatusEvent[] {
  return openRcsStatusStore()
    .entries()
    .map((entry) => entry.value)
    .filter((record) => record.accountId === accountId)
    .toSorted((left, right) => right.receivedAt - left.receivedAt)
    .slice(0, MAX_EVENTS_PER_ACCOUNT)
    .map((record) => record.event);
}

/** Most recently received delivery/read callback for this account, if any. */
export function latestRcsStatusEvent(accountId: string): RcsStatusEvent | undefined {
  return listRcsStatusEvents(accountId)[0];
}
