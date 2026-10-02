import { randomUUID } from "node:crypto";
import type { PluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import { getOptionalVoiceCallStateRuntime, type VoiceCallStateRuntime } from "../runtime-state.js";
import { CallRecordSchema, TerminalStates, type CallId, type CallRecord } from "../types.js";
import {
  MAX_CALL_REPLAY_KEYS,
  rememberManagerReplayKey,
  trimCallReplayKeys,
} from "./replay-keys.js";

export const CALL_RECORD_EVENTS_NAMESPACE = "call-record-events";
export const CALL_RECORD_EVENT_CHUNKS_NAMESPACE = "call-record-event-chunks";
export const MAX_CALL_RECORD_EVENTS = 1000;
/** Extra metadata entries retained so pruning can safely trim oldest rows. */
export const CALL_RECORD_EVENT_META_MAX_ENTRIES = MAX_CALL_RECORD_EVENTS + 100;
const MAX_CHUNKS_PER_CALL_RECORD_EVENT = 48;
export const CALL_RECORD_CHUNK_MAX_ENTRIES =
  MAX_CALL_RECORD_EVENTS * MAX_CHUNKS_PER_CALL_RECORD_EVENT + MAX_CHUNKS_PER_CALL_RECORD_EVENT;
/** Raw UTF-8 bytes stored per call record chunk before base64 encoding. */
const RAW_CALL_RECORD_CHUNK_BYTES = 47 * 1024;
const CALL_RECORD_READ_BATCH_KEYS = 128;
let callRecordEventSequence = 0;

export type CallRecordEventMeta = {
  chunkCount: number;
  byteLength: number;
  persistedAt?: number;
  sequence?: number;
};

export type CallRecordEventChunk = {
  index: number;
  dataBase64: string;
};

/** Call record plus stable ordering metadata read from persistence. */
type PersistedCallRecord = {
  call: CallRecord;
  persistedAt: number;
  sequence: number;
  orderKey: string;
};

type CallRecordStateStores = {
  events: PluginStateKeyedStore<CallRecordEventMeta>;
  chunks: PluginStateKeyedStore<CallRecordEventChunk>;
};

type CallRecordChunkResults = Awaited<
  ReturnType<NonNullable<CallRecordStateStores["chunks"]["lookupMany"]>>
>;

function createCallRecordStateStores(
  storePath: string,
  stateRuntime?: VoiceCallStateRuntime["state"],
): CallRecordStateStores {
  const state = stateRuntime ?? getOptionalVoiceCallStateRuntime()?.state;
  if (!state) {
    throw new Error("Voice Call state runtime not initialized");
  }
  const env = { ...process.env, OPENCLAW_STATE_DIR: storePath };
  return {
    events: state.openKeyedStore<CallRecordEventMeta>({
      namespace: CALL_RECORD_EVENTS_NAMESPACE,
      maxEntries: CALL_RECORD_EVENT_META_MAX_ENTRIES,
      env,
    }),
    chunks: state.openKeyedStore<CallRecordEventChunk>({
      namespace: CALL_RECORD_EVENT_CHUNKS_NAMESPACE,
      maxEntries: CALL_RECORD_CHUNK_MAX_ENTRIES,
      env,
    }),
  };
}

/** Open call stores and log failures instead of breaking restore paths. */
function tryCreateCallRecordStateStores(
  storePath: string,
  stateRuntime?: VoiceCallStateRuntime["state"],
): CallRecordStateStores | null {
  try {
    return createCallRecordStateStores(storePath, stateRuntime);
  } catch (err) {
    console.error("[voice-call] Failed to open SQLite call record store:", err);
    return null;
  }
}

export function buildChunkKey(eventKey: string, index: number): string {
  return `${eventKey}:chunk:${String(index).padStart(4, "0")}`;
}

/** Allocate monotonic ordering metadata for newly persisted call records. */
function nextCallRecordOrder(): { persistedAt: number; sequence: number } {
  const sequence = callRecordEventSequence;
  callRecordEventSequence = (callRecordEventSequence + 1) % 1_000_000;
  return { persistedAt: Date.now(), sequence };
}

function parseEventKeySequence(key: string): number {
  const match = /^event:[^:]+:(\d+):/.exec(key);
  const sequence = match?.[1];
  return sequence ? Number.parseInt(sequence, 10) : 0;
}

function countCallRecordChunks(call: CallRecord): number {
  return Math.max(
    1,
    Math.ceil(Buffer.byteLength(JSON.stringify(call), "utf8") / RAW_CALL_RECORD_CHUNK_BYTES),
  );
}

/** Truncate oversized call records to fit the bounded plugin state chunk budget. */
function prepareVoiceCallRecordForStorage(call: CallRecord): CallRecord {
  let boundedCall = call;
  if (call.processedEventIds.length > MAX_CALL_REPLAY_KEYS) {
    boundedCall = {
      ...call,
      processedEventIds: [...call.processedEventIds],
    };
    trimCallReplayKeys(boundedCall.processedEventIds);
  }
  if (countCallRecordChunks(boundedCall) <= MAX_CHUNKS_PER_CALL_RECORD_EVENT) {
    return boundedCall;
  }
  const transcriptEntries = boundedCall.transcript.length;
  const metadata = {
    ...boundedCall.metadata,
    voiceCallPersistence: {
      transcriptTruncated: true,
      originalTranscriptEntries: transcriptEntries,
    },
  };
  const candidateInputs = [
    { transcript: call.transcript.slice(-20), metadata },
    { transcript: [], metadata },
    {
      transcript: [],
      metadata: {
        voiceCallPersistence: {
          transcriptTruncated: true,
          originalTranscriptEntries: transcriptEntries,
          metadataTruncated: true,
        },
      },
    },
  ];
  for (const candidateInput of candidateInputs) {
    const candidate = CallRecordSchema.parse({
      ...boundedCall,
      ...candidateInput,
    });
    if (countCallRecordChunks(candidate) <= MAX_CHUNKS_PER_CALL_RECORD_EVENT) {
      return candidate;
    }
  }
  return boundedCall;
}

/** Encode one bounded record; chunks are produced only when requested by the writer. */
export function encodeCallRecordEvent(call: CallRecord) {
  const serialized = JSON.stringify(prepareVoiceCallRecordForStorage(call));
  const buffer = Buffer.from(serialized, "utf8");
  const chunkCount = Math.max(1, Math.ceil(buffer.byteLength / RAW_CALL_RECORD_CHUNK_BYTES));
  if (chunkCount > MAX_CHUNKS_PER_CALL_RECORD_EVENT) {
    throw new Error(
      `voice-call record exceeds SQLite chunk limit (${chunkCount}/${MAX_CHUNKS_PER_CALL_RECORD_EVENT})`,
    );
  }
  return {
    meta: { chunkCount, byteLength: buffer.byteLength },
    chunk(index: number): CallRecordEventChunk {
      const chunk = buffer.subarray(
        index * RAW_CALL_RECORD_CHUNK_BYTES,
        (index + 1) * RAW_CALL_RECORD_CHUNK_BYTES,
      );
      return { index, dataBase64: chunk.toString("base64") };
    },
  };
}

async function pruneCallRecordEvents(stores: CallRecordStateStores): Promise<void> {
  if (stores.events.count && (await stores.events.count()) <= MAX_CALL_RECORD_EVENTS) {
    return;
  }
  const rows = await stores.events.entries();
  if (rows.length <= MAX_CALL_RECORD_EVENTS) {
    return;
  }
  const sorted = rows.toSorted((a, b) => a.createdAt - b.createdAt || a.key.localeCompare(b.key));
  for (const row of sorted.slice(0, rows.length - MAX_CALL_RECORD_EVENTS)) {
    const meta = await stores.events.lookup(row.key);
    await stores.events.delete(row.key);
    if (meta) {
      for (let index = 0; index < meta.chunkCount; index += 1) {
        await stores.chunks.delete(buildChunkKey(row.key, index));
      }
    }
  }
}

function isValidCallRecordChunkCount(chunkCount: number): boolean {
  return (
    Number.isSafeInteger(chunkCount) &&
    chunkCount >= 1 &&
    chunkCount <= MAX_CHUNKS_PER_CALL_RECORD_EVENT
  );
}

async function readCallRecordEvent(
  stores: CallRecordStateStores,
  eventKey: string,
  meta: CallRecordEventMeta,
  records?: CallRecordChunkResults,
): Promise<CallRecord | null> {
  if (!isValidCallRecordChunkCount(meta.chunkCount)) {
    return null;
  }
  const chunks: Buffer[] = [];
  for (let index = 0; index < meta.chunkCount; index += 1) {
    const result = records?.[index];
    if (result && !result.ok) {
      throw result.error;
    }
    const chunk = records
      ? result?.value
      : await stores.chunks.lookup(buildChunkKey(eventKey, index));
    if (!chunk || chunk.index !== index) {
      return null;
    }
    chunks.push(Buffer.from(chunk.dataBase64, "base64"));
  }
  const serialized = Buffer.concat(chunks, meta.byteLength).toString("utf8");
  try {
    return CallRecordSchema.parse(JSON.parse(serialized));
  } catch {
    return null;
  }
}

/** Read all persisted call records in stable persisted order. */
async function readCallRecordEvents(stores: CallRecordStateStores): Promise<CallRecord[]> {
  const entries = (await stores.events.entries()).toSorted(
    (a, b) => a.createdAt - b.createdAt || a.key.localeCompare(b.key),
  );
  const sqliteCalls: PersistedCallRecord[] = [];
  let batchEnd = 0;
  let chunkOffset = 0;
  let chunkRecords: CallRecordChunkResults | undefined;
  for (const [entryIndex, entry] of entries.entries()) {
    if (entryIndex >= batchEnd && stores.chunks.lookupMany) {
      const keys: string[] = [];
      for (let next = entryIndex; ; next++) {
        const row = entries[next];
        if (!row) {
          break;
        }
        const chunkCount = row.value?.chunkCount;
        // Stop before malformed metadata so it cannot overtake an earlier chunk error.
        if (
          !isValidCallRecordChunkCount(chunkCount) ||
          keys.length + chunkCount > CALL_RECORD_READ_BATCH_KEYS
        ) {
          break;
        }
        for (let index = 0; index < chunkCount; index++) {
          keys.push(buildChunkKey(row.key, index));
        }
        batchEnd = next + 1;
      }
      chunkRecords = keys.length > 0 ? await stores.chunks.lookupMany(keys) : undefined;
      chunkOffset = 0;
    }
    // Published hosts without lookupMany keep their point-read path.
    const records = chunkRecords?.slice(chunkOffset, chunkOffset + entry.value.chunkCount);
    const call = await readCallRecordEvent(stores, entry.key, entry.value, records);
    if (chunkRecords) {
      chunkOffset += entry.value.chunkCount;
    }
    if (call) {
      sqliteCalls.push({
        call,
        persistedAt: entry.value.persistedAt ?? entry.createdAt,
        sequence: entry.value.sequence ?? parseEventKeySequence(entry.key),
        orderKey: entry.key,
      });
    }
  }
  return sqliteCalls
    .toSorted(
      (a, b) =>
        a.persistedAt - b.persistedAt ||
        a.sequence - b.sequence ||
        a.orderKey.localeCompare(b.orderKey),
    )
    .map((entry) => entry.call);
}

export async function persistCallRecord(
  storePath: string,
  call: CallRecord,
  stateRuntime?: VoiceCallStateRuntime["state"],
): Promise<void> {
  try {
    const stores = createCallRecordStateStores(storePath, stateRuntime);
    const order = nextCallRecordOrder();
    const eventKey = `event:${order.persistedAt.toString(36)}:${String(order.sequence).padStart(6, "0")}:${randomUUID()}`;
    // Capture the snapshot before chunk writes yield to later call mutations.
    const encoded = encodeCallRecordEvent(call);
    for (let index = 0; index < encoded.meta.chunkCount; index += 1) {
      await stores.chunks.register(buildChunkKey(eventKey, index), encoded.chunk(index));
    }
    await stores.events.register(eventKey, { ...encoded.meta, ...order });
    await pruneCallRecordEvents(stores);
  } catch (err) {
    console.error("[voice-call] Failed to persist call record:", err);
    throw err;
  }
}

/** Restore nonterminal active calls and event indexes from persisted records. */
export async function loadActiveCallsFromStore(
  storePath: string,
  stateRuntime?: VoiceCallStateRuntime["state"],
): Promise<{
  activeCalls: Map<CallId, CallRecord>;
  processedEventIds: Set<string>;
}> {
  const stores = tryCreateCallRecordStateStores(storePath, stateRuntime);
  let calls: CallRecord[] = [];
  try {
    calls = stores ? await readCallRecordEvents(stores) : [];
  } catch (err) {
    console.error("[voice-call] Failed to read SQLite call records:", err);
  }
  const callMap = new Map<CallId, CallRecord>();
  for (const call of calls) {
    // Reinsert so iteration follows the latest retained snapshot for each call.
    callMap.delete(call.callId);
    callMap.set(call.callId, call);
  }

  const activeCalls = new Map<CallId, CallRecord>();
  const processedEventIds = new Set<string>();

  for (const [callId, call] of callMap) {
    trimCallReplayKeys(call.processedEventIds);
    for (const eventId of call.processedEventIds) {
      rememberManagerReplayKey(processedEventIds, eventId);
    }
    if (TerminalStates.has(call.state)) {
      continue;
    }
    activeCalls.set(callId, call);
  }

  return { activeCalls, processedEventIds };
}

/** Resolve an internal ID or retained provider alias to its newest logical call snapshot. */
export async function findCallInStore(
  storePath: string,
  callId: string,
  stateRuntime?: VoiceCallStateRuntime["state"],
): Promise<CallRecord | undefined> {
  // Admission and status must distinguish unavailable history from an absent call.
  const calls = await readCallRecordEvents(createCallRecordStateStores(storePath, stateRuntime));
  const match =
    calls.findLast((call) => call.callId === callId) ??
    calls.findLast((call) => call.providerCallId === callId);
  return match ? calls.findLast((call) => call.callId === match.callId) : undefined;
}

export async function getCallHistoryFromStore(
  storePath: string,
  limit = 50,
  stateRuntime?: VoiceCallStateRuntime["state"],
): Promise<CallRecord[]> {
  if (limit <= 0) {
    return [];
  }
  const stores = tryCreateCallRecordStateStores(storePath, stateRuntime);
  if (stores) {
    try {
      return (await readCallRecordEvents(stores)).slice(-limit);
    } catch (err) {
      console.error("[voice-call] Failed to read SQLite call history:", err);
    }
  }
  return [];
}
