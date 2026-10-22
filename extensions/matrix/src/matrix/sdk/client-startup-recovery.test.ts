import "fake-indexeddb/auto";
import fs from "node:fs/promises";
import path from "node:path";
import { ClientEvent, type MatrixClient as MatrixJsClient } from "matrix-js-sdk/lib/matrix.js";
import { SyncState } from "matrix-js-sdk/lib/sync.js";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import {
  drainFileLockStateForTest,
  resetFileLockStateForTest,
} from "openclaw/plugin-sdk/file-lock";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getMatrixRuntime } from "../../runtime.js";
import { installMatrixTestRuntime, resetMatrixTestStores } from "../../test-runtime.js";
import {
  openMatrixIdbSnapshotStoreOptions,
  writeMatrixIdbSnapshotJson,
} from "../crypto-state-store.js";
import { MatrixClient } from "../sdk.js";
import * as cryptoOwnership from "./crypto-store-ownership.js";
import { persistIdbToDisk, restoreIdbFromDisk } from "./idb-persistence.js";
import {
  clearAllIndexedDbState,
  readDatabaseRecords,
  requestResult,
  seedDatabase,
} from "./idb-persistence.test-helpers.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) => afterEach(cleanup));
type ClientOptions = ConstructorParameters<typeof MatrixClient>[2];
const prefix = "openclaw-matrix-custody-test";
const databaseName = `${prefix}::matrix-sdk-crypto`;
const records = [{ key: "durable", value: { session: "saved" } }];

const fixture = vi.hoisted(() => ({
  init: vi.fn<MatrixJsClient["initRustCrypto"]>(),
  start: vi.fn<MatrixJsClient["startClient"]>(),
  stop: vi.fn<MatrixJsClient["stopClient"]>(),
  reconcile:
    vi.fn<(typeof import("./joined-room-encryption.js"))["reconcileJoinedRoomEncryption"]>(),
}));
vi.mock("./joined-room-encryption.js", () => ({
  reconcileJoinedRoomEncryption: fixture.reconcile,
}));
vi.mock("./idb-persistence.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./idb-persistence.js")>();
  return {
    ...actual,
    persistIdbToDisk: vi.fn(actual.persistIdbToDisk),
    restoreIdbFromDisk: vi.fn(actual.restoreIdbFromDisk),
  };
});
vi.mock("matrix-js-sdk/lib/matrix.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("matrix-js-sdk/lib/matrix.js")>();
  return {
    ...actual,
    createClient: (...args: Parameters<typeof actual.createClient>) => {
      const client = actual.createClient(...args);
      vi.spyOn(client, "initRustCrypto").mockImplementation(fixture.init);
      vi.spyOn(client, "startClient").mockImplementation(async (...options) => {
        await fixture.start(...options);
        client.emit(ClientEvent.Sync, SyncState.Prepared, null);
      });
      const stopSdk = client.stopClient.bind(client);
      vi.spyOn(client, "stopClient").mockImplementation(() => {
        fixture.stop();
        stopSdk();
      });
      return client;
    },
  };
});

