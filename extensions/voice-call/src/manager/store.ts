// Voice Call plugin module implements store behavior.
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import type { PluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import { getOptionalVoiceCallStateRuntime } from "../runtime-state.js";
import { CallRecordSchema, TerminalStates, type CallId, type CallRecord } from "../types.js";
import {
  MAX_CALL_REPLAY_KEYS,
  rememberManagerReplayKey,
  trimCallReplayKeys,
} from "./replay-keys.js";

// Persistent voice-call event store backed by plugin state chunk records.

/** Plugin state namespace for call record event metadata. */
export const CALL_RECORD_EVENTS_NAMESPACE = "call-record-events";
/** Plugin state namespace for base64 call record event chunks. */
export const CALL_RECORD_EVENT_CHUNKS_NAMESPACE = "call-record-event-chunks";
/** Maximum retained call record events. */
export const MAX_CALL_RECORD_EVENTS = 1000;
/** Extra metadata entries retained so pruning can safely trim oldest rows. */
export const CALL_RECORD_EVENT_META_MAX_ENTRIES = MAX_CALL_RECORD_EVENTS + 100;
/** Maximum chunks allowed for one persisted call record event. */
const MAX_CHUNKS_PER_CALL_RECORD_EVENT = 48;
export const CALL_RECORD_CHUNK_MAX_ENTRIES =
  MAX_CALL_RECORD_EVENTS * MAX_CHUNKS_PER_CALL_RECORD_EVENT + MAX_CHUNKS_PER_CALL_RECORD_EVENT;
/** Raw UTF-8 bytes stored per call record chunk before base64 encoding. */
const RAW_CALL_RECORD_CHUNK_BYTES = 47 * 1024;
let callRecordEventSequence = 0;

/** Metadata row for a chunked call record event. */
export type CallRecordEventMeta = {
  chunkCount: number;
  byteLength: number;
  persistedAt?: number;
  sequence?: number;
};

/** One base64 chunk for a serialized call record event. */
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

/** Pair of plugin state stores used for call record events. */
type CallRecordStateStores = {
  events: PluginStateKeyedStore<CallRecordEventMeta>;
  chunks: PluginStateKeyedStore<CallRecordEventChunk>;
};

/** Return the pre-SQLite JSONL call log path for migration/compat checks. */
export function resolveVoiceCallLegacyCallLogPath(storePath: string): string {
  return path.join(storePath, "calls.jsonl");
}

/** Build env for plugin state stores rooted at the voice-call store path. */
function resolvePluginStateEnv(storePath: string): NodeJS.ProcessEnv {
  return { ...process.env, OPENCLAW_STATE_DIR: storePath };
}

/** Open the plugin state stores when the runtime is available. */
function createCallRecordStateStores(storePath: string): CallRecordStateStores {
  const runtime = getOptionalVoiceCallStateRuntime();
  if (!runtime) {
    throw new Error("Voice Call state runtime not initialized");
  }
  const env = resolvePluginStateEnv(storePath);
  return {
    events: runtime.state.openKeyedStore<CallRecordEventMeta>({
      namespace: CALL_RECORD_EVENTS_NAMESPACE,
      maxEntries: CALL_RECORD_EVENT_META_MAX_ENTRIES,
      env,
    }),
    chunks: runtime.state.openKeyedStore<CallRecordEventChunk>({
      namespace: CALL_RECORD_EVENT_CHUNKS_NAMESPACE,
      maxEntries: CALL_RECORD_CHUNK_MAX_ENTRIES,
      env,
    }),
  };
}

/** Open call stores and log failures instead of breaking restore paths. */
function tryCreateCallRecordStateStores(storePath: string): CallRecordStateStores | null {
  try {
    return createCallRecordStateStores(storePath);
  } catch (err) {
    console.error("[voice-call] Failed to open SQLite call record store:", err);
    return null;
  }
}

/** Build the stable storage key for one chunk of an event. */
export function buildChunkKey(eventKey: string, index: number): string {
  return `${eventKey}:chunk:${String(index).padStart(4, "0")}`;
}

/** Build a deterministic key for one legacy JSONL line. */
export function buildVoiceCallLegacyJsonlEventKey(line: string, index: number): string {
  return `jsonl:${String(index).padStart(8, "0")}:${createHash("sha256").update(line).digest("hex")}`;
}

/** Allocate monotonic ordering metadata for newly persisted call records. */
function nextCallRecordOrder(): { persistedAt: number; sequence: number } {
  const sequence = callRecordEventSequence;
  callRecordEventSequence = (callRecordEventSequence + 1) % 1_000_000;
  return { persistedAt: Date.now(), sequence };
}

/** Build a unique event key that preserves timestamp and sequence ordering. */
function buildNewEventKey(order: { persistedAt: number; sequence: number }): string {
  return `event:${order.persistedAt.toString(36)}:${String(order.sequence).padStart(6, "0")}:${randomUUID()}`;
}

/** Recover the sequence segment from newer event keys. */
function parseEventKeySequence(key: string): number {
  const match = /^event:[^:]+:(\d+):/.exec(key);
  const sequence = match?.[1];
  return sequence ? Number.parseInt(sequence, 10) : 0;
}

/** Parse a stored call record line from v2 envelope or legacy raw-call JSON. */
export function parseVoiceCallRecordLine(line: string, sequence = 0): PersistedCallRecord | null {
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

/** Count storage chunks needed for a call record. */
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

/** Register a serialized call record event and its chunks, then prune old events. */
async function registerCallRecordEvent(
  stores: CallRecordStateStores,
  eventKey: string,
  call: CallRecord,
  order: { persistedAt: number; sequence: number },
): Promise<void> {
  // Capture the snapshot before chunk writes yield to later call mutations.
  const encoded = encodeCallRecordEvent(call);
  for (let index = 0; index < encoded.meta.chunkCount; index += 1) {
    await stores.chunks.register(buildChunkKey(eventKey, index), encoded.chunk(index));
  }
  await stores.events.register(eventKey, {
    ...encoded.meta,
    persistedAt: order.persistedAt,
    sequence: order.sequence,
  });
  await pruneCallRecordEvents(stores);
}

/** Delete metadata and all chunk rows for one call record event. */
async function deleteCallRecordEventRows(
  stores: CallRecordStateStores,
  eventKey: string,
): Promise<void> {
  const meta = await stores.events.lookup(eventKey);
  await stores.events.delete(eventKey);
  if (!meta) {
    return;
  }
  for (let index = 0; index < meta.chunkCount; index += 1) {
    await stores.chunks.delete(buildChunkKey(eventKey, index));
  }
}

/** Keep only the newest bounded call record events. */
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
    await deleteCallRecordEventRows(stores, row.key);
  }
}

