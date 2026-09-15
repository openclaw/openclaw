// Voice Call plugin module implements store behavior.
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import type { PluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import { getOptionalVoiceCallStateRuntime } from "../runtime-state.js";
import type { VoiceCallStateRuntime } from "../runtime-state.js";
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
const CALL_RECORD_READ_BATCH_KEYS = 128;
let callRecordEventSequence = 0;
// UUID event keys are unique across roots. Track only this process's live writes,
// not a queue: an earlier paused save must not hold up a later snapshot.
const pendingCallRecordEvents = new Set<string>();

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

type CallRecordChunkResults = Awaited<
  ReturnType<NonNullable<CallRecordStateStores["chunks"]["lookupMany"]>>
>;

/** Return the pre-SQLite JSONL call log path for migration/compat checks. */
export function resolveVoiceCallLegacyCallLogPath(storePath: string): string {
  return path.join(storePath, "calls.jsonl");
}

/** Build env for plugin state stores rooted at the voice-call store path. */
function resolvePluginStateEnv(storePath: string): NodeJS.ProcessEnv {
  return { ...process.env, OPENCLAW_STATE_DIR: storePath };
}

/** Open the plugin state stores when the runtime is available. */
function createCallRecordStateStores(
  storePath: string,
  stateRuntime?: VoiceCallStateRuntime["state"],
): CallRecordStateStores {
  const runtime = stateRuntime ? { state: stateRuntime } : getOptionalVoiceCallStateRuntime();
  if (!runtime) {
    throw new Error("Voice Call state runtime not initialized");
  }
  const env = resolvePluginStateEnv(storePath);
  return {
    events: runtime.state.openKeyedStore<CallRecordEventMeta>({
      namespace: CALL_RECORD_EVENTS_NAMESPACE,
      maxEntries: CALL_RECORD_EVENT_META_MAX_ENTRIES,
      overflowPolicy: "reject-new",
      env,
    }),
    chunks: runtime.state.openKeyedStore<CallRecordEventChunk>({
      namespace: CALL_RECORD_EVENT_CHUNKS_NAMESPACE,
      maxEntries: CALL_RECORD_CHUNK_MAX_ENTRIES,
      overflowPolicy: "reject-new",
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

/**
 * Publish metadata before chunks so every interrupted runtime write has an owner.
 * Independent row commits are not a transaction across the entire snapshot.
 */
async function registerCallRecordEvent(
  stores: CallRecordStateStores,
  eventKey: string,
  call: CallRecord,
  order: { persistedAt: number; sequence: number },
): Promise<void> {
  // Capture bytes and ordering before the first await, without serializing saves.
  const encoded = encodeCallRecordEvent(call);
  pendingCallRecordEvents.add(eventKey);
  try {
    await stores.events.register(eventKey, {
      ...encoded.meta,
      persistedAt: order.persistedAt,
      sequence: order.sequence,
    });
    try {
      for (let index = 0; index < encoded.meta.chunkCount; index += 1) {
        await stores.chunks.register(buildChunkKey(eventKey, index), encoded.chunk(index));
      }
    } catch (error) {
      try {
        await deleteCallRecordEventRows(stores, eventKey);
      } catch {
        // Keep metadata if cleanup fails; startup can retry. Preserve the write error.
      }
      throw error;
    }
    pendingCallRecordEvents.delete(eventKey);
    // A prune failure must not roll back the newly completed snapshot.
    await pruneCallRecordEvents(stores);
  } finally {
    pendingCallRecordEvents.delete(eventKey);
  }
}

/** Delete chunks before their metadata; failed cleanup remains discoverable. */
async function deleteCallRecordEventRows(
  stores: CallRecordStateStores,
  eventKey: string,
): Promise<void> {
  const meta = await stores.events.lookup(eventKey);
  if (!isValidCallRecordEventMeta(meta)) {
    // Unknown metadata cannot authorize a bounded deletion of its payload.
    return;
  }
  for (let index = 0; index < meta.chunkCount; index += 1) {
    await stores.chunks.delete(buildChunkKey(eventKey, index));
  }
  await stores.events.delete(eventKey);
}

/** Retain the newest complete snapshots, excluding live and interrupted saves. */
async function pruneCallRecordEvents(stores: CallRecordStateStores): Promise<void> {
  if (stores.events.count && (await stores.events.count()) <= MAX_CALL_RECORD_EVENTS) {
    return;
  }
  const rows = await stores.events.entries();
  if (rows.length <= MAX_CALL_RECORD_EVENTS) {
    return;
  }
  // Snapshot eligibility before any chunk read: a live write that finishes during
  // the scan must not count as a replacement for an already retained snapshot.
  const eligible = rows.filter(
    (row) => !pendingCallRecordEvents.has(row.key) && isValidCallRecordEventMeta(row.value),
  );
  const complete: typeof rows = [];
  for await (const { entry, call } of readCallRecordEventEntries(stores, eligible)) {
    if (call && !pendingCallRecordEvents.has(entry.key)) {
      complete.push(entry);
    }
  }
  const sorted = complete.toSorted(
    (a, b) =>
      (a.value.persistedAt ?? a.createdAt) - (b.value.persistedAt ?? b.createdAt) ||
      (a.value.sequence ?? parseEventKeySequence(a.key)) -
        (b.value.sequence ?? parseEventKeySequence(b.key)) ||
      a.key.localeCompare(b.key),
  );
  for (const row of sorted.slice(0, Math.max(0, sorted.length - MAX_CALL_RECORD_EVENTS))) {
    await deleteCallRecordEventRows(stores, row.key);
  }
}

/** Shared read-only completion check for runtime retention and Doctor admission. */
export async function hasCompleteCallRecordEvent(
  stores: CallRecordStateStores,
  eventKey: string,
  meta: unknown,
): Promise<boolean> {
  return (
    !pendingCallRecordEvents.has(eventKey) &&
    isValidCallRecordEventMeta(meta) &&
    Boolean(await readCallRecordEvent(stores, eventKey, meta))
  );
}

function isValidCallRecordEventMeta(meta: unknown): meta is CallRecordEventMeta {
  if (!meta || typeof meta !== "object" || !("chunkCount" in meta) || !("byteLength" in meta)) {
    return false;
  }
  return (
    typeof meta.chunkCount === "number" &&
    isValidCallRecordChunkCount(meta.chunkCount) &&
    typeof meta.byteLength === "number" &&
    Number.isSafeInteger(meta.byteLength) &&
    meta.byteLength > (meta.chunkCount - 1) * RAW_CALL_RECORD_CHUNK_BYTES &&
    meta.byteLength <= meta.chunkCount * RAW_CALL_RECORD_CHUNK_BYTES
  );
}

/** Identify rows startup can reclaim; unknown owners and complete payloads stay protected. */
export function isInterruptedCallRecordEvent(
  eventKey: string,
  meta: unknown,
  storedChunkKeys: ReadonlySet<string>,
): boolean {
  if (
    !eventKey.startsWith("event:") ||
    pendingCallRecordEvents.has(eventKey) ||
    !isValidCallRecordEventMeta(meta)
  ) {
    return false;
  }
  for (let index = 0; index < meta.chunkCount; index++) {
    if (!storedChunkKeys.has(buildChunkKey(eventKey, index))) {
      return true;
    }
  }
  return false;
}

/**
 * Reclaim only interrupted runtime events. Doctor owns jsonl: prefixes and may
 * replay them from retained source; history/status must never invoke this work.
 */
async function reconcileCallRecordEventRows(stores: CallRecordStateStores): Promise<void> {
  // Keep writes protected even if they finish between the two inventory reads.
  const liveAtInventory = new Set(pendingCallRecordEvents);
  const events = await stores.events.entries();
  const inventoriedEventKeys = new Set(events.map((entry) => entry.key));
  for (const key of pendingCallRecordEvents) {
    liveAtInventory.add(key);
  }
  // The public namespace API returns rows; retain only keys after that read.
  const storedChunkKeys = new Set((await stores.chunks.entries()).map((entry) => entry.key));
  for (const entry of events) {
    if (
      liveAtInventory.has(entry.key) ||
      !isInterruptedCallRecordEvent(entry.key, entry.value, storedChunkKeys)
    ) {
      continue;
    }
    await deleteCallRecordEventRows(stores, entry.key);
  }
  for (const chunkKey of storedChunkKeys) {
    const eventKey = /^(event:[^:]+:[0-9]+:[^:]+):chunk:[0-9]{4}$/.exec(chunkKey)?.[1];
    if (!eventKey || inventoriedEventKeys.has(eventKey) || pendingCallRecordEvents.has(eventKey)) {
      continue;
    }
    // Inventoried owners were handled above, including malformed rows that must
    // stay intact. Only unowned candidates need fresh point reads.
    // A writer may have published after the inventory read. Recheck ownership
    // on the original store; new runtime events always publish metadata first.
    const meta = await stores.events.lookup(eventKey);
    if (meta === undefined && !pendingCallRecordEvents.has(eventKey)) {
      await stores.chunks.delete(chunkKey);
    }
  }
  await pruneCallRecordEvents(stores);
}

function isValidCallRecordChunkCount(chunkCount: number): boolean {
  return (
    Number.isSafeInteger(chunkCount) &&
    chunkCount >= 1 &&
    chunkCount <= MAX_CHUNKS_PER_CALL_RECORD_EVENT
  );
}

/** Read and reassemble one chunked call record event. */
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
  return parseVoiceCallRecordLine(serialized)?.call ?? null;
}

/** Decode bounded batches in entry order without letting a later error overtake an earlier row. */
async function* readCallRecordEventEntries(
  stores: CallRecordStateStores,
  entries: Awaited<ReturnType<CallRecordStateStores["events"]["entries"]>>,
) {
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
    yield { entry, call };
  }
}

/** Read all persisted call records in stable persisted order. */
async function readCallRecordEvents(stores: CallRecordStateStores): Promise<CallRecord[]> {
  const entries = (await stores.events.entries()).toSorted(
    (a, b) => a.createdAt - b.createdAt || a.key.localeCompare(b.key),
  );
  const sqliteCalls: PersistedCallRecord[] = [];
  for await (const { entry, call } of readCallRecordEventEntries(stores, entries)) {
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
export async function persistCallRecord(
  storePath: string,
  call: CallRecord,
  stateRuntime?: VoiceCallStateRuntime["state"],
): Promise<void> {
  try {
    const stores = createCallRecordStateStores(storePath, stateRuntime);
    const order = nextCallRecordOrder();
    await registerCallRecordEvent(stores, buildNewEventKey(order), call, order);
  } catch (err) {
    console.error("[voice-call] Failed to persist call record:", err);
    throw err;
  }
}

/** Restore nonterminal active calls and provider/event indexes from persisted records. */
export async function loadActiveCallsFromStore(
  storePath: string,
  stateRuntime?: VoiceCallStateRuntime["state"],
): Promise<{
  activeCalls: Map<CallId, CallRecord>;
  providerCallIdMap: Map<string, CallId>;
  processedEventIds: Set<string>;
}> {
  const stores = tryCreateCallRecordStateStores(storePath, stateRuntime);
  let calls: CallRecord[] = [];
  if (stores) {
    try {
      await reconcileCallRecordEventRows(stores);
    } catch (err) {
      console.error("[voice-call] Failed to reconcile call record rows:", err);
    }
  }
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

async function readCallHistoryFromStore(
  storePath: string,
  stateRuntime?: VoiceCallStateRuntime["state"],
): Promise<CallRecord[]> {
  const stores = tryCreateCallRecordStateStores(storePath, stateRuntime);
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
  stateRuntime?: VoiceCallStateRuntime["state"],
): Promise<CallRecord | undefined> {
  // Admission and status must distinguish unavailable history from an absent call.
  const calls = await readCallRecordEvents(createCallRecordStateStores(storePath, stateRuntime));
  const match =
    calls.findLast((call) => call.callId === callId) ??
    calls.findLast((call) => call.providerCallId === callId);
  return match ? calls.findLast((call) => call.callId === match.callId) : undefined;
}

/** Return the newest persisted call history rows up to the requested limit. */
export async function getCallHistoryFromStore(
  storePath: string,
  limit = 50,
  stateRuntime?: VoiceCallStateRuntime["state"],
): Promise<CallRecord[]> {
  if (limit <= 0) {
    return [];
  }
  return (await readCallHistoryFromStore(storePath, stateRuntime)).slice(-limit);
}
