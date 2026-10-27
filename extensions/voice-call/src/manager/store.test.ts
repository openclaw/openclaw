import fs from "node:fs";
import path from "node:path";
import { Command } from "commander";
import { expectDefined } from "openclaw/plugin-sdk/expect-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type { OpenAsyncKeyedStoreOptions } from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  createPluginStateKeyedStoreForTests,
  importPluginStateEntriesForDoctorForTests,
  openOpenClawStateDatabase,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { closeOpenClawStateDatabaseAsync } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { registerVoiceCallLogs } from "../cli-call-log.js";
import {
  createTestStorePath,
  createVoiceCallStateRuntimeForTests,
  makePersistedCall,
} from "../manager.test-harness.js";
import { setVoiceCallStateRuntime } from "../runtime-state.js";
import { CallRecordSchema, type CallRecord } from "../types.js";
import { MAX_CALL_REPLAY_KEYS } from "./replay-keys.js";
import {
  findCallInStore as findCall,
  getCallHistoryFromStore as history,
  loadActiveCallsFromStore as restore,
  persistCallRecord,
} from "./store.js";

const { sleepMock } = vi.hoisted(() => ({ sleepMock: vi.fn() }));
vi.mock("../../api.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api.js")>()),
  sleep: sleepMock,
}));

// These names are persisted storage contracts, independent of private store declarations.
const EVENTS = "call-record-events";
const CHUNKS = "call-record-event-chunks";
const CHUNK_LIMIT = 48_048;
const REPLAY_LIMIT = 10_000;
type StoreDatabase = ReturnType<typeof openOpenClawStateDatabase>["db"];
type Operation = "register" | "entries" | "count";
const updateJson = (db: StoreDatabase, namespace: string, key: string, json: string) =>
  db
    .prepare(
      "UPDATE plugin_state_entries SET value_json = ? WHERE plugin_id = 'voice-call' AND namespace = ? AND entry_key = ?",
    )
    .run(json, namespace, key);

async function closeStore() {
  await closeOpenClawStateDatabaseAsync();
  resetPluginStateStoreForTests();
}

function installStateRuntime({
  beforeOperation,
  onChunkRead,
}: {
  beforeOperation?: (namespace: string, operation: Operation) => Promise<void>;
  onChunkRead?: (keys: readonly string[]) => void;
} = {}): void {
  const state = createVoiceCallStateRuntimeForTests();
  setVoiceCallStateRuntime({
    state: {
      ...state,
      openKeyedStoreV2: <T>(options: OpenAsyncKeyedStoreOptions) => {
        const backingStore = state.openKeyedStoreV2<T>(options);
        if (onChunkRead && options.namespace === CHUNKS) {
          return {
            ...backingStore,
            async lookupMany(keys: readonly string[]) {
              const rows = await backingStore.lookupMany(keys);
              onChunkRead(keys);
              return rows;
            },
          };
        }
        if (!beforeOperation) {
          return backingStore;
        }
        const run = async <R>(operation: Operation, effect: () => Promise<R>) => {
          await beforeOperation(options.namespace, operation);
          return effect();
        };
        return {
          ...backingStore,
          register: (...args: Parameters<typeof backingStore.register>) =>
            run("register", () => backingStore.register(...args)),
          entries: () => run("entries", () => backingStore.entries()),
          count: () => run("count", () => backingStore.count()),
        };
      },
    },
  });
}

async function mutateOfflineCallStore(
  storePath: string,
  mutate: (db: StoreDatabase) => void,
): Promise<void> {
  await closeStore();
  const databasePath = path.join(storePath, "state", "openclaw.sqlite");
  const replacementPath = `${databasePath}.corruption-fixture`;
  // A cold physical copy models restart corruption without stale in-process write receipts.
  fs.copyFileSync(databasePath, replacementPath, fs.constants.COPYFILE_EXCL);
  fs.renameSync(replacementPath, databasePath);
  try {
    mutate(openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: storePath } }).db);
  } finally {
    await closeStore();
  }
}

const makeCall = (overrides: Partial<CallRecord> = {}) =>
  CallRecordSchema.parse(makePersistedCall(overrides));
const transcript = (text: string, timestamp = Date.now()): CallRecord["transcript"] => [
  { timestamp, speaker: "user", text, isFinal: true },
];

let storePath: string;
const saveCall = async (callId: string, overrides: Partial<CallRecord> = {}) => {
  const call = makeCall({ callId, ...overrides });
  await persistCallRecord(storePath, call);
  return call;
};
const openStore = <T>(namespace: string, maxEntries: number) =>
  createPluginStateKeyedStoreForTests<T>("voice-call", {
    namespace,
    maxEntries,
    env: { ...process.env, OPENCLAW_STATE_DIR: storePath },
  });
