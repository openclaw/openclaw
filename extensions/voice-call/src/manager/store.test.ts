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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

function installStateRuntime({
  beforeOperation,
  onChunkRead,
}: {
  beforeOperation?: (
    namespace: string,
    operation: "register" | "entries" | "count",
  ) => Promise<void>;
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
        return beforeOperation
          ? {
              ...backingStore,
              async register(...args: Parameters<typeof backingStore.register>) {
                await beforeOperation(options.namespace, "register");
                await backingStore.register(...args);
              },
              async entries() {
                await beforeOperation(options.namespace, "entries");
                return backingStore.entries();
              },
              async count() {
                await beforeOperation(options.namespace, "count");
                return await backingStore.count();
              },
            }
          : backingStore;
      },
    },
  });
}

async function mutateOfflineCallStore(
  storePath: string,
  mutate: (db: ReturnType<typeof openOpenClawStateDatabase>["db"]) => void,
): Promise<void> {
  await closeOpenClawStateDatabaseAsync();
  resetPluginStateStoreForTests();
  const databasePath = path.join(storePath, "state", "openclaw.sqlite");
  const replacementPath = `${databasePath}.corruption-fixture`;
  // A cold physical copy models restart corruption without stale in-process write receipts.
  fs.copyFileSync(databasePath, replacementPath, fs.constants.COPYFILE_EXCL);
  fs.renameSync(replacementPath, databasePath);
  try {
    mutate(openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: storePath } }).db);
  } finally {
    await closeOpenClawStateDatabaseAsync();
    resetPluginStateStoreForTests();
  }
}

const makeCall = (overrides: Parameters<typeof makePersistedCall>[0] = {}) =>
  CallRecordSchema.parse(makePersistedCall(overrides));
const transcript = (text: string, timestamp = Date.now()): CallRecord["transcript"] => [
  { timestamp, speaker: "user", text, isFinal: true },
];

