import type { PluginRuntime } from "openclaw/plugin-sdk/runtime-store";
import { CallRecordSchema, TerminalStates, type CallId, type CallRecord } from "../types.js";

const pendingPersistWrites = new Set<Promise<void>>();
const memoryStores = new Map<string, Map<string, { value: CallRecord; createdAt: number }>>();

export type VoiceCallRecordStore = {
  register(key: string, value: CallRecord): Promise<void>;
  entries(): Promise<Array<{ key: string; value: CallRecord; createdAt: number }>>;
};

export function createVoiceCallRecordStore(
  openKeyedStore: PluginRuntime["state"]["openKeyedStore"],
): VoiceCallRecordStore {
  return openKeyedStore<CallRecord>({
    namespace: "calls",
    maxEntries: 10_000,
  });
}

export function createMemoryCallRecordStore(key: string): VoiceCallRecordStore {
  let store = memoryStores.get(key);
  if (!store) {
    store = new Map();
    memoryStores.set(key, store);
  }
  return {
    async register(callKey, value) {
      store.set(callKey, { value, createdAt: Date.now() });
    },
    async entries() {
      return [...store].map(([entryKey, entry]) => ({
        key: entryKey,
        value: entry.value,
        createdAt: entry.createdAt,
      }));
    },
  };
}

export function persistCallRecord(store: VoiceCallRecordStore, call: CallRecord): void {
  // Fire-and-forget async write to avoid blocking event loop.
  const write = store
    .register(call.callId, call)
    .catch((err) => {
      console.error("[voice-call] Failed to persist call record:", err);
    })
    .finally(() => {
      pendingPersistWrites.delete(write);
    });
  pendingPersistWrites.add(write);
}

export async function flushPendingCallRecordWritesForTest(): Promise<void> {
  await Promise.allSettled(pendingPersistWrites);
}

export async function loadActiveCallsFromStore(store: VoiceCallRecordStore): Promise<{
  activeCalls: Map<CallId, CallRecord>;
  providerCallIdMap: Map<string, CallId>;
  processedEventIds: Set<string>;
  rejectedProviderCallIds: Set<string>;
}> {
  const callMap = new Map<CallId, CallRecord>();
  for (const entry of await store.entries()) {
    try {
      const call = CallRecordSchema.parse(entry.value);
      callMap.set(call.callId, call);
    } catch {
      // Skip invalid rows.
    }
  }

  const activeCalls = new Map<CallId, CallRecord>();
  const providerCallIdMap = new Map<string, CallId>();
  const processedEventIds = new Set<string>();
  const rejectedProviderCallIds = new Set<string>();

  for (const [callId, call] of callMap) {
    for (const eventId of call.processedEventIds) {
      processedEventIds.add(eventId);
    }
    if (TerminalStates.has(call.state)) {
      continue;
    }
    activeCalls.set(callId, call);
    if (call.providerCallId) {
      providerCallIdMap.set(call.providerCallId, callId);
    }
  }

  return { activeCalls, providerCallIdMap, processedEventIds, rejectedProviderCallIds };
}

export async function getCallHistoryFromStore(
  store: VoiceCallRecordStore,
  limit = 50,
): Promise<CallRecord[]> {
  const calls: CallRecord[] = [];

  const entries = await store.entries();
  for (const entry of entries.slice(-limit)) {
    try {
      const parsed = CallRecordSchema.parse(entry.value);
      calls.push(parsed);
    } catch {
      // Skip invalid rows.
    }
  }

  return calls;
}