const corruptRow = (namespace: string, key: string, value: unknown) =>
  mutateOfflineCallStore(storePath, (db) => updateJson(db, namespace, key, JSON.stringify(value)));
const expectHistory = async (calls: CallRecord[], limit?: number) =>
  expect(await history(storePath, limit)).toEqual(calls);
beforeEach(() => {
  resetPluginStateStoreForTests();
  installStateRuntime();
  storePath = createTestStorePath();
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  await closeStore();
});

it.each([0, 1])("honors SQLite tail --since %s before following new snapshots", async (since) => {
  for (const callId of ["first", "second", "third"]) {
    await saveCall(callId);
  }
  const added = makeCall({ callId: "new" });
  const stopped = new Error("SQLite tail test finished");
  sleepMock
    .mockReset()
    .mockRejectedValue(stopped)
    .mockImplementationOnce(async () => {
      await persistCallRecord(storePath, added);
    });
  let output = "";
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    output += String(chunk);
    return true;
  });
  const program = new Command();
  registerVoiceCallLogs({
    root: program,
    defaultFile: path.join(storePath, "calls.jsonl"),
    ensureHistoryStateRuntime: installStateRuntime,
  });
  await expect(
    program.parseAsync(["tail", "--since", String(since)], { from: "user" }),
  ).rejects.toBe(stopped);
  expect(
    output
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line).callId),
  ).toEqual(since === 0 ? ["new"] : ["third", "new"]);
});

it("bounds bulk chunk reads across retained call snapshots", async () => {
  const calls = Array.from({ length: 129 }, (_, index) =>
    makeCall({
      callId: `call-batch-${index}`,
      providerCallId: `provider-batch-${index}`,
      processedEventIds: [`event-${index}`],
      transcript: index === 127 ? transcript("x".repeat(110_000), 1) : [],
    }),
  );
  for (const call of calls) {
    await persistCallRecord(storePath, call);
  }
  resetPluginStateStoreForTests();
  const chunkQueries: string[][] = [];
  installStateRuntime({ onChunkRead: (keys) => chunkQueries.push([...keys]) });
  await expectHistory(calls, calls.length);
  expect(chunkQueries.length).toBeLessThanOrEqual(2);
  expect(chunkQueries.every((keys) => keys.length <= 128)).toBe(true);
  const eventsPerQuery = chunkQueries.map(
    (keys) => new Set(keys.map((key) => key.split(":chunk:")[0])),
  );
  expect(eventsPerQuery.reduce((count, events) => count + events.size, 0)).toBe(calls.length);
  const restored = await restore(storePath);
  expect([...restored.activeCalls.values()]).toEqual(calls);
  expect([...restored.processedEventIds]).toEqual(calls.flatMap((call) => call.processedEventIds));
  expect(await findCall(storePath, "provider-batch-127")).toEqual(calls[127]);
});

it("preserves errors before later malformed metadata", async () => {
  for (const callId of ["earlier", "later"]) {
    await saveCall(callId);
  }
  const events = openStore<{ chunkCount: number; sequence: number }>(EVENTS, 1100);
  const rows = (await events.entries()).toSorted((a, b) => a.value.sequence - b.value.sequence);
  const first = expectDefined(rows[0], "earlier persisted event");
  const second = expectDefined(rows[1], "later persisted event");
  await mutateOfflineCallStore(storePath, (db) => {
    const timestamp = db.prepare(
      "UPDATE plugin_state_entries SET created_at = ? WHERE namespace = ? AND entry_key = ?",
    );
    timestamp.run(1, EVENTS, first.key);
    timestamp.run(2, EVENTS, second.key);
    updateJson(db, EVENTS, second.key, "null");
    updateJson(db, CHUNKS, `${first.key}:chunk:0000`, "invalid JSON");
  });
  await expect(findCall(storePath, "later")).rejects.toThrowError(
    expect.objectContaining({ code: "PLUGIN_STATE_CORRUPT" }),
  );
  await corruptRow(CHUNKS, `${first.key}:chunk:0000`, { index: -1, dataBase64: "" });
  await expect(findCall(storePath, "later")).rejects.toBeInstanceOf(TypeError);
  await corruptRow(EVENTS, second.key, { chunkCount: 0, byteLength: 0 });
  await expectHistory([]);
});