describe("voice-call call record store", () => {
  let storePath: string;
  const saveCall = async (overrides: Parameters<typeof makePersistedCall>[0]) => {
    const call = makeCall(overrides);
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
    mutateOfflineCallStore(storePath, (db) => {
      db.prepare(
        "UPDATE plugin_state_entries SET value_json = ? WHERE plugin_id = 'voice-call' AND namespace = ? AND entry_key = ?",
      ).run(JSON.stringify(value), namespace, key);
    });
  beforeEach(() => {
    resetPluginStateStoreForTests();
    installStateRuntime();
    storePath = createTestStorePath();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    await closeOpenClawStateDatabaseAsync();
    resetPluginStateStoreForTests();
  });

  it.each([0, 1])("honors SQLite tail --since %s before following new snapshots", async (since) => {
    for (const callId of ["first", "second", "third"]) {
      await saveCall({ callId });
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
    await expect(history(storePath, calls.length)).resolves.toEqual(calls);
    expect(chunkQueries.length).toBeLessThanOrEqual(2);
    expect(chunkQueries.flat()).toHaveLength(131);
    const eventQueries = new Map<string, number>();
    for (const [queryIndex, keys] of chunkQueries.entries()) {
      expect(keys.length).toBeLessThanOrEqual(128);
      for (const key of keys) {
        const eventKey = key.slice(0, key.lastIndexOf(":chunk:"));
        expect(eventQueries.get(eventKey) ?? queryIndex).toBe(queryIndex);
        eventQueries.set(eventKey, queryIndex);
      }
    }
    const restored = await restore(storePath);
    expect([...restored.activeCalls.values()]).toEqual(calls);
    expect([...restored.processedEventIds]).toEqual(
      calls.flatMap((call) => call.processedEventIds),
    );
    await expect(findCall(storePath, "provider-batch-127")).resolves.toEqual(calls[127]);
  });

  it("preserves errors before later malformed metadata", async () => {
    for (const callId of ["earlier", "later"]) {
      await saveCall({ callId });
    }
    const events = openStore<{ chunkCount: number; sequence: number }>(EVENTS, 1100);
    const rows = (await events.entries()).toSorted((a, b) => a.value.sequence - b.value.sequence);
    const first = expectDefined(rows[0], "earlier persisted event");
    const second = expectDefined(rows[1], "later persisted event");
    await mutateOfflineCallStore(storePath, (db) => {
      const update = db.prepare(
        "UPDATE plugin_state_entries SET value_json = ? WHERE plugin_id = 'voice-call' AND namespace = ? AND entry_key = ?",
      );
      const timestamp = db.prepare(
        "UPDATE plugin_state_entries SET created_at = ? WHERE namespace = ? AND entry_key = ?",
      );
      timestamp.run(1, EVENTS, first.key);
      timestamp.run(2, EVENTS, second.key);
      update.run("null", EVENTS, second.key);
      update.run("invalid JSON", CHUNKS, `${first.key}:chunk:0000`);
    });
    await expect(findCall(storePath, "later")).rejects.toThrowError(
      expect.objectContaining({ code: "PLUGIN_STATE_CORRUPT" }),
    );
    await corruptRow(CHUNKS, `${first.key}:chunk:0000`, { index: -1, dataBase64: "" });
    await expect(findCall(storePath, "later")).rejects.toBeInstanceOf(TypeError);
    await corruptRow(EVENTS, second.key, { chunkCount: 0, byteLength: 0 });
    await expect(history(storePath)).resolves.toEqual([]);
  });

  it("restores complete chunked call transcripts", async () => {
    const call = await saveCall({
      callId: "call-chunked",
      transcript: transcript("🦞".repeat(180_000)),
    });
    resetPluginStateStoreForTests();
    expect((await restore(storePath)).activeCalls.get(call.callId)?.transcript).toEqual(
      call.transcript,
    );
    await expect(history(storePath)).resolves.toEqual([call]);
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
    const good = await saveCall({ callId: "good-call", transcript: [] });
    await mutateOfflineCallStore(storePath, (db) => {
      db.prepare("UPDATE plugin_state_entries SET value_json = ? WHERE entry_key = ?").run(
        "invalid JSON",
        later.key,
      );
    });
    chunks = openChunks();
    await chunks.register(first.key, { ...first.value, index: -1 });
    await expect(history(storePath)).resolves.toEqual([good]);
    expect(await findCall(storePath, good.callId)).toEqual(good);
    await chunks.delete(first.key);
    await expect(history(storePath)).resolves.toEqual([good]);
    await chunks.register(first.key, first.value);
    await expect(findCall(storePath, good.callId)).rejects.toThrowError(
      expect.objectContaining({ code: "PLUGIN_STATE_CORRUPT" }),
    );
  });

  it.each([
    { namespace: CHUNKS, failedWrite: 1, delayed: false, encoded: 1 },
    { namespace: CHUNKS, failedWrite: 2, delayed: false, encoded: 2 },
    { namespace: CHUNKS, failedWrite: 2, delayed: true, encoded: 2 },
    { namespace: EVENTS, failedWrite: 1, delayed: true, encoded: 3 },
  ])(
    "does not publish after $namespace write $failedWrite fails (delayed=$delayed)",
    async ({ namespace, failedWrite, delayed, encoded }) => {
      const call = makeCall({
        transcript: transcript(delayed ? "🦞".repeat(30_000) : "x".repeat(100_000), 1),
      });
      const failure = new Error("chunk or metadata write failed");
      let writes = 0;
      const beforeWrite = vi.fn((target: string) => {
        if (target === namespace && ++writes === failedWrite) {
          throw failure;
        }
      });
      installStateRuntime({
        beforeOperation: async (target, operation) => {
          if (delayed) {
            await Promise.resolve();
          }
          if (operation === "register") {
            beforeWrite(target);
          }
        },
      });
      const toString = vi.spyOn(Buffer.prototype, "toString");
      await expect(persistCallRecord(storePath, call)).rejects.toBe(failure);
      expect(beforeWrite.mock.calls).toEqual([
        ...Array.from({ length: encoded }, () => [CHUNKS]),
        ...(namespace === EVENTS ? [[EVENTS]] : []),
      ]);
      expect(toString.mock.calls.filter(([encoding]) => encoding === "base64")).toHaveLength(
        encoded,
      );
      toString.mockRestore();
      const { db } = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: storePath } });
      expect(
        db
          .prepare(
            "SELECT namespace, json_extract(value_json, '$.index') AS chunk_index FROM plugin_state_entries WHERE plugin_id = ? ORDER BY entry_key",
          )
          .all("voice-call"),
      ).toEqual(
        Array.from({ length: namespace === EVENTS ? encoded : encoded - 1 }, (_, index) => ({
          namespace: CHUNKS,
          chunk_index: index,
        })),
      );
      installStateRuntime();
      resetPluginStateStoreForTests();
      expect((await restore(storePath)).activeCalls.size).toBe(0);
      await expect(history(storePath)).resolves.toEqual([]);
      await expect(findCall(storePath, call.callId)).resolves.toBeUndefined();
    },
  );

  it("persists oversized records in SQLite without creating a JSONL fallback", async () => {
    const call = await saveCall({
      callId: "call-large",
      metadata: { mode: "conversation", numberRouteKey: "+15550000001" },
      transcript: transcript("x".repeat(3 * 1024 * 1024)),
    });

    const restored = await restore(storePath);
    const restoredCall = restored.activeCalls.get("call-large");
    expect(restoredCall).toMatchObject({
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
    await closeOpenClawStateDatabaseAsync();
    resetPluginStateStoreForTests();

    const first = await saveCall({ callId: "call-current", state: "ringing" });
    await expect(findCall(storePath, first.callId)).resolves.toEqual(first);
    const latest = { ...first, state: "answered" as const };
    await persistCallRecord(storePath, latest);
    await expect(history(storePath, 2)).resolves.toEqual([first, latest]);
    await expect(findCall(storePath, first.callId)).resolves.toEqual(latest);

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
      await expect(history(storePath)).resolves.toEqual([]);
      expectDefined(first.transcript[0], "first transcript entry").text =
        "mutated after persistence started";
      first.state = "answered";
      await persistCallRecord(storePath, first);
      await expect(history(storePath)).resolves.toEqual([first]);
    } finally {
      release.resolve();
      await pending;
    }
    resetPluginStateStoreForTests();
    await expect(history(storePath)).resolves.toEqual([expectedFirst, first]);
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
    await expect(history(storePath)).resolves.toEqual([]);
    expect((await restore(storePath)).activeCalls.size).toBe(0);
    await expect(findCall(storePath, call.callId)).rejects.toBe(failure);
    installStateRuntime();
    resetPluginStateStoreForTests();
    await expect(findCall(storePath, call.callId)).resolves.toEqual(call);
  });

  it("persists and restores only the newest per-call replay keys", async () => {
    const replayKeys = Array.from({ length: MAX_CALL_REPLAY_KEYS + 2 }, (_, i) => `evt-${i}`);
    await saveCall({ callId: "call-bounded-replay", processedEventIds: replayKeys });

    const restored = await restore(storePath);
    const expected = replayKeys.slice(-MAX_CALL_REPLAY_KEYS);
    expect(restored.activeCalls.get("call-bounded-replay")?.processedEventIds).toEqual(expected);
    expect([...restored.processedEventIds]).toEqual(expected);
  });

  it("hydrates manager replay keys in latest-snapshot call order", async () => {
    await saveCall({
      callId: "call-latest",
      providerCallId: "provider-latest",
      processedEventIds: ["evt-latest-old"],
    });
    for (let callIndex = 0; callIndex < REPLAY_LIMIT / MAX_CALL_REPLAY_KEYS; callIndex++) {
      await saveCall({
        callId: `call-fill-${callIndex}`,
        providerCallId: `provider-fill-${callIndex}`,
        processedEventIds: Array.from(
          { length: MAX_CALL_REPLAY_KEYS },
          (_, eventIndex) => `evt-fill-${callIndex}-${eventIndex}`,
        ),
      });
    }
    await saveCall({
      callId: "call-latest",
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
    await saveCall({ callId: "call-target", providerCallId: "provider-target" });
    await saveCall({
      callId: "call-target",
      providerCallId: "provider-target",
      state: "completed",
    });
    for (let index = 0; index < 101; index += 1) {
      await saveCall({
        callId: `noise-${index}`,
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
});
