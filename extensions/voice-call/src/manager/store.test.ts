// Voice Call tests cover store plugin behavior.
import fs from "node:fs";
import path from "node:path";
import { Command } from "commander";
import { expectDefined } from "openclaw/plugin-sdk/expect-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type { OpenKeyedStoreOptions } from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  createPluginStateKeyedStoreForTests,
  openOpenClawStateDatabase,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerVoiceCallLogs } from "../cli-call-log.js";
import {
  createTestStorePath,
  createVoiceCallStateRuntimeForTests,
  makePersistedCall,
  writeLegacyCallsJsonl,
} from "../manager.test-harness.js";
import { setVoiceCallStateRuntime } from "../runtime-state.js";
import { CallRecordSchema } from "../types.js";
import { MAX_CALL_REPLAY_KEYS } from "./replay-keys.js";
import {
  CALL_RECORD_EVENT_CHUNKS_NAMESPACE,
  CALL_RECORD_EVENTS_NAMESPACE,
  CALL_RECORD_CHUNK_MAX_ENTRIES,
  findCallInStore,
  getCallHistoryFromStore,
  loadActiveCallsFromStore,
  persistCallRecord,
} from "./store.js";

const { sleepMock } = vi.hoisted(() => ({ sleepMock: vi.fn() }));
vi.mock("../../api.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api.js")>()),
  sleep: sleepMock,
}));

const MANAGER_REPLAY_KEY_LIMIT = 10_000;

function installStateRuntime({
  bulkReads = true,
  beforeOperation,
}: {
  bulkReads?: boolean;
  beforeOperation?: (
    namespace: string,
    operation: "register" | "entries",
    key?: string,
  ) => Promise<void>;
} = {}): void {
  const state = createVoiceCallStateRuntimeForTests();
  setVoiceCallStateRuntime({
    state: {
      ...state,
      openKeyedStore: <T>(options: OpenKeyedStoreOptions) => {
        const backingStore = state.openKeyedStore<T>(options);
        const store = beforeOperation
          ? {
              ...backingStore,
              async register(...args: Parameters<typeof backingStore.register>) {
                await beforeOperation(options.namespace, "register", args[0]);
                await backingStore.register(...args);
              },
              async entries() {
                await beforeOperation(options.namespace, "entries");
                return backingStore.entries();
              },
            }
          : backingStore;
        if (bulkReads) {
          return store;
        }
        const { lookupMany: _lookupMany, ...legacy } = store;
        return legacy;
      },
    },
  });
}