it("ignores incomplete chunks but surfaces corruption in a complete record", async () => {
  await saveCall("call-chunked", { transcript: transcript("🦞".repeat(180_000)) });
  resetPluginStateStoreForTests();
  const openChunks = () => openStore<{ index: number; dataBase64: string }>(CHUNKS, CHUNK_LIMIT);
  let chunks = openChunks();
  const rows = await chunks.entries();
  const chunk = (index: number) =>
    expectDefined(
      rows.find((row) => row.value.index === index),
      `chunk ${index}`,
    );
  const first = chunk(0);
  const later = chunk(1);
  const good = await saveCall("good-call", { transcript: [] });
  await mutateOfflineCallStore(storePath, (db) =>
    updateJson(db, CHUNKS, later.key, "invalid JSON"),
  );
  chunks = openChunks();
  await chunks.register(first.key, { ...first.value, index: -1 });
  await expectHistory([good]);
  expect(await findCall(storePath, good.callId)).toEqual(good);
  await chunks.delete(first.key);
  await expectHistory([good]);
  await chunks.register(first.key, first.value);
  await expect(findCall(storePath, good.callId)).rejects.toThrowError(
    expect.objectContaining({ code: "PLUGIN_STATE_CORRUPT" }),
  );
});

it.each([
  { namespace: CHUNKS, failedWrite: 1, delayed: false },
  { namespace: CHUNKS, failedWrite: 2, delayed: false },
  { namespace: EVENTS, failedWrite: 1, delayed: true },
])(
  "does not publish after $namespace write $failedWrite fails (delayed=$delayed)",
  async ({ namespace, failedWrite, delayed }) => {
    const call = makeCall({
      transcript: transcript(delayed ? "🦞".repeat(30_000) : "x".repeat(100_000), 1),
    });
    const failure = new Error("chunk or metadata write failed");
    let writes = 0;
    installStateRuntime({
      beforeOperation: async (target, operation) => {
        if (delayed) {
          await Promise.resolve();
        }
        if (operation === "register" && target === namespace && ++writes === failedWrite) {
          throw failure;
        }
      },
    });
    await expect(persistCallRecord(storePath, call)).rejects.toBe(failure);
    installStateRuntime();
    resetPluginStateStoreForTests();
    expect((await restore(storePath)).activeCalls.size).toBe(0);
    await expectHistory([]);
    await expect(findCall(storePath, call.callId)).resolves.toBeUndefined();
  },
);

it("persists oversized records in SQLite without creating a JSONL fallback", async () => {
  const call = await saveCall("call-large", {
    metadata: { mode: "conversation", numberRouteKey: "+15550000001" },
    transcript: transcript("x".repeat(3 * 1024 * 1024)),
  });

  expect((await restore(storePath)).activeCalls.get(call.callId)).toMatchObject({
    providerCallId: call.providerCallId,
    transcript: [],
    metadata: {
      mode: "conversation",
      numberRouteKey: "+15550000001",
      voiceCallPersistence: { transcriptTruncated: true },
    },
  });
  expect(fs.existsSync(path.join(storePath, "calls.jsonl"))).toBe(false);
});

it("prunes old snapshot chunks while retaining later in-process call updates", async () => {
  const env = { OPENCLAW_STATE_DIR: storePath };
  const seeded = makeCall({ callId: "call-seeded" });
  const bytes = Buffer.from(JSON.stringify(seeded));
  const eventRows = Array.from({ length: 1_000 }, (_, index) => ({
    key: `seed:${String(index).padStart(4, "0")}`,
    createdAt: index + 1,
    value: { chunkCount: index === 0 ? 2 : 1, byteLength: bytes.length },
  }));
  importPluginStateEntriesForDoctorForTests(
    "voice-call",
    { namespace: EVENTS, maxEntries: 1_100, env },
    eventRows,
  );
  importPluginStateEntriesForDoctorForTests(
    "voice-call",
    { namespace: CHUNKS, maxEntries: CHUNK_LIMIT, env },
    eventRows.flatMap((row) => {
      const chunks =
        row.value.chunkCount === 2 ? [bytes.subarray(0, 1), bytes.subarray(1)] : [bytes];
      return chunks.map((chunk, index) => ({
        key: `${row.key}:chunk:${String(index).padStart(4, "0")}`,
        createdAt: row.createdAt,
        value: { index, dataBase64: chunk.toString("base64") },
      }));
    }),
  );
  await closeStore();

  const first = await saveCall("call-current", { state: "ringing" });
  expect(await findCall(storePath, first.callId)).toEqual(first);
  const latest = { ...first, state: "answered" as const };
  await persistCallRecord(storePath, latest);
  await expectHistory([first, latest], 2);
  expect(await findCall(storePath, first.callId)).toEqual(latest);

  const state = createVoiceCallStateRuntimeForTests();
  const events = state.openKeyedStoreV2({ namespace: EVENTS, maxEntries: 1_100, env });
  const chunks = state.openKeyedStoreV2({ namespace: CHUNKS, maxEntries: CHUNK_LIMIT, env });
  await expect(events.count()).resolves.toBe(1_000);
  await expect(chunks.count()).resolves.toBe(1_000);
  await expect(chunks.lookup("seed:0000:chunk:0000")).resolves.toBeUndefined();
  await expect(chunks.lookup("seed:0000:chunk:0001")).resolves.toBeUndefined();
  await expect(chunks.lookup("seed:0001:chunk:0000")).resolves.toBeUndefined();
});

