import { expectDefined } from "openclaw/plugin-sdk/expect-runtime";
import type { OpenKeyedStoreOptions } from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  openOpenClawStateDatabase,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createVoiceCallStateRuntimeForTests, makePersistedCall } from "../manager.test-harness.js";
import { setVoiceCallStateRuntime } from "../runtime-state.js";
import { CallRecordSchema } from "../types.js";
import {
  buildChunkKey,
  CALL_RECORD_EVENTS_NAMESPACE,
  CALL_RECORD_EVENT_CHUNKS_NAMESPACE,
  encodeCallRecordEvent,
  MAX_CALL_RECORD_EVENTS,
  persistCallRecord,
} from "./store.js";
import { installStateRuntime, withPersistenceFixture } from "./store.test-harness.js";

function seedHistory(storePath: string) {
  const { db } = openOpenClawStateDatabase({
    env: { ...process.env, OPENCLAW_STATE_DIR: storePath },
  });
  const insert = db.prepare(
    "INSERT INTO plugin_state_entries (plugin_id, namespace, entry_key, value_json, created_at, expires_at) VALUES ('voice-call', ?, ?, ?, ?, NULL)",
  );
  const keys: string[] = [];
  db.exec("BEGIN");
  try {
    for (let i = 0; i < MAX_CALL_RECORD_EVENTS; i++) {
      const key = `event:retained:${String(i).padStart(6, "0")}:seed`;
      keys.push(key);
      const call = CallRecordSchema.parse(
        makePersistedCall({
          callId: `retained-${i}`,
          transcript:
            i === 127
              ? [{ timestamp: 1, speaker: "user", text: "x".repeat(110_000), isFinal: true }]
              : [],
        }),
      );
      const encoded = encodeCallRecordEvent(call);
      insert.run(
        CALL_RECORD_EVENTS_NAMESPACE,
        key,
        JSON.stringify({ ...encoded.meta, persistedAt: i, sequence: i }),
        i,
      );
      for (let j = 0; j < encoded.meta.chunkCount; j++) {
        insert.run(
          CALL_RECORD_EVENT_CHUNKS_NAMESPACE,
          buildChunkKey(key, j),
          JSON.stringify(encoded.chunk(j)),
          i,
        );
      }
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return { db, keys };
}

function observeReads(bulk: boolean) {
  const queries: string[][] = [];
  let points = 0;
  const state = createVoiceCallStateRuntimeForTests();
  setVoiceCallStateRuntime({
    state: {
      ...state,
      openKeyedStore: <T>(options: OpenKeyedStoreOptions) => {
        const store = state.openKeyedStore<T>(options);
        if (options.namespace !== CALL_RECORD_EVENT_CHUNKS_NAMESPACE) {
          return store;
        }
        return {
          ...store,
          lookup: async (key: string) => {
            points++;
            return store.lookup(key);
          },
          lookupMany: bulk
            ? async (keys: readonly string[]) => {
                queries.push([...keys]);
                if (!store.lookupMany) {
                  throw new Error("SQLite bulk reader unavailable");
                }
                return store.lookupMany(keys);
              }
            : undefined,
        };
      },
    },
  });
  return { queries, points: () => points };
}

describe("voice-call bounded retention completion", () => {
  beforeEach(() => {
    resetPluginStateStoreForTests();
    installStateRuntime();
  });
  afterEach(() => {
    resetPluginStateStoreForTests();
    installStateRuntime();
  });

  it.each([true, false])(
    "retains newest complete history with bounded reads and incomplete rows (bulk: %s)",
    async (bulk) => {
      await withPersistenceFixture(async ({ storePath, events, chunks }) => {
        const { keys } = seedHistory(storePath);
        const interrupted = "event:interrupted:000000:seed";
        const encoded = encodeCallRecordEvent(
          CallRecordSchema.parse(makePersistedCall({ callId: "interrupted" })),
        );
        await events.register(interrupted, { ...encoded.meta, persistedAt: 99999 });
        const reads = observeReads(bulk);
        await persistCallRecord(
          storePath,
          CallRecordSchema.parse(makePersistedCall({ callId: "newest" })),
        );
        expect(await events.count()).toBe(MAX_CALL_RECORD_EVENTS + 1);
        expect(await events.lookup(expectDefined(keys[0], "oldest event"))).toBeUndefined();
        expect(
          await chunks.lookup(buildChunkKey(expectDefined(keys[0], "oldest event"), 0)),
        ).toBeUndefined();
        expect(await events.lookup(expectDefined(keys[1], "next event"))).toBeDefined();
        expect(await events.lookup(interrupted)).toBeDefined();
        if (bulk) {
          expect(reads.points()).toBe(0);
          expect(reads.queries.length).toBeLessThanOrEqual(9);
          expect(reads.queries.flat()).toHaveLength(1004);
          expect(reads.queries.every((batchKeys) => batchKeys.length <= 128)).toBe(true);
          const positions = new Map<string, number>();
          for (const [batch, batchKeys] of reads.queries.entries()) {
            for (const key of batchKeys) {
              const event = key.slice(0, key.lastIndexOf(":chunk:"));
              expect(positions.get(event) ?? batch).toBe(batch);
              positions.set(event, batch);
            }
          }
        } else {
          expect(reads.queries).toHaveLength(0);
          expect(reads.points()).toBe(1004);
        }
      });
    },
  );

  it.each([true, false])(
    "preserves completion error order without deleting history (bulk: %s)",
    async (bulk) => {
      await withPersistenceFixture(async ({ storePath, events, rows }) => {
        const { db, keys } = seedHistory(storePath);
        db.prepare(
          "UPDATE plugin_state_entries SET value_json = ? WHERE namespace = ? AND entry_key = ?",
        ).run(
          "invalid JSON",
          CALL_RECORD_EVENT_CHUNKS_NAMESPACE,
          buildChunkKey(expectDefined(keys[0], "oldest event"), 0),
        );
        const before = rows();
        observeReads(bulk);
        await expect(
          persistCallRecord(
            storePath,
            CallRecordSchema.parse(makePersistedCall({ callId: "published-before-prune-error" })),
          ),
        ).rejects.toThrowError(expect.objectContaining({ code: "PLUGIN_STATE_CORRUPT" }));
        expect(await events.count()).toBe(MAX_CALL_RECORD_EVENTS + 1);
        expect(rows()).toEqual(expect.arrayContaining(before));
        expect(await events.lookup(expectDefined(keys[0], "oldest event"))).toBeDefined();
      });
    },
  );
});