describe("voice-call call record store", () => {
  beforeEach(() => {
    resetPluginStateStoreForTests();
    installStateRuntime();
  });

  afterEach(() => {
    vi.useRealTimers();
    resetPluginStateStoreForTests();
  });

  it.each([0, 1])("honors SQLite tail --since %s before following new snapshots", async (since) => {
    const storePath = createTestStorePath();
    const calls = ["first", "second", "third"].map((callId) =>
      CallRecordSchema.parse(makePersistedCall({ callId })),
    );
    const added = CallRecordSchema.parse(makePersistedCall({ callId: "new" }));
    for (const call of calls) {
      await persistCallRecord(storePath, call);
    }
    const stopped = new Error("SQLite tail test finished");
    sleepMock
      .mockReset()
      .mockRejectedValue(stopped)
      .mockImplementationOnce(async () => {
        await persistCallRecord(storePath, added);
      });
    let output = "";
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      output += String(chunk);
      return true;
    });
    const program = new Command();
    registerVoiceCallLogs({
      root: program,
      defaultFile: path.join(storePath, "calls.jsonl"),
      ensureHistoryStateRuntime: installStateRuntime,
    });
    try {
      await expect(
        program.parseAsync(["tail", "--since", String(since)], { from: "user" }),
      ).rejects.toBe(stopped);
      expect(
        output
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line).callId),
      ).toEqual(since === 0 ? ["new"] : ["third", "new"]);
    } finally {
      stdout.mockRestore();
      fs.rmSync(storePath, { recursive: true, force: true });
    }
  });

  it("does not import legacy JSONL records at runtime", async () => {
    const storePath = createTestStorePath();
    const call = CallRecordSchema.parse(
      makePersistedCall({ callId: "call-legacy", processedEventIds: ["evt-1"] }),
    );
    writeLegacyCallsJsonl(storePath, [call]);

    const restored = await loadActiveCallsFromStore(storePath);
    expect(restored.activeCalls.has("call-legacy")).toBe(false);
    expect(restored.processedEventIds.has("evt-1")).toBe(false);
    expect(fs.existsSync(path.join(storePath, "calls.jsonl"))).toBe(true);

    const history = await getCallHistoryFromStore(storePath);
    expect(history).toEqual([]);
  });

  it("persists new call snapshots without recreating the JSONL log", async () => {
    const storePath = createTestStorePath();
    const call = CallRecordSchema.parse(
      makePersistedCall({ callId: "call-sqlite", transcript: [] }),
    );

    await persistCallRecord(storePath, call);

    expect(fs.existsSync(path.join(storePath, "calls.jsonl"))).toBe(false);
    const restored = await loadActiveCallsFromStore(storePath);
    expect(restored.activeCalls.get("call-sqlite")?.providerCallId).toBe(call.providerCallId);
  });

  it("does not read the JSONL fallback when SQLite state cannot open", async () => {
    const storePath = createTestStorePath();
    const call = CallRecordSchema.parse(makePersistedCall({ callId: "call-jsonl" }));
    writeLegacyCallsJsonl(storePath, [call]);
    setVoiceCallStateRuntime({
      state: {
        ...createVoiceCallStateRuntimeForTests(),
        openKeyedStore: () => {
          throw new Error("sqlite unavailable");
        },
      },
    });

    const restored = await loadActiveCallsFromStore(storePath);
    expect(restored.activeCalls.has("call-jsonl")).toBe(false);
    expect(fs.existsSync(path.join(storePath, "calls.jsonl"))).toBe(true);
  });

  it.each([true, false])(
    "restores complete chunked call transcripts (bulk: %s)",
    async (bulkReads) => {
      installStateRuntime({ bulkReads });
      const storePath = createTestStorePath();
      const call = CallRecordSchema.parse(
        makePersistedCall({
          callId: "call-chunked",
          transcript: [
            { timestamp: Date.now(), speaker: "user", text: "🦞".repeat(180_000), isFinal: true },
          ],
        }),
      );
      await persistCallRecord(storePath, call);
      resetPluginStateStoreForTests();
      expect(
        (await loadActiveCallsFromStore(storePath)).activeCalls.get(call.callId)?.transcript,
      ).toEqual(call.transcript);
      await expect(getCallHistoryFromStore(storePath)).resolves.toEqual([call]);
      const env = { ...process.env, OPENCLAW_STATE_DIR: storePath };
      const chunks = createPluginStateKeyedStoreForTests<{ index: number; dataBase64: string }>(
        "voice-call",
        {
          namespace: CALL_RECORD_EVENT_CHUNKS_NAMESPACE,
          maxEntries: CALL_RECORD_CHUNK_MAX_ENTRIES,
          env,
        },
      );
      const rows = await chunks.entries();
      const first = rows.find((row) => row.value.index === 0);
      const later = rows.find((row) => row.value.index === 1);
      if (!first || !later) {
        throw new Error("expected call transcript chunks");
      }
      const good = CallRecordSchema.parse(
        makePersistedCall({ callId: "good-call", transcript: [] }),
      );
      await persistCallRecord(storePath, good);
      const { db } = openOpenClawStateDatabase({ env });
      db.prepare("UPDATE plugin_state_entries SET value_json = ? WHERE entry_key = ?").run(
        "invalid JSON",
        later.key,
      );
      await chunks.register(first.key, { ...first.value, index: -1 });
      await expect(getCallHistoryFromStore(storePath)).resolves.toEqual([good]);
      expect(await findCallInStore(storePath, good.callId)).toEqual(good);
      await chunks.delete(first.key);
      await expect(getCallHistoryFromStore(storePath)).resolves.toEqual([good]);
      await chunks.register(first.key, first.value);
      await expect(findCallInStore(storePath, good.callId)).rejects.toThrowError(
        expect.objectContaining({ code: "PLUGIN_STATE_CORRUPT" }),
      );
    },
  );

  it.each([1, 2])(
    "stops at failed chunk write %s without publishing metadata",
    async (failedWrite) => {
      const call = CallRecordSchema.parse(
        makePersistedCall({
          transcript: [{ timestamp: 1, speaker: "user", text: "x".repeat(100_000), isFinal: true }],
        }),
      );
      const failure = new Error("chunk write failed");
      let writes = 0;
      const beforeWrite = vi.fn((_namespace: string) => {
        if (++writes === failedWrite) {
          throw failure;
        }
      });
      installStateRuntime({
        beforeOperation: async (namespace, operation) => {
          if (operation === "register") {
            beforeWrite(namespace);
          }
        },
      });
      const storePath = createTestStorePath();
      const toString = vi.spyOn(Buffer.prototype, "toString");
      try {
        await expect(persistCallRecord(storePath, call)).rejects.toBe(failure);
        expect(beforeWrite.mock.calls).toEqual(
          Array.from({ length: failedWrite }, () => [CALL_RECORD_EVENT_CHUNKS_NAMESPACE]),
        );
        expect(toString.mock.calls.filter(([encoding]) => encoding === "base64")).toHaveLength(
          failedWrite,
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
          Array.from({ length: failedWrite - 1 }, (_, index) => ({
            namespace: CALL_RECORD_EVENT_CHUNKS_NAMESPACE,
            chunk_index: index,
          })),
        );
        resetPluginStateStoreForTests();
        expect((await loadActiveCallsFromStore(storePath)).activeCalls.size).toBe(0);
      } finally {
        toString.mockRestore();
        resetPluginStateStoreForTests();
        fs.rmSync(storePath, { recursive: true, force: true });
      }
    },
  );

  it("persists oversized records in SQLite without creating a JSONL fallback", async () => {
    const storePath = createTestStorePath();
    const call = CallRecordSchema.parse(
      makePersistedCall({
        callId: "call-large",
        metadata: { mode: "conversation", numberRouteKey: "+15550000001" },
        transcript: [
          {
            timestamp: Date.now(),
            speaker: "user",
            text: "x".repeat(3 * 1024 * 1024),
            isFinal: true,
          },
        ],
      }),
    );

    await persistCallRecord(storePath, call);

    const restored = await loadActiveCallsFromStore(storePath);
    const restoredCall = restored.activeCalls.get("call-large");
    expect(restoredCall?.providerCallId).toBe(call.providerCallId);
    expect(restoredCall?.transcript).toEqual([]);
    expect(restoredCall?.metadata).toMatchObject({
      mode: "conversation",
      numberRouteKey: "+15550000001",
      voiceCallPersistence: { transcriptTruncated: true },
    });
    expect(fs.existsSync(path.join(storePath, "calls.jsonl"))).toBe(false);
  });

  it("replays same-millisecond snapshots in write order", async () => {
    vi.useFakeTimers({ now: new Date("2026-05-31T10:00:00.000Z") });
    const storePath = createTestStorePath();
    const first = CallRecordSchema.parse(
      makePersistedCall({ callId: "call-order", state: "ringing" }),
    );
    const second = CallRecordSchema.parse(
      makePersistedCall({ callId: "call-order", state: "answered" }),
    );

    await persistCallRecord(storePath, first);
    await persistCallRecord(storePath, second);

    const restored = await loadActiveCallsFromStore(storePath);
    expect(restored.activeCalls.get("call-order")?.state).toBe("answered");
  });

  it("captures call bytes and write order before a delayed chunk publishes", async () => {
    vi.useFakeTimers({ now: new Date("2026-05-31T10:00:00.000Z") });
    const storePath = createTestStorePath();
    const blocked = createDeferred<void>();
    const release = createDeferred<void>();
    let delayed = false;
    installStateRuntime({
      beforeOperation: async (namespace, operation) => {
        if (
          !delayed &&
          namespace === CALL_RECORD_EVENT_CHUNKS_NAMESPACE &&
          operation === "register"
        ) {
          delayed = true;
          blocked.resolve();
          await release.promise;
        }
      },
    });
    const first = CallRecordSchema.parse(
      makePersistedCall({
        callId: "call-delayed",
        state: "ringing",
        transcript: [
          { timestamp: Date.now(), speaker: "user", text: "🦞".repeat(30_000), isFinal: true },
        ],
      }),
    );
    const expectedFirst = structuredClone(first);
    const pending = persistCallRecord(storePath, first);
    try {
      await blocked.promise;
      await expect(getCallHistoryFromStore(storePath)).resolves.toEqual([]);
      expectDefined(first.transcript[0], "first transcript entry").text =
        "mutated after persistence started";
      first.state = "answered";
      await persistCallRecord(storePath, first);
      await expect(getCallHistoryFromStore(storePath)).resolves.toEqual([first]);
    } finally {
      release.resolve();
      await pending;
    }
    resetPluginStateStoreForTests();
    await expect(getCallHistoryFromStore(storePath)).resolves.toEqual([expectedFirst, first]);
    expect((await loadActiveCallsFromStore(storePath)).activeCalls.get(first.callId)?.state).toBe(
      "answered",
    );
  });

  it.each([CALL_RECORD_EVENT_CHUNKS_NAMESPACE, CALL_RECORD_EVENTS_NAMESPACE])(
    "does not publish a call after a rejected %s write",
    async (failedNamespace) => {
      const storePath = createTestStorePath();
      const failure = new Error("delayed SQLite write rejected");
      installStateRuntime({
        beforeOperation: async (namespace, operation, key) => {
          await Promise.resolve();
          if (
            operation === "register" &&
            namespace === failedNamespace &&
            (namespace === CALL_RECORD_EVENTS_NAMESPACE || key?.endsWith(":chunk:0001"))
          ) {
            throw failure;
          }
        },
      });
      const call = CallRecordSchema.parse(
        makePersistedCall({
          transcript: [
            { timestamp: Date.now(), speaker: "user", text: "🦞".repeat(30_000), isFinal: true },
          ],
        }),
      );
      await expect(persistCallRecord(storePath, call)).rejects.toBe(failure);
      installStateRuntime();
      resetPluginStateStoreForTests();
      await expect(getCallHistoryFromStore(storePath)).resolves.toEqual([]);
      await expect(findCallInStore(storePath, call.callId)).resolves.toBeUndefined();
    },
  );

  it("propagates pruning rejection and preserves restore versus status read errors", async () => {
    const storePath = createTestStorePath();
    const call = CallRecordSchema.parse(makePersistedCall({ callId: "call-read-error" }));
    const failure = new Error("delayed SQLite listing rejected");
    installStateRuntime({
      beforeOperation: async (_namespace, operation) => {
        await Promise.resolve();
        if (operation === "entries") {
          throw failure;
        }
      },
    });
    await expect(persistCallRecord(storePath, call)).rejects.toBe(failure);
    await expect(getCallHistoryFromStore(storePath)).resolves.toEqual([]);
    expect((await loadActiveCallsFromStore(storePath)).activeCalls.size).toBe(0);
    await expect(findCallInStore(storePath, call.callId)).rejects.toBe(failure);
    installStateRuntime();
    resetPluginStateStoreForTests();
    await expect(findCallInStore(storePath, call.callId)).resolves.toEqual(call);
  });

  it("persists and restores only the newest per-call replay keys", async () => {
    const storePath = createTestStorePath();
    const replayKeys = Array.from(
      { length: MAX_CALL_REPLAY_KEYS + 2 },
      (_, index) => `evt-${index}`,
    );
    const call = CallRecordSchema.parse(
      makePersistedCall({
        callId: "call-bounded-replay",
        processedEventIds: replayKeys,
      }),
    );

    await persistCallRecord(storePath, call);

    const restored = await loadActiveCallsFromStore(storePath);
    const expected = replayKeys.slice(-MAX_CALL_REPLAY_KEYS);
    expect(restored.activeCalls.get("call-bounded-replay")?.processedEventIds).toEqual(expected);
    expect([...restored.processedEventIds]).toEqual(expected);
  });

  it("hydrates manager replay keys in latest-snapshot call order", async () => {
    const storePath = createTestStorePath();
    await persistCallRecord(
      storePath,
      CallRecordSchema.parse(
        makePersistedCall({
          callId: "call-latest",
          providerCallId: "provider-latest",
          processedEventIds: ["evt-latest-old"],
        }),
      ),
    );
    for (
      let callIndex = 0;
      callIndex < MANAGER_REPLAY_KEY_LIMIT / MAX_CALL_REPLAY_KEYS;
      callIndex++
    ) {
      await persistCallRecord(
        storePath,
        CallRecordSchema.parse(
          makePersistedCall({
            callId: `call-fill-${callIndex}`,
            providerCallId: `provider-fill-${callIndex}`,
            processedEventIds: Array.from(
              { length: MAX_CALL_REPLAY_KEYS },
              (_, eventIndex) => `evt-fill-${callIndex}-${eventIndex}`,
            ),
          }),
        ),
      );
    }
    await persistCallRecord(
      storePath,
      CallRecordSchema.parse(
        makePersistedCall({
          callId: "call-latest",
          providerCallId: "provider-latest",
          processedEventIds: ["evt-latest-old", "evt-latest-new"],
        }),
      ),
    );

    const restored = await loadActiveCallsFromStore(storePath);

    expect(restored.processedEventIds.size).toBe(MANAGER_REPLAY_KEY_LIMIT);
    expect(restored.processedEventIds.has("evt-latest-old")).toBe(true);
    expect(restored.processedEventIds.has("evt-latest-new")).toBe(true);
    expect(restored.processedEventIds.has("evt-fill-0-0")).toBe(false);
    expect(restored.processedEventIds.has("evt-fill-0-1")).toBe(false);
  });

  it("finds retained snapshots outside recent history and preserves internal-id precedence", async () => {
    const storePath = createTestStorePath();
    await persistCallRecord(
      storePath,
      CallRecordSchema.parse(
        makePersistedCall({ callId: "call-target", providerCallId: "provider-target" }),
      ),
    );
    await persistCallRecord(
      storePath,
      CallRecordSchema.parse(
        makePersistedCall({
          callId: "call-target",
          providerCallId: "provider-target",
          state: "completed",
        }),
      ),
    );
    for (let index = 0; index < 101; index += 1) {
      await persistCallRecord(
        storePath,
        CallRecordSchema.parse(
          makePersistedCall({
            callId: `noise-${index}`,
            providerCallId: index === 100 ? "call-target" : `provider-noise-${index}`,
          }),
        ),
      );
    }
    expect(await getCallHistoryFromStore(storePath, 100)).toHaveLength(100);
    expect(await findCallInStore(storePath, "call-target")).toMatchObject({
      callId: "call-target",
      state: "completed",
    });
    expect(await findCallInStore(storePath, "provider-target")).toMatchObject({
      callId: "call-target",
      state: "completed",
    });
  });
});