/** Read and reassemble one chunked call record event. */
async function readCallRecordEvent(
  stores: CallRecordStateStores,
  eventKey: string,
  meta: CallRecordEventMeta,
): Promise<CallRecord | null> {
  if (
    !Number.isSafeInteger(meta.chunkCount) ||
    meta.chunkCount < 1 ||
    meta.chunkCount > MAX_CHUNKS_PER_CALL_RECORD_EVENT
  ) {
    return null;
  }
  // Preserve compatibility with published hosts exposing point reads only.
  const records = await stores.chunks.lookupMany?.(
    Array.from({ length: meta.chunkCount }, (_, index) => buildChunkKey(eventKey, index)),
  );
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
  return parseVoiceCallRecordLine(serialized)?.call ?? null;
}

/** Read all persisted call records in stable persisted order. */
async function readCallRecordEvents(stores: CallRecordStateStores): Promise<CallRecord[]> {
  const entries = (await stores.events.entries()).toSorted(
    (a, b) => a.createdAt - b.createdAt || a.key.localeCompare(b.key),
  );
  const sqliteCalls: PersistedCallRecord[] = [];
  for (const entry of entries) {
    const call = await readCallRecordEvent(stores, entry.key, entry.value);
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

/** Persist one call record event to plugin state. */
export async function persistCallRecord(storePath: string, call: CallRecord): Promise<void> {
  try {
    const stores = createCallRecordStateStores(storePath);
    const order = nextCallRecordOrder();
    await registerCallRecordEvent(stores, buildNewEventKey(order), call, order);
  } catch (err) {
    console.error("[voice-call] Failed to persist call record:", err);
    throw err;
  }
}

/** Restore nonterminal active calls and provider/event indexes from persisted records. */
export async function loadActiveCallsFromStore(storePath: string): Promise<{
  activeCalls: Map<CallId, CallRecord>;
  providerCallIdMap: Map<string, CallId>;
  processedEventIds: Set<string>;
}> {
  const stores = tryCreateCallRecordStateStores(storePath);
  let calls: CallRecord[] = [];
  try {
    calls = stores ? await readCallRecordEvents(stores) : [];
  } catch (err) {
    console.error("[voice-call] Failed to read SQLite call records:", err);
  }
  if (calls.length === 0) {
    return {
      activeCalls: new Map(),
      providerCallIdMap: new Map(),
      processedEventIds: new Set(),
    };
  }
  const callMap = new Map<CallId, CallRecord>();
  for (const call of calls) {
    // Reinsert so iteration follows the latest retained snapshot for each call.
    callMap.delete(call.callId);
    callMap.set(call.callId, call);
  }

  const activeCalls = new Map<CallId, CallRecord>();
  const providerCallIdMap = new Map<string, CallId>();
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
    if (call.providerCallId) {
      providerCallIdMap.set(call.providerCallId, callId);
    }
  }

  return { activeCalls, providerCallIdMap, processedEventIds };
}

async function readCallHistoryFromStore(storePath: string): Promise<CallRecord[]> {
  const stores = tryCreateCallRecordStateStores(storePath);
  if (stores) {
    try {
      return await readCallRecordEvents(stores);
    } catch (err) {
      console.error("[voice-call] Failed to read SQLite call history:", err);
    }
  }
  return [];
}

/** Resolve an internal ID or retained provider alias to its newest logical call snapshot. */
export async function findCallInStore(
  storePath: string,
  callId: string,
): Promise<CallRecord | undefined> {
  // Admission and status must distinguish unavailable history from an absent call.
  const calls = await readCallRecordEvents(createCallRecordStateStores(storePath));
  const match =
    calls.findLast((call) => call.callId === callId) ??
    calls.findLast((call) => call.providerCallId === callId);
  return match ? calls.findLast((call) => call.callId === match.callId) : undefined;
}

/** Return the newest persisted call history rows up to the requested limit. */
export async function getCallHistoryFromStore(
  storePath: string,
  limit = 50,
): Promise<CallRecord[]> {
  if (limit <= 0) {
    return [];
  }
  return (await readCallHistoryFromStore(storePath)).slice(-limit);
}
