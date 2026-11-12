import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { getEnvironmentData, setEnvironmentData } from "node:worker_threads";
import * as processRuntime from "openclaw/plugin-sdk/process-runtime";
import { openSqliteWorkerStore, type SqliteWorkerStore } from "openclaw/plugin-sdk/sqlite-runtime";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { withinTest } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import {
  CHAT_DB_ADMISSION_GATE,
  type AdmissionGate,
  type StorageOperations,
} from "./chat-db.admission.test-support.js";
import { openIMessageChatDbReader } from "./chat-db.js";

const stores = new Set<SqliteWorkerStore<StorageOperations>>();
const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    try {
      await Promise.all([...stores].map((store) => store.close()));
    } finally {
      stores.clear();
      cleanup();
    }
  }),
);
const backendUrl = new URL("./chat-db.admission.test-support.ts", import.meta.url);
const databasePath = () => path.join(tempDirs.make("imessage-admission-"), "store.sqlite");
async function open(pathname: string) {
  const store = await openSqliteWorkerStore<StorageOperations>({
    moduleUrl: backendUrl,
    databasePath: pathname,
    input: undefined,
  });
  stores.add(store);
  return store;
}

it.for(["open", "read"] as const)(
  "keeps storage responsive during a blocked chat.db %s",
  async (phase, { signal }) => {
    const gate = new Int32Array(new SharedArrayBuffer(8));
    assert.equal(getEnvironmentData(CHAT_DB_ADMISSION_GATE), undefined);
    setEnvironmentData(CHAT_DB_ADMISSION_GATE, {
      gate: gate.buffer,
      phase,
    } satisfies AdmissionGate);
    onTestFinished(() => setEnvironmentData(CHAT_DB_ADMISSION_GATE, undefined));
    const storage = await open(databasePath());
    // Fill the ordinary pool so a foreign read would share a storage carrier.
    const sibling = await open(databasePath());
    const chatPath = databasePath();
    writeFileSync(chatPath, "");
    const resolveWorker = processRuntime.resolveRuntimeWorkerUrl;
    using backendOverride = vi.spyOn(processRuntime, "resolveRuntimeWorkerUrl");
    backendOverride.mockImplementation((entry) =>
      entry.sourceWorkerName === "chat-db.worker" ? backendUrl : resolveWorker(entry),
    );
    let settled = false;
    const reading = openIMessageChatDbReader(chatPath)
      .then(async (store) => {
        assert(store);
        try {
          return await store.execute({ type: "startupWatermark", input: undefined });
        } finally {
          await store.close();
        }
      })
      .finally(() => {
        settled = true;
      });
    void reading.catch(() => undefined);
    try {
      await withinTest(Promise.resolve(Atomics.waitAsync(gate, 1, 0).value), signal);
      const responsive =
        phase === "open" ? await withinTest(open(databasePath()), signal) : storage;
      await withinTest(responsive.execute({ type: "append", input: "alive" }), signal);
      await expect(responsive.execute({ type: "read", input: undefined })).resolves.toEqual([
        { value: "alive" },
      ]);
      await withinTest(sibling.execute({ type: "append", input: "sibling" }), signal);
      expect(settled).toBe(false);
    } finally {
      Atomics.store(gate, 0, 1);
      Atomics.notify(gate, 0);
      await reading;
    }
  },
);
