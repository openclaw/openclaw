import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { PluginStateSyncKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  appendRegularFile,
  privateFileStore,
  privateFileStoreSync,
} from "openclaw/plugin-sdk/security-runtime";
import { getOptionalVoiceCallStateRuntime } from "../runtime-state.js";
import { CallRecordSchema, TerminalStates, type CallId, type CallRecord } from "../types.js";

const pendingPersistWrites = new Set<Promise<void>>();
const CALL_RECORD_EVENTS_NAMESPACE = "call-record-events";
const CALL_RECORD_EVENT_CHUNKS_NAMESPACE = "call-record-event-chunks";
const CALL_RECORD_MIGRATIONS_NAMESPACE = "call-record-migrations";
const CALL_RECORD_JSONL_MIGRATION_KEY = "calls-jsonl-v1";
const MAX_CALL_RECORD_EVENTS = 1000;
const CALL_RECORD_EVENT_META_MAX_ENTRIES = MAX_CALL_RECORD_EVENTS + 100;
const MAX_CHUNKS_PER_CALL_RECORD_EVENT = 48;
const CALL_RECORD_CHUNK_MAX_ENTRIES =
  MAX_CALL_RECORD_EVENTS * MAX_CHUNKS_PER_CALL_RECORD_EVENT + MAX_CHUNKS_PER_CALL_RECORD_EVENT;
const RAW_CHUNK_BYTES = 36 * 1024;
let callRecordEventSequence = 0;

type CallRecordEventMeta = {
  chunkCount: number;
  byteLength: number;
  persistedAt?: number;
  sequence?: number;
};

type CallRecordEventChunk = {
  index: number;
  dataBase64: string;
};

type CallRecordMigrationMarker = {
  importedAt: string;
};

type PersistedCallRecord = {
  call: CallRecord;
  persistedAt: number;
  sequence: number;
  orderKey: string;
};

type CallRecordStateStores = {
  events: PluginStateSyncKeyedStore<CallRecordEventMeta>;
  chunks: PluginStateSyncKeyedStore<CallRecordEventChunk>;
  migrations: PluginStateSyncKeyedStore<CallRecordMigrationMarker>;
};

function resolveCallLogPath(storePath: string): string {
  return path.join(storePath, "calls.jsonl");
}

function resolvePluginStateEnv(storePath: string): NodeJS.ProcessEnv {
  return { ...process.env, OPENCLAW_STATE_DIR: storePath };
}

function createCallRecordStateStores(storePath: string): CallRecordStateStores | null {
  const runtime = getOptionalVoiceCallStateRuntime();
  if (!runtime) {
    return null;
  }
  const env = resolvePluginStateEnv(storePath);
  return {
    events: runtime.state.openSyncKeyedStore<CallRecordEventMeta>({
      namespace: CALL_RECORD_EVENTS_NAMESPACE,
      maxEntries: CALL_RECORD_EVENT_META_MAX_ENTRIES,
      env,
    }),
    chunks: runtime.state.openSyncKeyedStore<CallRecordEventChunk>({
      namespace: CALL_RECORD_EVENT_CHUNKS_NAMESPACE,
      maxEntries: CALL_RECORD_CHUNK_MAX_ENTRIES,
      env,
    }),
    migrations: runtime.state.openSyncKeyedStore<CallRecordMigrationMarker>({
      namespace: CALL_RECORD_MIGRATIONS_NAMESPACE,
      maxEntries: 100,
      env,
    }),
  };
}

function tryCreateCallRecordStateStores(storePath: string): CallRecordStateStores | null {
  try {
    return createCallRecordStateStores(storePath);
  } catch (err) {
    console.error("[voice-call] Failed to open SQLite call record store:", err);
    return null;
  }
}

function buildChunkKey(eventKey: string, index: number): string {
  return `${eventKey}:chunk:${String(index).padStart(4, "0")}`;
}

function buildJsonlEventKey(line: string, index: number): string {
  return `jsonl:${String(index).padStart(8, "0")}:${createHash("sha256").update(line).digest("hex")}`;
}

function nextCallRecordOrder(): { persistedAt: number; sequence: number } {
  const sequence = callRecordEventSequence;
  callRecordEventSequence = (callRecordEventSequence + 1) % 1_000_000;
  return { persistedAt: Date.now(), sequence };
}

function buildNewEventKey(order: { persistedAt: number; sequence: number }): string {
  return `event:${order.persistedAt.toString(36)}:${String(order.sequence).padStart(6, "0")}:${randomUUID()}`;
}

function parseEventKeySequence(key: string): number {
  const match = /^event:[^:]+:(\d+):/.exec(key);
  return match ? Number.parseInt(match[1], 10) : 0;
}