it("captures call bytes and write order before a delayed chunk publishes", async () => {
  vi.useFakeTimers({ now: new Date("2026-05-31T10:00:00.000Z") });
  const blocked = createDeferred<void>();
  const release = createDeferred<void>();
  let delayed = false;
  installStateRuntime({
    beforeOperation: async (namespace, operation) => {
      if (!delayed && namespace === CHUNKS && operation === "register") {
        delayed = true;
        blocked.resolve();
        await release.promise;
      }
    },
  });
  const first = makeCall({
    callId: "call-delayed",
    state: "ringing",
    transcript: transcript("🦞".repeat(30_000)),
  });
  const expectedFirst = structuredClone(first);
  const pending = persistCallRecord(storePath, first);
  try {
    await blocked.promise;
    await expectHistory([]);
    expectDefined(first.transcript[0], "first transcript entry").text =
      "mutated after persistence started";
    first.state = "answered";
    await persistCallRecord(storePath, first);
    await expectHistory([first]);
  } finally {
    release.resolve();
    await pending;
  }
  resetPluginStateStoreForTests();
  await expectHistory([expectedFirst, first]);
  expect((await restore(storePath)).activeCalls.get(first.callId)?.state).toBe("answered");
});

it("propagates pruning rejection and preserves restore versus status read errors", async () => {
  const call = makeCall({ callId: "call-read-error" });
  const failure = new Error("delayed SQLite read rejected");
  installStateRuntime({
    beforeOperation: async (_namespace, operation) => {
      await Promise.resolve();
      if (operation === "entries" || operation === "count") {
        throw failure;
      }
    },
  });
  await expect(persistCallRecord(storePath, call)).rejects.toBe(failure);
  await expectHistory([]);
  expect((await restore(storePath)).activeCalls.size).toBe(0);
  await expect(findCall(storePath, call.callId)).rejects.toBe(failure);
  installStateRuntime();
  resetPluginStateStoreForTests();
  await expect(findCall(storePath, call.callId)).resolves.toEqual(call);
});

it("persists and restores only the newest per-call replay keys", async () => {
  const replayKeys = Array.from({ length: MAX_CALL_REPLAY_KEYS + 2 }, (_, i) => `evt-${i}`);
  await saveCall("call-bounded-replay", { processedEventIds: replayKeys });

  const restored = await restore(storePath);
  const expected = replayKeys.slice(-MAX_CALL_REPLAY_KEYS);
  expect(restored.activeCalls.get("call-bounded-replay")?.processedEventIds).toEqual(expected);
  expect([...restored.processedEventIds]).toEqual(expected);
});

it("hydrates manager replay keys in latest-snapshot call order", async () => {
  await saveCall("call-latest", {
    providerCallId: "provider-latest",
    processedEventIds: ["evt-latest-old"],
  });
  for (let callIndex = 0; callIndex < REPLAY_LIMIT / MAX_CALL_REPLAY_KEYS; callIndex++) {
    await saveCall(`call-fill-${callIndex}`, {
      providerCallId: `provider-fill-${callIndex}`,
      processedEventIds: Array.from(
        { length: MAX_CALL_REPLAY_KEYS },
        (_, eventIndex) => `evt-fill-${callIndex}-${eventIndex}`,
      ),
    });
  }
  await saveCall("call-latest", {
    providerCallId: "provider-latest",
    processedEventIds: ["evt-latest-old", "evt-latest-new"],
  });

  const restored = await restore(storePath);

  expect(restored.processedEventIds.size).toBe(REPLAY_LIMIT);
  expect(
    ["evt-latest-old", "evt-latest-new", "evt-fill-0-0", "evt-fill-0-1"].map((key) =>
      restored.processedEventIds.has(key),
    ),
  ).toEqual([true, true, false, false]);
});

it("finds retained snapshots outside recent history and preserves internal-id precedence", async () => {
  await saveCall("call-target", { providerCallId: "provider-target" });
  await saveCall("call-target", {
    providerCallId: "provider-target",
    state: "completed",
  });
  for (let index = 0; index < 101; index += 1) {
    await saveCall(`noise-${index}`, {
      providerCallId: index === 100 ? "call-target" : `provider-noise-${index}`,
    });
  }
  expect(await history(storePath, 100)).toHaveLength(100);
  for (const id of ["call-target", "provider-target"]) {
    expect(await findCall(storePath, id)).toMatchObject({
      callId: "call-target",
      state: "completed",
    });
  }
});
