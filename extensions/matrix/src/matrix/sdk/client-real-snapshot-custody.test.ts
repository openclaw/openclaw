import "fake-indexeddb/auto";
import fs from "node:fs/promises";
import path from "node:path";
import type { MatrixClient as MatrixJsClient } from "matrix-js-sdk/lib/matrix.js";
import { resetFileLockStateForTest } from "openclaw/plugin-sdk/file-lock";
import { resetPluginStateStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { closeOpenClawStateDatabaseAsync } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getMatrixRuntime } from "../../runtime.js";
import { installMatrixTestRuntime } from "../../test-runtime.js";
import { writeMatrixIdbSnapshotJson } from "../crypto-state-store.js";
import { MatrixClient } from "../sdk.js";
import { persistIdbToDisk } from "./idb-persistence.js";
import {
  clearAllIndexedDbState,
  readDatabaseRecords,
  seedDatabase,
} from "./idb-persistence.test-helpers.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) => afterEach(cleanup));
const prefix = "openclaw-matrix-real-custody-test";
const databaseName = `${prefix}::matrix-sdk-crypto`;
const sdk = vi.hoisted(() => ({ init: vi.fn<MatrixJsClient["initRustCrypto"]>() }));

vi.mock("matrix-js-sdk/lib/matrix.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("matrix-js-sdk/lib/matrix.js")>();
  return {
    ...actual,
    createClient: (...args: Parameters<typeof actual.createClient>) => {
      const client = actual.createClient(...args);
      vi.spyOn(client, "initRustCrypto").mockImplementation(sdk.init);
      return client;
    },
  };
});

describe("Matrix client custody at the real SQLite snapshot boundary", () => {
  let clients: MatrixClient[];
  beforeEach(async () => {
    resetPluginStateStoreForTests();
    installMatrixTestRuntime();
    sdk.init.mockReset().mockResolvedValue(undefined);
    clients = [];
    await clearAllIndexedDbState({ databasePrefix: prefix });
  });
  afterEach(async () => {
    await Promise.allSettled(clients.map((client) => client.stopWithoutPersist()));
    await clearAllIndexedDbState({ databasePrefix: prefix });
    await closeOpenClawStateDatabaseAsync();
    resetFileLockStateForTest();
    resetPluginStateStoreForTests();
    vi.restoreAllMocks();
  });

  it("refuses a malformed canonical snapshot before Rust initialization without a database prefix", async () => {
    const storageRootDir = tempDirs.make("matrix-default-prefix-custody-");
    const snapshotPath = path.join(storageRootDir, "snapshot.json");
    await writeMatrixIdbSnapshotJson({
      storageRootDir,
      databaseCount: 0,
      snapshotJson: "[]",
    });
    const client = new MatrixClient("https://matrix.example.org", "test-token", {
      userId: "@bot:example.org",
      deviceId: "BOT",
      encryption: true,
      autoBootstrapCrypto: false,
      idbSnapshotPath: snapshotPath,
    });
    clients.push(client);
    await expect(client.prepareForOneOff()).rejects.toThrow("Malformed IndexedDB snapshot payload");
    expect(sdk.init).not.toHaveBeenCalled();
  });

  it("blocks a concurrent client before SQLite snapshot I/O, then restores after handoff", async () => {
    const snapshotPath = path.join(tempDirs.make("matrix-real-custody-"), "snapshot.json");
    await seedDatabase({
      name: databaseName,
      storeName: "sessions",
      records: [{ key: "durable", value: { session: "saved" } }],
    });
    await persistIdbToDisk({ snapshotPath, databasePrefix: prefix });
    await clearAllIndexedDbState({ databasePrefix: prefix });

    const actualOpen = getMatrixRuntime().state.openKeyedStoreV2;
    let snapshotOpens = 0;
    let rejectSnapshotWrites = false;
    const stateRuntime = {
      openKeyedStoreV2: ((options: Parameters<typeof actualOpen>[0]) => {
        if (options.namespace === "idb-snapshot") {
          snapshotOpens++;
          if (rejectSnapshotWrites) {
            throw new Error("simulated snapshot store failure");
          }
        }
        return actualOpen(options);
      }) as typeof actualOpen,
    };
    const makeClient = () => {
      const client = new MatrixClient("https://matrix.example.org", "test-token", {
        userId: "@bot:example.org",
        deviceId: "BOT",
        encryption: true,
        autoBootstrapCrypto: false,
        cryptoDatabasePrefix: prefix,
        idbSnapshotPath: snapshotPath,
        stateRuntime,
      });
      clients.push(client);
      return client;
    };

    const owner = makeClient();
    await owner.prepareForOneOff();
    expect(snapshotOpens).toBeGreaterThan(0);
    expect(await readDatabaseRecords({ name: databaseName, storeName: "sessions" })).toEqual([
      { key: "durable", value: { session: "saved" } },
    ]);
    const beforeContender = snapshotOpens;
    const contender = makeClient();
    const abort = new AbortController();
    const waiterDir = `${snapshotPath}.owner.waiters`;
    await fs.mkdir(waiterDir, { recursive: true });
    const watchAbort = new AbortController();
    const waiterObserved = (async () => {
      for await (const event of fs.watch(waiterDir, { signal: watchAbort.signal })) {
        if ((await fs.readdir(waiterDir)).length > 0) {
          expect(event.eventType).toBeDefined();
          return;
        }
      }
      throw new Error("Waiter watcher ended before the contender registered");
    })();
    const waiting = contender.start({ abortSignal: abort.signal });
    const waitingRejection = expect(waiting).rejects.toMatchObject({ name: "AbortError" });
    try {
      await Promise.race([
        waiterObserved,
        waiting.then(
          () => {
            throw new Error("Contender started before registering a waiter");
          },
          (error: unknown) => {
            throw error;
          },
        ),
      ]);
    } finally {
      watchAbort.abort();
    }
    expect(snapshotOpens).toBe(beforeContender);
    expect(sdk.init).toHaveBeenCalledTimes(1);
    abort.abort();
    await waitingRejection;
    await contender.stopWithoutPersist();
    expect(snapshotOpens).toBe(beforeContender);

    await owner.stopAndPersist();
    const successor = makeClient();
    await successor.prepareForOneOff();
    expect(snapshotOpens).toBeGreaterThan(beforeContender);
    expect(sdk.init).toHaveBeenCalledTimes(2);
    await successor.stopAndPersist();

    const failedOwner = makeClient();
    await failedOwner.prepareForOneOff();
    rejectSnapshotWrites = true;
    await expect(failedOwner.stopAndPersist()).rejects.toThrow("simulated snapshot store failure");
    rejectSnapshotWrites = false;
    expect(await fs.stat(`${snapshotPath}.owner.poisoned`)).toBeDefined();
    const beforeRefused = snapshotOpens;
    const refused = makeClient();
    await expect(refused.prepareForOneOff()).rejects.toThrow("unresolved unsafe final state");
    expect(snapshotOpens).toBe(beforeRefused);
    expect(sdk.init).toHaveBeenCalledTimes(3);
  });
});
