import fs from "node:fs";
import type { OpenKeyedStoreOptions } from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  createPluginStateKeyedStoreForTests,
  openOpenClawStateDatabase,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { closeOpenClawStateDatabaseAsync } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import {
  createTestStorePath,
  createVoiceCallStateRuntimeForTests,
} from "../manager.test-harness.js";
import { setVoiceCallStateRuntime } from "../runtime-state.js";
import {
  CALL_RECORD_EVENTS_NAMESPACE,
  CALL_RECORD_EVENT_CHUNKS_NAMESPACE,
  CALL_RECORD_EVENT_META_MAX_ENTRIES,
  CALL_RECORD_CHUNK_MAX_ENTRIES,
  type CallRecordEventMeta,
  type CallRecordEventChunk,
} from "./store.js";

export function installStateRuntime({
  bulkReads = true,
  beforeOperation,
}: {
  bulkReads?: boolean;
  beforeOperation?: (
    namespace: string,
    operation: "register" | "entries" | "count" | "delete",
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
              async delete(key: string) {
                await beforeOperation(options.namespace, "delete", key);
                return backingStore.delete(key);
              },
              async entries() {
                await beforeOperation(options.namespace, "entries");
                return backingStore.entries();
              },
              async count() {
                await beforeOperation(options.namespace, "count");
                return (await backingStore.count?.()) ?? (await backingStore.entries()).length;
              },
            }
          : backingStore;
        if (bulkReads) {
          return store;
        }
        const { lookupMany: _lookupMany, count: _count, ...legacy } = store;
        return legacy;
      },
    },
  });
}

// These controls use the real plugin-state stores; hooks only delay/fail a boundary.
export async function withPersistenceFixture(
  run: (fixture: {
    storePath: string;
    events: ReturnType<typeof createPluginStateKeyedStoreForTests<CallRecordEventMeta>>;
    chunks: ReturnType<typeof createPluginStateKeyedStoreForTests<CallRecordEventChunk>>;
    rows: () => unknown[];
    fill: (namespace: string, targetCount: number) => void;
  }) => Promise<void>,
): Promise<void> {
  const storePath = createTestStorePath();
  const env = { ...process.env, OPENCLAW_STATE_DIR: storePath };
  const events = createPluginStateKeyedStoreForTests<CallRecordEventMeta>("voice-call", {
    namespace: CALL_RECORD_EVENTS_NAMESPACE,
    maxEntries: CALL_RECORD_EVENT_META_MAX_ENTRIES,
    overflowPolicy: "reject-new",
    env,
  });
  const chunks = createPluginStateKeyedStoreForTests<CallRecordEventChunk>("voice-call", {
    namespace: CALL_RECORD_EVENT_CHUNKS_NAMESPACE,
    maxEntries: CALL_RECORD_CHUNK_MAX_ENTRIES,
    overflowPolicy: "reject-new",
    env,
  });
  const { db } = openOpenClawStateDatabase({ env });
  try {
    await run({
      storePath,
      events,
      chunks,
      rows: () =>
        db
          .prepare(
            "SELECT * FROM plugin_state_entries WHERE plugin_id = 'voice-call' ORDER BY namespace, entry_key",
          )
          .all(),
      fill(namespace, targetCount) {
        // Seed pressure in the actual SQLite owner, not a fake capacity result.
        const existing = Number(
          db
            .prepare(
              "SELECT count(*) AS n FROM plugin_state_entries WHERE plugin_id = 'voice-call' AND namespace = ?",
            )
            .get(namespace)?.n,
        );
        const remaining = targetCount - existing;
        if (remaining <= 0) {
          return;
        }
        db.prepare(`
          WITH RECURSIVE slots(n) AS (
            SELECT 1 UNION ALL SELECT n + 1 FROM slots WHERE n < ?
          )
          INSERT INTO plugin_state_entries
            (plugin_id, namespace, entry_key, value_json, created_at, expires_at)
          SELECT 'voice-call', ?, 'pressure:' || n, '{}', 0, NULL FROM slots
        `).run(remaining, namespace);
      },
    });
  } finally {
    await closeOpenClawStateDatabaseAsync();
    resetPluginStateStoreForTests();
    fs.rmSync(storePath, { recursive: true, force: true });
  }
}