function parseCallRecordLine(line: string, sequence = 0): PersistedCallRecord | null {
  if (!line.trim()) {
    return null;
  }
  try {
    const parsed = JSON.parse(line);
    if (parsed && typeof parsed === "object" && (parsed as { version?: unknown }).version === 2) {
      const envelope = parsed as {
        call?: unknown;
        persistedAt?: unknown;
        sequence?: unknown;
      };
      const call = CallRecordSchema.parse(envelope.call);
      return {
        call,
        persistedAt:
          typeof envelope.persistedAt === "number" && Number.isFinite(envelope.persistedAt)
            ? envelope.persistedAt
            : 0,
        sequence:
          typeof envelope.sequence === "number" && Number.isFinite(envelope.sequence)
            ? envelope.sequence
            : sequence,
        orderKey: "",
      };
    }
    return {
      call: CallRecordSchema.parse(parsed),
      persistedAt: 0,
      sequence,
      orderKey: "",
    };
  } catch {
    return null;
  }
}

function registerCallRecordEvent(
  stores: CallRecordStateStores,
  eventKey: string,
  call: CallRecord,
  order?: { persistedAt: number; sequence: number },
): void {
  const serialized = JSON.stringify(call);
  const buffer = Buffer.from(serialized, "utf8");
  const chunkCount = Math.max(1, Math.ceil(buffer.byteLength / RAW_CHUNK_BYTES));
  if (chunkCount > MAX_CHUNKS_PER_CALL_RECORD_EVENT) {
    throw new Error(
      `voice-call record exceeds SQLite chunk limit (${chunkCount}/${MAX_CHUNKS_PER_CALL_RECORD_EVENT})`,
    );
  }
  for (let index = 0; index < chunkCount; index += 1) {
    const chunk = buffer.subarray(index * RAW_CHUNK_BYTES, (index + 1) * RAW_CHUNK_BYTES);
    stores.chunks.register(buildChunkKey(eventKey, index), {
      index,
      dataBase64: chunk.toString("base64"),
    });
  }
  stores.events.register(eventKey, {
    chunkCount,
    byteLength: buffer.byteLength,
    persistedAt: order?.persistedAt,
    sequence: order?.sequence,
  });
  pruneCallRecordEvents(stores);
}

function deleteCallRecordEventRows(stores: CallRecordStateStores, eventKey: string): void {
  const meta = stores.events.lookup(eventKey);
  stores.events.delete(eventKey);
  if (!meta) {
    return;
  }
  for (let index = 0; index < meta.chunkCount; index += 1) {
    stores.chunks.delete(buildChunkKey(eventKey, index));
  }
}

function pruneCallRecordEvents(stores: CallRecordStateStores): void {
  const rows = stores.events.entries();
  if (rows.length <= MAX_CALL_RECORD_EVENTS) {
    return;
  }
  const sorted = rows.toSorted((a, b) => a.createdAt - b.createdAt || a.key.localeCompare(b.key));
  for (const row of sorted.slice(0, rows.length - MAX_CALL_RECORD_EVENTS)) {
    deleteCallRecordEventRows(stores, row.key);
  }
}

function registerCallRecordEventIfAbsent(
  stores: CallRecordStateStores,
  eventKey: string,
  record: PersistedCallRecord,
): void {
  if (!stores.events.lookup(eventKey)) {
    registerCallRecordEvent(stores, eventKey, record.call, {
      persistedAt: record.persistedAt,
      sequence: record.sequence,
    });
  }
}

function readCallRecordEvent(stores: CallRecordStateStores, eventKey: string): CallRecord | null {
  const meta = stores.events.lookup(eventKey);
  if (!meta) {
    return null;
  }
  const chunks: Buffer[] = [];
  for (let index = 0; index < meta.chunkCount; index += 1) {
    const chunk = stores.chunks.lookup(buildChunkKey(eventKey, index));
    if (!chunk || chunk.index !== index) {
      return null;
    }
    chunks.push(Buffer.from(chunk.dataBase64, "base64"));
  }
  const serialized = Buffer.concat(chunks, meta.byteLength).toString("utf8");
  return parseCallRecordLine(serialized)?.call ?? null;
}

function ensureLegacyCallLogImported(
  storePath: string,
  stores: CallRecordStateStores,
): PersistedCallRecord[] {
  const imported = stores.migrations.lookup(CALL_RECORD_JSONL_MIGRATION_KEY) !== undefined;
  const logPath = resolveCallLogPath(storePath);
  const content = privateFileStoreSync(storePath).readTextIfExists(path.basename(logPath));
  if (content === null) {
    if (!imported) {
      stores.migrations.register(CALL_RECORD_JSONL_MIGRATION_KEY, {
        importedAt: new Date().toISOString(),
      });
    }
    return [];
  }

  const fallbackCalls: PersistedCallRecord[] = [];
  {
    let index = 0;
    let importFailed = false;
    for (const line of content.split("\n")) {
      const parsed = parseCallRecordLine(line, index);
      if (!parsed) {
        index += 1;
        continue;
      }
      // Fallback JSONL writes can appear after the migration marker if SQLite
      // persistence had a transient failure. Stable keys make the importer
      // idempotent if the legacy file cannot be removed.
      try {
        registerCallRecordEventIfAbsent(stores, buildJsonlEventKey(line, index), parsed);
      } catch (err) {
        importFailed = true;
        fallbackCalls.push({
          ...parsed,
          orderKey: `jsonl:${String(index).padStart(8, "0")}`,
        });
        console.error("[voice-call] Failed to import persisted call record:", err);
      }
      index += 1;
    }
    if (!importFailed) {
      try {
        fs.rmSync(logPath, { force: true });
      } catch {
        // Import already completed; leave an unreadable legacy log in place.
      }
    }
  }
  if (!imported) {
    stores.migrations.register(CALL_RECORD_JSONL_MIGRATION_KEY, {
      importedAt: new Date().toISOString(),
    });
  }
  return fallbackCalls;
}

