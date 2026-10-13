import "fake-indexeddb/auto";
import fs from "node:fs/promises";
import path from "node:path";
import type { MatrixClient as MatrixJsClient } from "matrix-js-sdk/lib/matrix.js";
import { toErrorObject } from "openclaw/plugin-sdk/error-runtime";
import {
  drainFileLockStateForTest,
  resetFileLockStateForTest,
} from "openclaw/plugin-sdk/file-lock";
import { resetPluginStateStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { closeOpenClawStateDatabaseAsync } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getMatrixRuntime } from "../../runtime.js";
import { installMatrixTestRuntime } from "../../test-runtime.js";
import {
  openMatrixIdbSnapshotStoreOptions,
  writeMatrixIdbSnapshotJson,
} from "../crypto-state-store.js";
import { MatrixClient } from "../sdk.js";
import { withMatrixCryptoStoreRecoveryLock } from "./crypto-store-ownership.js";
import { observeCryptoStoreContention } from "./crypto-store-ownership.test-helpers.js";
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

  it("retains physical custody when SDK IndexedDB connections cannot retire", async () => {
    const databasePrefix = `${prefix}-failed-retirement`;
    const name = `${databasePrefix}::matrix-sdk-crypto`;
    const snapshotPath = path.join(tempDirs.make("matrix-failed-retirement-"), "snapshot.json");
    await seedDatabase({ name, storeName: "sessions", records: [] });
    let connection: IDBDatabase | undefined;
    sdk.init.mockImplementationOnce(async () => {
      connection = await new Promise((resolve, reject) => {
        const request = indexedDB.open(name);
        request.addEventListener("success", () => resolve(request.result));
        request.addEventListener("error", () =>
          reject(toErrorObject(request.error, "IndexedDB request failed")),
        );
      });
    });
    const client = new MatrixClient("https://matrix.example.org", "test-token", {
      userId: "@bot:example.org",
      deviceId: "BOT",
      encryption: true,
      autoBootstrapCrypto: false,
      cryptoDatabasePrefix: databasePrefix,
      idbSnapshotPath: snapshotPath,
    });
    clients.push(client);
    await client.prepareForOneOff();
    if (!connection) {
      throw new Error("SDK fixture did not open its crypto store");
    }
    const close = connection.close.bind(connection);
    const failure = vi.spyOn(connection, "close").mockImplementation(() => {
      throw new Error("simulated SDK connection close failure");
    });
    try {
      await expect(client.stopAndPersist()).rejects.toThrow(
        "simulated SDK connection close failure",
      );
      await expect(
        withMatrixCryptoStoreRecoveryLock(snapshotPath, async () => {}),
      ).rejects.toThrow();
    } finally {
      failure.mockRestore();
      close();
      await clearAllIndexedDbState({ databasePrefix });
      await drainFileLockStateForTest();
    }
  });

  it.each(["lost final seal", "missing guard", "malformed guard"])(
    "refuses %s before the next Rust initialization after a clean stop",
    async (fault) => {
      const storageRootDir = tempDirs.make("matrix-sealed-custody-");
      const snapshotPath = path.join(storageRootDir, "snapshot.json");
      const guardPath = `${snapshotPath}.owner.poisoned`;
      await seedDatabase({
        name: databaseName,
        storeName: "sessions",
        records: [{ key: "durable", value: { session: "saved" } }],
      });
      await persistIdbToDisk({ snapshotPath, databasePrefix: prefix });
      const makeClient = () => {
        const client = new MatrixClient("https://matrix.example.org", "test-token", {
          userId: "@bot:example.org",
          deviceId: "BOT",
          encryption: true,
          autoBootstrapCrypto: false,
          cryptoDatabasePrefix: prefix,
          idbSnapshotPath: snapshotPath,
        });
        clients.push(client);
        return client;
      };
      const owner = makeClient();
      await owner.prepareForOneOff();
      await owner.stopAndPersist();
      if (fault === "lost final seal") {
        const store = getMatrixRuntime().state.openKeyedStoreV2<Record<string, unknown>>(
          openMatrixIdbSnapshotStoreOptions(storageRootDir),
        );
        const meta = await store.lookup("current:meta");
        if (!meta) {
          throw new Error("Clean stop did not publish snapshot metadata");
        }
        // A valid WAL prefix can retain the full snapshot commit and lose only
        // the later seal commit. Keep every snapshot byte and digest unchanged.
        const unsealed = { ...meta };
        delete unsealed.cleanOwnerGeneration;
        await store.register("current:meta", unsealed);
      } else if (fault === "missing guard") {
        await fs.rm(guardPath, { force: true });
      } else {
        await fs.writeFile(guardPath, "torn");
      }
      await expect(makeClient().prepareForOneOff()).rejects.toThrow(
        "unresolved unsafe final state",
      );
      expect(sdk.init).toHaveBeenCalledTimes(1);
    },
  );

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
    const contention = observeCryptoStoreContention(snapshotPath);
    const waiting = contender.start({ abortSignal: abort.signal });
    const rejection = expect(waiting).rejects.toMatchObject({ name: "AbortError" });
    try {
      await contention.waitFor(waiting);
    } finally {
      contention.close();
    }
    expect(snapshotOpens).toBe(beforeContender);
    expect(sdk.init).toHaveBeenCalledTimes(1);
    abort.abort();
    await rejection;
    await contender.stopWithoutPersist();

    await owner.stopAndPersist();
    expect(await fs.readFile(`${snapshotPath}.owner.poisoned`, "utf8")).toMatch(/^[a-f0-9]{32}\n$/);
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
    expect(snapshotOpens).toBeGreaterThan(beforeRefused);
    expect(sdk.init).toHaveBeenCalledTimes(3);
  });
});