describe("Matrix encrypted startup ownership", () => {
  let client: MatrixClient;
  let clients: MatrixClient[];
  let ignoredStops: Set<MatrixClient>;
  let releases: Array<() => void>;
  let pending: Promise<void>[];
  let storageRootDir: string;
  let snapshotPath: string;
  const makeClient = (options: ClientOptions = {}, ignoreStopFailure = false) => {
    const created = new MatrixClient("https://matrix.example.org", "test-token", {
      userId: "@bot:example.org",
      deviceId: "BOT",
      encryption: true,
      autoBootstrapCrypto: false,
      idbSnapshotPath: snapshotPath,
      cryptoDatabasePrefix: prefix,
      ...options,
    });
    clients.push(created);
    if (ignoreStopFailure) {
      ignoredStops.add(created);
    }
    return created;
  };
  const expectCustodyHeld = async (target = snapshotPath) => {
    const inspect = vi.fn(async () => undefined);
    await expect(
      cryptoOwnership.withMatrixCryptoStoreRecoveryLock(target, inspect),
    ).rejects.toThrow();
    expect(inspect).not.toHaveBeenCalled();
  };
  const holdWork = () => {
    const started = createDeferred<void>();
    const finish = createDeferred<void>();
    releases.push(() => finish.resolve());
    const hold = async () => {
      started.resolve();
      await finish.promise;
    };
    return { started, finish, hold };
  };
  const track = (work: Promise<void>) => {
    pending.push(work.catch(() => undefined));
    return work;
  };
  beforeEach(async () => {
    storageRootDir = tempDirs.make("matrix-custody-");
    snapshotPath = path.join(storageRootDir, "snapshot.json");
    vi.stubEnv("OPENCLAW_STATE_DIR", storageRootDir);
    installMatrixTestRuntime({ stateDir: storageRootDir });
    fixture.reconcile.mockReset().mockResolvedValue(undefined);
    fixture.init.mockReset().mockImplementation(async (options) => {
      await seedDatabase({
        name: `${options?.cryptoDatabasePrefix ?? prefix}::matrix-sdk-crypto`,
        storeName: "sessions",
        records: [],
      });
    });
    fixture.start.mockReset().mockResolvedValue(undefined);
    fixture.stop.mockReset();
    vi.mocked(persistIdbToDisk).mockReset();
    vi.mocked(restoreIdbFromDisk).mockReset();
    clients = [];
    ignoredStops = new Set();
    releases = [];
    pending = [];
    await clearAllIndexedDbState();
    client = makeClient();
  });
  afterEach(async () => {
    releases.forEach((release) => release());
    await Promise.all(pending);
    await Promise.all(
      clients.map((owned) =>
        owned.stopWithoutPersist().catch((error: unknown) => {
          if (!ignoredStops.has(owned)) {
            throw error;
          }
        }),
      ),
    );
    // Failed SDK initialization/stop retain custody until process exit; retire test-owned locks.
    resetFileLockStateForTest();
    await drainFileLockStateForTest();
    await clearAllIndexedDbState();
    await resetMatrixTestStores();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("holds custody when encrypted startup uses the default snapshot path", async () => {
    const stateDir = tempDirs.make("matrix-default-custody-");
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    client = makeClient({ idbSnapshotPath: undefined, cryptoDatabasePrefix: undefined });
    await client.prepareForOneOff();
    await expectCustodyHeld(path.join(stateDir, "matrix", "crypto-idb-snapshot.json"));
    await client.stopAndPersist();
  });

  it("allows a successor after cancellation while arming refusal before Rust initialization", async () => {
    const { started: armed, finish: finishArm, hold } = holdWork();
    const acquire = cryptoOwnership.acquireMatrixCryptoStoreOwnership;
    vi.spyOn(cryptoOwnership, "acquireMatrixCryptoStoreOwnership").mockImplementationOnce(
      async (...args) => {
        const ownership = await acquire(...args);
        const arm = ownership.armUnsafeState;
        ownership.armUnsafeState = async () => {
          await arm();
          await hold();
        };
        return ownership;
      },
    );
    const successor = makeClient();
    const abort = new AbortController();
    const startup = track(client.start({ abortSignal: abort.signal }));
    const rejected = expect(startup).rejects.toMatchObject({ name: "AbortError" });
    await armed.promise;
    abort.abort();
    finishArm.resolve();
    await rejected;
    expect(fixture.init).not.toHaveBeenCalled();
    await client.stopWithoutPersist();
    await successor.prepareForOneOff();
    expect(fixture.init).toHaveBeenCalledTimes(1);
    await successor.stopAndPersist();
  });

  it("passes the configured crypto database prefix to Rust initialization", async () => {
    await client.prepareForOneOff();
    expect(fixture.init).toHaveBeenCalledWith({
      cryptoDatabasePrefix: "openclaw-matrix-test",
    });
    expect(fixture.reconcile).not.toHaveBeenCalled();
  });

  it.each([
    { phase: "replay", reason: "startup abort" },
    { phase: "replay", reason: "deadline" },
    { phase: "replay", reason: "generation stop" },
    { phase: "initialization", reason: "deadline" },
  ])(
    "cancels $phase promptly on $reason but drains it before backend stop",
    async ({ phase, reason }) => {
      // IndexedDB keeps its real task scheduler; only the startup deadline is virtual.
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const { started, finish, hold } = holdWork();
      const abort = new AbortController();
      let replaySignal: AbortSignal | undefined;
      if (phase === "initialization") {
        fixture.init.mockImplementation(hold);
      } else {
        fixture.reconcile.mockImplementation(async (_client, signal, assertCurrent) => {
          assertCurrent();
          replaySignal = signal;
          await hold();
          assertCurrent();
        });
      }
      const startup = track(client.start({ abortSignal: abort.signal, readyTimeoutMs: 1000 }));
      let shutdown: Promise<void> | undefined;
      await Promise.race([
        started.promise,
        startup.then(() => {
          throw new Error(`Encrypted startup bypassed ${phase}`);
        }),
      ]);
      if (reason === "startup abort") {
        abort.abort();
      } else if (reason === "deadline") {
        await vi.advanceTimersByTimeAsync(1000);
      } else {
        shutdown = track(client.stopWithoutPersist());
      }
      await expect(startup).rejects.toMatchObject({ name: "AbortError" });
      if (phase === "replay") {
        expect(replaySignal?.aborted).toBe(true);
      }
      shutdown ??= track(client.stopWithoutPersist());
      await Promise.resolve();
      expect(fixture.stop).not.toHaveBeenCalled();
      finish.resolve();
      await shutdown;
      expect(fixture.stop).toHaveBeenCalledTimes(1);
      if (phase === "initialization") {
        expect(fixture.start).not.toHaveBeenCalled();
        expect(fixture.reconcile).not.toHaveBeenCalled();
      }
      await expect(client.start()).rejects.toThrow("fully stopped");
    },
  );

  it("allows a successor after post-initialization readiness failure is published", async () => {
    const failed = client;
    const successor = makeClient();
    fixture.reconcile.mockRejectedValueOnce(new Error("room reconciliation failed"));
    await expect(failed.start()).rejects.toThrow("room reconciliation failed");
    expect(fixture.init).toHaveBeenCalledTimes(1);
    expect(await fs.stat(`${snapshotPath}.owner.poisoned`)).toBeDefined();
    await failed.stopAndPersist();
    expect(await cryptoOwnership.isMatrixCryptoStoreUnsafe(snapshotPath)).toBe(false);
    await successor.prepareForOneOff();
    expect(fixture.init).toHaveBeenCalledTimes(2);
    await successor.stopAndPersist();
  });

  it("retains crypto-store ownership after a post-initialization abort", async () => {
    const { started, finish, hold } = holdWork();
    fixture.init.mockImplementation(hold);
    const owner = client;
    const replacement = makeClient();
    const abort = new AbortController();
    const startup = track(owner.start({ abortSignal: abort.signal }));
    await started.promise;
    abort.abort();
    finish.resolve();
    await expect(startup).rejects.toMatchObject({ name: "AbortError" });
    await expect(replacement.prepareForOneOff()).rejects.toMatchObject({
      code: "matrix_crypto_store_owner_active",
    });
    expect(fixture.init).toHaveBeenCalledTimes(1);
    await owner.stopWithoutPersist();
    await expect(replacement.prepareForOneOff()).rejects.toThrow("unresolved unsafe final state");
  });

  it("retains custody through failed quiescence until pending crypto initialization is stopped", async () => {
    const { started: initStarted, finish: finishInit, hold } = holdWork();
    fixture.init.mockImplementation(hold);
    const requestsAborted = createDeferred<void>();
    const quiesceError = new Error("sync quiescence failed");
    const owner = makeClient({}, true);
    vi.spyOn(owner, "quiesceSync").mockRejectedValue(quiesceError);
    const abortRequests = owner.abortPendingRequests.bind(owner);
    vi.spyOn(owner, "abortPendingRequests").mockImplementation(() => {
      abortRequests();
      requestsAborted.resolve();
    });
    track(owner.prepareForOneOff());
    await initStarted.promise;
    const savesBefore = vi.mocked(persistIdbToDisk).mock.calls.length;
    const shutdown = track(owner.stopAndPersist());
    await Promise.race([
      requestsAborted.promise,
      shutdown.then(() => {
        throw new Error("Shutdown released custody without canceling crypto work");
      }),
    ]);
    await expectCustodyHeld(snapshotPath);
    expect(fixture.stop).not.toHaveBeenCalled();
    finishInit.resolve();
    await expect(shutdown).rejects.toBe(quiesceError);
    await cryptoOwnership.withMatrixCryptoStoreRecoveryLock(snapshotPath, async (markerPath) => {
      expect(fixture.stop).toHaveBeenCalledTimes(1);
      expect(await fs.stat(markerPath)).toBeDefined();
    });
    expect(vi.mocked(persistIdbToDisk).mock.calls.length).toBe(savesBefore);
  });

  it("retains custody after Rust initialization rejects without a stoppable backend", async () => {
    const failure = new Error("Rust initialization failed after opening its store");
    fixture.init.mockRejectedValueOnce(failure);
    const owner = makeClient({ cryptoDatabasePrefix: undefined }, true);
    await expect(owner.prepareForOneOff()).rejects.toBe(failure);
    await expect(owner.prepareForOneOff()).rejects.toMatchObject({ cause: failure });
    expect(fixture.init).toHaveBeenCalledOnce();
    await expect(owner.stopAndPersist()).rejects.toMatchObject({ cause: failure });
    await expect(owner.stopWithoutPersist()).rejects.toMatchObject({ cause: failure });
    await expectCustodyHeld(snapshotPath);
    expect(await cryptoOwnership.isMatrixCryptoStoreUnsafe(snapshotPath)).toBe(true);
  });

  it("retains custody after SDK stop throws even when discard cleanup is requested", async () => {
    const owner = makeClient({}, true);
    const stopError = new Error("SDK stop failed");
    await owner.prepareForOneOff();
    const savesBefore = vi.mocked(persistIdbToDisk).mock.calls.length;
    fixture.stop.mockImplementationOnce(() => {
      throw stopError;
    });
    await expect(owner.stopAndPersist()).rejects.toBe(stopError);
    await expect(owner.start()).rejects.toThrow("fully stopped");
    await expectCustodyHeld(snapshotPath);
    expect(vi.mocked(persistIdbToDisk).mock.calls.length).toBe(savesBefore);
    await expect(owner.stopWithoutPersist()).rejects.toBe(stopError);
    expect(fixture.stop).toHaveBeenCalledTimes(1);
    await expectCustodyHeld(snapshotPath);
    expect(await fs.stat(`${snapshotPath}.owner.poisoned`)).toBeDefined();
  });

  it("allows a successor after refusal-marker durability fails before Rust initialization", async () => {
    const actualOpen = fs.open;
    vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      const file = await actualOpen(...args);
      if (args[0] === `${snapshotPath}.owner.poisoned`) {
        vi.spyOn(file, "sync").mockRejectedValueOnce(new Error("marker sync failed"));
      }
      return file;
    });
    const owner = makeClient({ cryptoDatabasePrefix: undefined });
    await expect(owner.prepareForOneOff()).rejects.toThrow("marker sync failed");
    expect(fixture.init).not.toHaveBeenCalled();
    vi.restoreAllMocks();
    const successor = makeClient({ cryptoDatabasePrefix: undefined });
    await successor.prepareForOneOff();
    await successor.stopAndPersist();
  });

  it("refuses crypto initialization when unsafe-state arming fails", async () => {
    vi.mocked(restoreIdbFromDisk).mockImplementationOnce(async () => {
      await fs.mkdir(`${snapshotPath}.owner.poisoned`);
      return false;
    });
    const owner = client;
    await expect(owner.prepareForOneOff()).rejects.toThrow();
    expect(fixture.init).not.toHaveBeenCalled();
  });

  it("refuses a malformed canonical snapshot before Rust initialization without a database prefix", async () => {
    await writeMatrixIdbSnapshotJson({ storageRootDir, databaseCount: 0, snapshotJson: "[]" });
    await expect(
      makeClient({ cryptoDatabasePrefix: undefined }).prepareForOneOff(),
    ).rejects.toThrow("Malformed IndexedDB snapshot payload");
    expect(fixture.init).not.toHaveBeenCalled();
  });

  it("retains physical custody when SDK IndexedDB connections cannot retire", async () => {
    const databasePrefix = `${prefix}-failed-retirement`;
    const name = `${databasePrefix}::matrix-sdk-crypto`;
    await seedDatabase({ name, storeName: "sessions", records: [] });
    let connection: IDBDatabase | undefined;
    fixture.init.mockImplementationOnce(async () => {
      connection = await requestResult(indexedDB.open(name));
    });
    const owner = makeClient({ cryptoDatabasePrefix: databasePrefix }, true);
    await owner.prepareForOneOff();
    if (!connection) {
      throw new Error("SDK fixture did not open its crypto store");
    }
    const close = connection.close.bind(connection);
    const failure = vi.spyOn(connection, "close").mockImplementation(() => {
      throw new Error("simulated SDK connection close failure");
    });
    try {
      await expect(owner.stopAndPersist()).rejects.toThrow(
        "simulated SDK connection close failure",
      );
      await expectCustodyHeld();
    } finally {
      failure.mockRestore();
      close();
      await clearAllIndexedDbState({ databasePrefix });
      await drainFileLockStateForTest();
    }
  });

  async function seedSnapshot() {
    await seedDatabase({ name: databaseName, storeName: "sessions", records });
    await persistIdbToDisk({ snapshotPath, databasePrefix: prefix });
  }

  it.each(["lost final seal", "missing guard", "malformed guard"])(
    "refuses %s before the next Rust initialization after a clean stop",
    async (fault) => {
      const guardPath = `${snapshotPath}.owner.poisoned`;
      await seedSnapshot();
      await client.prepareForOneOff();
      await client.stopAndPersist();
      if (fault === "lost final seal") {
        const store = getMatrixRuntime().state.openKeyedStoreV2<Record<string, unknown>>(
          openMatrixIdbSnapshotStoreOptions(storageRootDir),
        );
        const meta = await store.lookup("current:meta");
        if (!meta) {
          throw new Error("Clean stop did not publish snapshot metadata");
        }
        // Lose only the seal commit, keeping snapshot bytes/digest unchanged.
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
      expect(fixture.init).toHaveBeenCalledTimes(1);
    },
  );

  it("blocks a concurrent client before SQLite snapshot I/O, then restores after handoff", async () => {
    await seedSnapshot();
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
    const makeOwner = () => makeClient({ stateRuntime });
    const owner = makeOwner();
    await owner.prepareForOneOff();
    expect(snapshotOpens).toBeGreaterThan(0);
    expect(await readDatabaseRecords({ name: databaseName, storeName: "sessions" })).toEqual(
      records,
    );
    const beforeContender = snapshotOpens;
    const contender = makeOwner();
    await expect(contender.start()).rejects.toMatchObject({
      code: "matrix_crypto_store_owner_active",
    });
    expect(snapshotOpens).toBe(beforeContender);
    expect(fixture.init).toHaveBeenCalledTimes(1);
    await contender.stopAndPersist();
    expect(snapshotOpens).toBe(beforeContender);
    await owner.stopAndPersist();
    expect(await fs.readFile(`${snapshotPath}.owner.poisoned`, "utf8")).toMatch(/^[a-f0-9]{32}\n$/);
    const successor = makeOwner();
    await successor.prepareForOneOff();
    expect(snapshotOpens).toBeGreaterThan(beforeContender);
    expect(fixture.init).toHaveBeenCalledTimes(2);
    await successor.stopAndPersist();
    const failedOwner = makeOwner();
    await failedOwner.prepareForOneOff();
    rejectSnapshotWrites = true;
    await expect(failedOwner.stopAndPersist()).rejects.toThrow("simulated snapshot store failure");
    rejectSnapshotWrites = false;
    expect(await fs.stat(`${snapshotPath}.owner.poisoned`)).toBeDefined();
    const beforeRefused = snapshotOpens;
    await expect(makeOwner().prepareForOneOff()).rejects.toThrow("unresolved unsafe final state");
    expect(snapshotOpens).toBeGreaterThan(beforeRefused);
    expect(fixture.init).toHaveBeenCalledTimes(3);
  });
});