function readCallRecordEvents(storePath: string, stores: CallRecordStateStores): CallRecord[] {
  const fallbackCalls = ensureLegacyCallLogImported(storePath, stores);
  const sqliteCalls: PersistedCallRecord[] = stores.events
    .entries()
    .toSorted((a, b) => a.createdAt - b.createdAt || a.key.localeCompare(b.key))
    .map((entry) => {
      const call = readCallRecordEvent(stores, entry.key);
      return call
        ? {
            call,
            persistedAt: entry.value.persistedAt ?? entry.createdAt,
            sequence: entry.value.sequence ?? parseEventKeySequence(entry.key),
            orderKey: entry.key,
          }
        : null;
    })
    .filter((entry): entry is PersistedCallRecord => entry !== null);
  return [...sqliteCalls, ...fallbackCalls]
    .toSorted(
      (a, b) =>
        a.persistedAt - b.persistedAt ||
        a.sequence - b.sequence ||
        a.orderKey.localeCompare(b.orderKey),
    )
    .map((entry) => entry.call);
}

export function persistCallRecord(storePath: string, call: CallRecord): void {
  const stores = tryCreateCallRecordStateStores(storePath);
  if (stores) {
    try {
      void ensureLegacyCallLogImported(storePath, stores);
      const order = nextCallRecordOrder();
      registerCallRecordEvent(stores, buildNewEventKey(order), call, order);
      return;
    } catch (err) {
      console.error("[voice-call] Failed to persist call record:", err);
    }
  }

  const logPath = resolveCallLogPath(storePath);
  const order = nextCallRecordOrder();
  const line = `${JSON.stringify({ version: 2, ...order, call })}\n`;
  // Fire-and-forget async write to avoid blocking event loop.
  const write = appendRegularFile({
    filePath: logPath,
    content: line,
    rejectSymlinkParents: true,
  })
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

export function loadActiveCallsFromStore(storePath: string): {
  activeCalls: Map<CallId, CallRecord>;
  providerCallIdMap: Map<string, CallId>;
  processedEventIds: Set<string>;
  rejectedProviderCallIds: Set<string>;
} {
  const stores = tryCreateCallRecordStateStores(storePath);
  let calls: CallRecord[];
  try {
    calls = stores
      ? readCallRecordEvents(storePath, stores)
      : readCallRecordsFromLegacyLog(storePath);
  } catch (err) {
    console.error("[voice-call] Failed to read SQLite call records:", err);
    calls = readCallRecordsFromLegacyLog(storePath);
  }
  if (calls.length === 0) {
    return {
      activeCalls: new Map(),
      providerCallIdMap: new Map(),
      processedEventIds: new Set(),
      rejectedProviderCallIds: new Set(),
    };
  }
  const callMap = new Map<CallId, CallRecord>();
  for (const call of calls) {
    callMap.set(call.callId, call);
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
  storePath: string,
  limit = 50,
): Promise<CallRecord[]> {
  if (limit <= 0) {
    return [];
  }
  const stores = tryCreateCallRecordStateStores(storePath);
  if (stores) {
    try {
      return readCallRecordEvents(storePath, stores).slice(-limit);
    } catch (err) {
      console.error("[voice-call] Failed to read SQLite call history:", err);
    }
  }
  const logPath = resolveCallLogPath(storePath);
  const content = await privateFileStore(storePath).readTextIfExists(path.basename(logPath));
  if (content === null) {
    return [];
  }
  const lines = content.trim().split("\n").filter(Boolean);
  const calls: CallRecord[] = [];

  for (const [index, line] of lines.slice(-limit).entries()) {
    const parsed = parseCallRecordLine(line, index);
    if (parsed) {
      calls.push(parsed.call);
    }
  }

  return calls;
}

function readCallRecordsFromLegacyLog(storePath: string): CallRecord[] {
  const logPath = resolveCallLogPath(storePath);
  const content = privateFileStoreSync(storePath).readTextIfExists(path.basename(logPath));
  if (content === null) {
    return [];
  }
  return content
    .split("\n")
    .map((line, index) => parseCallRecordLine(line, index)?.call ?? null)
    .filter((call): call is CallRecord => call !== null);
}
