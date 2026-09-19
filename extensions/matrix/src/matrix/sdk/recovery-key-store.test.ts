// Matrix tests cover recovery key store plugin behavior.
import fs from "node:fs";
import path from "node:path";
import { createClient } from "matrix-js-sdk";
import type { CryptoCallbacks } from "matrix-js-sdk/lib/crypto-api/index.js";
import { encodeRecoveryKey } from "matrix-js-sdk/lib/crypto-api/recovery-key.js";
import { RustCrypto } from "matrix-js-sdk/lib/rust-crypto/rust-crypto.js";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { resetPluginStateStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { closeOpenClawStateDatabaseAsync } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getMatrixRuntime } from "../../runtime.js";
import { installMatrixTestRuntime } from "../../test-runtime.js";
import {
  readMatrixRecoveryKeyStateForPathAsync,
  writeMatrixRecoveryKeyStateForPathAsync,
  type MatrixSnapshotStateRuntime,
} from "../crypto-state-store.js";
import { LogService } from "./logger.js";
import { MatrixRecoveryKeyStore } from "./recovery-key-store.js";
import type { MatrixCryptoBootstrapApi, MatrixSecretStorageStatus } from "./types.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    await closeOpenClawStateDatabaseAsync();
    cleanup();
  }),
);

function createTempRecoveryKeyPath(): string {
  const dir = tempDirs.make("matrix-recovery-key-store-");
  return path.join(dir, "recovery-key.json");
}

function createGeneratedRecoveryKey(params: {
  keyId: string;
  name: string;
  bytes: number[];
  encodedPrivateKey: string;
}) {
  return {
    keyId: params.keyId,
    keyInfo: { name: params.name },
    privateKey: new Uint8Array(params.bytes),
    encodedPrivateKey: params.encodedPrivateKey,
  };
}

function createBootstrapSecretStorageMock(errorMessage?: string) {
  return vi.fn(
    async (opts?: {
      setupNewSecretStorage?: boolean;
      createSecretStorageKey?: () => Promise<unknown>;
    }) => {
      if (opts?.setupNewSecretStorage || !errorMessage) {
        await opts?.createSecretStorageKey?.();
        return;
      }
      throw new Error(errorMessage);
    },
  );
}

function createRecoveryKeyCrypto(params: {
  bootstrapSecretStorage: ReturnType<typeof vi.fn>;
  createRecoveryKeyFromPassphrase: ReturnType<typeof vi.fn>;
  status: MatrixSecretStorageStatus;
}): MatrixCryptoBootstrapApi {
  return {
    on: vi.fn(),
    bootstrapCrossSigning: vi.fn(async () => {}),
    bootstrapSecretStorage: params.bootstrapSecretStorage,
    createRecoveryKeyFromPassphrase: params.createRecoveryKeyFromPassphrase,
    getSecretStorageStatus: vi.fn(async () => params.status),
    requestOwnUserVerification: vi.fn(async () => null),
  } as unknown as MatrixCryptoBootstrapApi;
}

function bootstrapSecretStorageCallArg(
  bootstrapSecretStorage: ReturnType<typeof vi.fn>,
  index: number,
) {
  const call = bootstrapSecretStorage.mock.calls[index];
  if (!call) {
    throw new Error(`expected bootstrapSecretStorage call ${index}`);
  }
  return call[0] as { setupNewSecretStorage?: boolean } | undefined;
}

async function expectRecoveryKeySummary(
  store: MatrixRecoveryKeyStore,
  expected: { keyId: string; encodedPrivateKey?: string },
) {
  const summary = await store.getRecoveryKeySummary();
  if (!summary) {
    throw new Error("expected recovery key summary");
  }
  expect(summary.keyId).toBe(expected.keyId);
  if (expected.encodedPrivateKey !== undefined) {
    expect(summary.encodedPrivateKey).toBe(expected.encodedPrivateKey);
  }
}

async function readStoredRecoveryKey(recoveryKeyPath: string) {
  const state = await readMatrixRecoveryKeyStateForPathAsync(
    recoveryKeyPath,
    getMatrixRuntime().state,
  );
  if (!state) {
    throw new Error("expected stored recovery key state");
  }
  return state;
}

async function runSecretStorageBootstrapScenario(params: {
  generated: ReturnType<typeof createGeneratedRecoveryKey>;
  status: MatrixSecretStorageStatus;
  allowSecretStorageRecreateWithoutRecoveryKey?: boolean;
  firstBootstrapError?: string;
}) {
  const recoveryKeyPath = createTempRecoveryKeyPath();
  const store = new MatrixRecoveryKeyStore(recoveryKeyPath);
  const createRecoveryKeyFromPassphrase = vi.fn(async () => params.generated);
  const bootstrapSecretStorage = createBootstrapSecretStorageMock(params.firstBootstrapError);
  const crypto = createRecoveryKeyCrypto({
    bootstrapSecretStorage,
    createRecoveryKeyFromPassphrase,
    status: params.status,
  });

  await store.bootstrapSecretStorageWithRecoveryKey(crypto, {
    allowSecretStorageRecreateWithoutRecoveryKey:
      params.allowSecretStorageRecreateWithoutRecoveryKey ?? false,
  });

  return {
    store,
    createRecoveryKeyFromPassphrase,
    bootstrapSecretStorage,
  };
}

function holdRecoveryWrites() {
  const entered = createDeferred<void>();
  const release = createDeferred<void>();
  const original = getMatrixRuntime().state.openKeyedStore;
  const runtime: MatrixSnapshotStateRuntime = {
    openKeyedStore: <T>(options: Parameters<typeof original>[0]) => {
      const store = original<T>(options);
      const compareAndApply = store.compareAndApply;
      if (!compareAndApply) {
        throw new Error("expected real SQLite comparison support");
      }
      return {
        ...store,
        compareAndApply: async (...args: Parameters<typeof compareAndApply>) => {
          entered.resolve();
          await release.promise;
          return compareAndApply(...args);
        },
      };
    },
  };
  return { entered, release, runtime };
}

describe("MatrixRecoveryKeyStore", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    resetPluginStateStoreForTests();
    installMatrixTestRuntime();
  });

  it.each(["cached", "staged"] as const)(
    "joins the cache write before real SDK cross-signing encryption with a %s key",
    async (source) => {
      const recoveryKeyPath = createTempRecoveryKeyPath();
      const held = holdRecoveryWrites();
      const store = new MatrixRecoveryKeyStore(recoveryKeyPath, held.runtime);
      const privateKey = new Uint8Array(32).fill(7);
      const encodedPrivateKey = encodeRecoveryKey(privateKey);
      if (!encodedPrivateKey) {
        throw new Error("expected encoded synthetic key");
      }
      await store.drainPendingPersistence();
      if (source === "staged") {
        await store.stageEncodedRecoveryKey({ encodedPrivateKey });
        expect(
          await readMatrixRecoveryKeyStateForPathAsync(recoveryKeyPath, getMatrixRuntime().state),
        ).toBeNull();
      }
      const callbacks = store.buildCryptoCallbacks();
      const sdkCallbacks: CryptoCallbacks = {
        async getSecretStorageKey({ keys }, name) {
          const result = await callbacks.getSecretStorageKey?.(
            {
              keys: Object.fromEntries(Object.entries(keys).map(([id, info]) => [id, { ...info }])),
            },
            name,
          );
          return result ? [result[0], new Uint8Array(result[1])] : null;
        },
        cacheSecretStorageKey(keyId, keyInfo, key) {
          callbacks.cacheSecretStorageKey?.(keyId, { ...keyInfo }, key);
        },
      };
      const accountData = new Map<string, unknown>();
      const encryptedWrites: string[] = [];
      const sdk = createClient({
        baseUrl: "https://matrix.example.org",
        userId: "@fixture:example.org",
        accessToken: "fixture-token",
        cryptoCallbacks: sdkCallbacks,
        fetchFn: async (input, init) => {
          const url = new URL(input instanceof Request ? input.url : String(input));
          const event = decodeURIComponent(url.pathname.split("/").at(-1) ?? "");
          if (init?.method === "PUT") {
            if (typeof init.body !== "string") {
              throw new Error("expected SDK JSON account-data body");
            }
            const content: unknown = JSON.parse(init.body);
            if (event.startsWith("m.cross_signing.")) {
              const persisted = await readStoredRecoveryKey(recoveryKeyPath);
              expect(persisted.privateKeyBase64).toBe(Buffer.from(privateKey).toString("base64"));
              expect(content).toMatchObject({ encrypted: expect.any(Object) });
              encryptedWrites.push(event);
            }
            accountData.set(event, content);
            return Response.json({});
          }
          return accountData.has(event)
            ? Response.json(accountData.get(event))
            : Response.json({ errcode: "M_NOT_FOUND", error: "fixture missing" }, { status: 404 });
        },
      });
      // The actual SDK bootstrap is driven with synthetic local crypto dependencies.
      const receiver = Object.assign(Object.create(RustCrypto.prototype) as RustCrypto, {
        logger: { info() {} },
        secretStorage: sdk.secretStorage,
        cryptoCallbacks: sdkCallbacks,
        olmMachine: {
          async exportCrossSigningKeys() {
            return {
              masterKey: "fixture-master",
              self_signing_key: "fixture-self",
              userSigningKey: "fixture-user",
            };
          },
        },
        async saveBackupKeyToStorage() {},
      });
      const crypto = createRecoveryKeyCrypto({
        status: { ready: false, defaultKeyId: null },
        createRecoveryKeyFromPassphrase: vi.fn(async () => ({
          privateKey,
          encodedPrivateKey,
        })),
        bootstrapSecretStorage: vi.fn((options) =>
          RustCrypto.prototype.bootstrapSecretStorage.call(receiver, options),
        ),
      });
      const bootstrap = store.bootstrapSecretStorageWithRecoveryKey(crypto);
      try {
        await Promise.race([
          held.entered.promise,
          bootstrap.then(() => {
            throw new Error("bootstrap completed before persistence admission");
          }),
        ]);
        expect(encryptedWrites).toEqual([]);
        held.release.resolve();
        await bootstrap;
        expect(encryptedWrites).toEqual([
          "m.cross_signing.master",
          "m.cross_signing.user_signing",
          "m.cross_signing.self_signing",
        ]);
      } finally {
        held.release.resolve();
        await bootstrap.catch(() => {});
        await store.close();
        sdk.stopClient();
      }
    },
  );

  it.each([false, true])(
    "settles a no-getter bootstrap before returning or throwing (failure=%s)",
    async (fail) => {
      const recoveryKeyPath = createTempRecoveryKeyPath();
      const held = holdRecoveryWrites();
      const store = new MatrixRecoveryKeyStore(recoveryKeyPath, held.runtime);
      const callbacks = store.buildCryptoCallbacks();
      const error = new Error("synthetic bootstrap failure");
      const crypto = createRecoveryKeyCrypto({
        status: { ready: true, defaultKeyId: "fixture" },
        createRecoveryKeyFromPassphrase: vi.fn(),
        bootstrapSecretStorage: vi.fn(async () => {
          callbacks.cacheSecretStorageKey?.("fixture", {}, new Uint8Array([1, 2, 3]));
          if (fail) {
            throw error;
          }
        }),
      });
      let settled = false;
      const bootstrap = store.bootstrapSecretStorageWithRecoveryKey(crypto).then(
        () => {
          settled = true;
          return null;
        },
        (cause: unknown) => {
          settled = true;
          return cause;
        },
      );
      try {
        await held.entered.promise;
        expect(settled).toBe(false);
        held.release.resolve();
        expect(await bootstrap).toBe(fail ? error : null);
        expect((await readStoredRecoveryKey(recoveryKeyPath)).keyId).toBe("fixture");
      } finally {
        held.release.resolve();
        await bootstrap;
        await store.close();
      }
    },
  );

  it("preserves a concurrent durable encoding and FIFO callback writes through the worker", async () => {
    const recoveryKeyPath = createTempRecoveryKeyPath();
    const held = holdRecoveryWrites();
    const store = new MatrixRecoveryKeyStore(recoveryKeyPath, held.runtime);
    await store.drainPendingPersistence();
    const callbacks = store.buildCryptoCallbacks();
    callbacks.cacheSecretStorageKey?.("first", {}, new Uint8Array([1]));
    callbacks.cacheSecretStorageKey?.("second", {}, new Uint8Array([2]));
    try {
      await held.entered.promise;
      await writeMatrixRecoveryKeyStateForPathAsync({
        recoveryKeyPath,
        stateRuntime: getMatrixRuntime().state,
        payload: {
          version: 1,
          createdAt: "2026-01-01T00:00:00Z",
          keyId: "concurrent",
          privateKeyBase64: "Aw==",
          encodedPrivateKey: "fixture-concurrent-encoding",
        },
      });
      held.release.resolve();
      await store.drainPendingPersistence();
      expect(await readStoredRecoveryKey(recoveryKeyPath)).toMatchObject({
        keyId: "second",
        privateKeyBase64: "Ag==",
        encodedPrivateKey: "fixture-concurrent-encoding",
      });
    } finally {
      held.release.resolve();
      await store.close();
    }
  });

  it.each(["worker", "released-host"] as const)(
    "keeps failed writes best-effort and drains later writes on the %s store",
    async (mode) => {
      const recoveryKeyPath = createTempRecoveryKeyPath();
      const original = getMatrixRuntime().state.openKeyedStore;
      const failure = new Error("synthetic persistence failure");
      let failNext = true;
      const warn = vi.spyOn(LogService, "warn").mockImplementation(() => {});
      const stateRuntime: MatrixSnapshotStateRuntime = {
        openKeyedStore: <T>(options: Parameters<typeof original>[0]) => {
          const backing = original<T>(options);
          const compare = backing.compareAndApply;
          const update = backing.update;
          if (!compare || !update) {
            throw new Error("expected real SQLite mutation support");
          }
          const failFirst = () => {
            if (failNext) {
              failNext = false;
              throw failure;
            }
          };
          return mode === "worker"
            ? {
                ...backing,
                compareAndApply: async (...args: Parameters<typeof compare>) => {
                  failFirst();
                  return compare(...args);
                },
              }
            : {
                ...backing,
                observe: undefined,
                compareAndApply: undefined,
                update: async (...args: Parameters<typeof update>) => {
                  failFirst();
                  return update(...args);
                },
              };
        },
      };
      const store = new MatrixRecoveryKeyStore(recoveryKeyPath, stateRuntime);
      const callbacks = store.buildCryptoCallbacks();
      try {
        await store.drainPendingPersistence();
        callbacks.cacheSecretStorageKey?.("failed", {}, new Uint8Array([1]));
        await expect(
          callbacks.getSecretStorageKey?.({ keys: { failed: {} } }, "fixture"),
        ).resolves.toEqual(["failed", new Uint8Array([1])]);
        expect(await store.getSecretStorageKeyCandidate("failed")).toBeNull();
        expect(warn).toHaveBeenCalledWith(
          "MatrixClientLite",
          "Failed to persist recovery key:",
          failure,
        );
        callbacks.cacheSecretStorageKey?.("saved", {}, new Uint8Array([2]));
        await store.close();
        expect(await readStoredRecoveryKey(recoveryKeyPath)).toMatchObject({
          keyId: "saved",
          privateKeyBase64: "Ag==",
        });
      } finally {
        await store.close();
      }
    },
  );

  it.each(["SDK callback", "reset candidate"] as const)(
    "does not return a durable key after closure during a %s read",
    async (reader) => {
      const recoveryKeyPath = createTempRecoveryKeyPath();
      const runtime = getMatrixRuntime().state;
      await writeMatrixRecoveryKeyStateForPathAsync({
        recoveryKeyPath,
        stateRuntime: runtime,
        payload: {
          version: 1,
          createdAt: "2026-01-01T00:00:00Z",
          keyId: "fixture",
          privateKeyBase64: "AQID",
        },
      });
      const readCompleted = createDeferred<void>();
      const releaseRead = createDeferred<void>();
      let delayRead = false;
      const stateRuntime: MatrixSnapshotStateRuntime = {
        openKeyedStore: <T>(options: Parameters<typeof runtime.openKeyedStore>[0]) => {
          const backing = runtime.openKeyedStore<T>(options);
          return {
            ...backing,
            async lookup(key: string) {
              const value = await backing.lookup(key);
              if (delayRead) {
                readCompleted.resolve();
                await releaseRead.promise;
              }
              return value;
            },
          };
        },
      };
      const store = new MatrixRecoveryKeyStore(recoveryKeyPath, stateRuntime);
      await store.drainPendingPersistence();
      delayRead = true;
      const result =
        reader === "SDK callback"
          ? store.buildCryptoCallbacks().getSecretStorageKey?.({ keys: { fixture: {} } }, "fixture")
          : store.getSecretStorageKeyCandidate("fixture");
      try {
        await readCompleted.promise;
        await store.close();
        releaseRead.resolve();
        await expect(result).resolves.toBeNull();
      } finally {
        releaseRead.resolve();
        await result;
        await store.close();
      }
    },
  );

  it("loads a stored recovery key for requested secret-storage keys", async () => {
    const recoveryKeyPath = createTempRecoveryKeyPath();
    fs.writeFileSync(
      recoveryKeyPath,
      JSON.stringify({
        version: 1,
        createdAt: new Date().toISOString(),
        keyId: "SSSS",
        privateKeyBase64: Buffer.from([1, 2, 3, 4]).toString("base64"),
      }),
      "utf8",
    );

    const store = new MatrixRecoveryKeyStore(recoveryKeyPath);
    await store.drainPendingPersistence();
    expect(fs.existsSync(recoveryKeyPath)).toBe(false);
    expect(fs.existsSync(`${recoveryKeyPath}.migrated`)).toBe(true);
    const callbacks = store.buildCryptoCallbacks();
    expect(await store.getSecretStorageKeyCandidate("SSSS")).toEqual(new Uint8Array([1, 2, 3, 4]));
    const resolved = await callbacks.getSecretStorageKey?.(
      { keys: { SSSS: { name: "test" } } },
      "m.cross_signing.master",
    );

    expect(resolved?.[0]).toBe("SSSS");
    expect(Array.from(resolved?.[1] ?? [])).toEqual([1, 2, 3, 4]);

    const resolvedFromMultipleKeys = await callbacks.getSecretStorageKey?.(
      { keys: { OLD: { name: "old" }, SSSS: { name: "active" } } },
      "m.cross_signing.master",
    );
    expect(resolvedFromMultipleKeys?.[0]).toBe("SSSS");
  });

  it("keeps a readable legacy recovery key usable when SQLite migration fails", async () => {
    const recoveryKeyPath = createTempRecoveryKeyPath();
    fs.writeFileSync(
      recoveryKeyPath,
      JSON.stringify({
        version: 1,
        createdAt: new Date().toISOString(),
        keyId: "SSSS",
        privateKeyBase64: Buffer.from([1, 2, 3, 4]).toString("base64"),
      }),
      "utf8",
    );
    vi.spyOn(getMatrixRuntime().state, "openKeyedStore").mockImplementation(() => {
      throw new Error("sqlite unavailable");
    });

    const store = new MatrixRecoveryKeyStore(recoveryKeyPath);
    const callbacks = store.buildCryptoCallbacks();
    const resolved = await callbacks.getSecretStorageKey?.(
      { keys: { SSSS: { name: "test" } } },
      "m.cross_signing.master",
    );

    expect(resolved?.[0]).toBe("SSSS");
    expect(Array.from(resolved?.[1] ?? [])).toEqual([1, 2, 3, 4]);
    expect(fs.existsSync(recoveryKeyPath)).toBe(true);
  });

  it("migrates a custom legacy recovery key filename without colliding with the default key", async () => {
    const dir = tempDirs.make("matrix-recovery-key-store-");
    const recoveryKeyPath = path.join(dir, "recovery.key");
    fs.writeFileSync(
      recoveryKeyPath,
      JSON.stringify({
        version: 1,
        createdAt: new Date().toISOString(),
        keyId: "CUSTOM",
        privateKeyBase64: Buffer.from([4, 3, 2, 1]).toString("base64"),
      }),
      "utf8",
    );

    const store = new MatrixRecoveryKeyStore(recoveryKeyPath);
    const callbacks = store.buildCryptoCallbacks();
    const resolved = await callbacks.getSecretStorageKey?.(
      { keys: { CUSTOM: { name: "custom" } } },
      "m.cross_signing.master",
    );

    expect(resolved?.[0]).toBe("CUSTOM");
    expect(Array.from(resolved?.[1] ?? [])).toEqual([4, 3, 2, 1]);
    expect(
      await readMatrixRecoveryKeyStateForPathAsync(
        path.join(dir, "recovery-key.json"),
        getMatrixRuntime().state,
      ),
    ).toBeNull();
    expect(
      (await readMatrixRecoveryKeyStateForPathAsync(recoveryKeyPath, getMatrixRuntime().state))
        ?.keyId,
    ).toBe("CUSTOM");
    expect(fs.existsSync(recoveryKeyPath)).toBe(false);
    expect(fs.existsSync(`${recoveryKeyPath}.migrated`)).toBe(true);
  });

  it("persists cached secret-storage keys in SQLite state", async () => {
    const recoveryKeyPath = createTempRecoveryKeyPath();
    const store = new MatrixRecoveryKeyStore(recoveryKeyPath);
    const callbacks = store.buildCryptoCallbacks();

    callbacks.cacheSecretStorageKey?.(
      "KEY123",
      {
        name: "openclaw",
      },
      new Uint8Array([9, 8, 7]),
    );

    expect(fs.existsSync(recoveryKeyPath)).toBe(false);
    await store.drainPendingPersistence();
    const saved = await readStoredRecoveryKey(recoveryKeyPath);
    expect(saved.keyId).toBe("KEY123");
    expect(saved.privateKeyBase64).toBe(Buffer.from([9, 8, 7]).toString("base64"));
  });

  it("does not authorize destructive reset from an ephemeral cached key", async () => {
    const store = new MatrixRecoveryKeyStore();
    const callbacks = store.buildCryptoCallbacks();

    callbacks.cacheSecretStorageKey?.("KEY123", { name: "openclaw" }, new Uint8Array([9, 8, 7]));

    expect(await store.getSecretStorageKeyCandidate("KEY123")).toBeNull();
  });

  it("creates and persists a recovery key when secret storage is missing", async () => {
    const { store, createRecoveryKeyFromPassphrase, bootstrapSecretStorage } =
      await runSecretStorageBootstrapScenario({
        generated: createGeneratedRecoveryKey({
          keyId: "GENERATED",
          name: "generated",
          bytes: [5, 6, 7, 8],
          encodedPrivateKey: "encoded-generated-key", // pragma: allowlist secret
        }),
        status: { ready: false, defaultKeyId: null },
      });

    expect(createRecoveryKeyFromPassphrase).toHaveBeenCalledTimes(1);
    expect(bootstrapSecretStorageCallArg(bootstrapSecretStorage, 0)?.setupNewSecretStorage).toBe(
      true,
    );
    await expectRecoveryKeySummary(store, {
      keyId: "GENERATED",
      encodedPrivateKey: "encoded-generated-key", // pragma: allowlist secret
    });
  });

  it("rebinds stored recovery key to server default key id when it changes", async () => {
    const recoveryKeyPath = createTempRecoveryKeyPath();
    fs.writeFileSync(
      recoveryKeyPath,
      JSON.stringify({
        version: 1,
        createdAt: new Date().toISOString(),
        keyId: "OLD",
        privateKeyBase64: Buffer.from([1, 2, 3, 4]).toString("base64"),
      }),
      "utf8",
    );
    const store = new MatrixRecoveryKeyStore(recoveryKeyPath);

    const bootstrapSecretStorage = vi.fn(async () => {});
    const createRecoveryKeyFromPassphrase = vi.fn(async () => {
      throw new Error("should not be called");
    });
    const crypto = {
      on: vi.fn(),
      bootstrapCrossSigning: vi.fn(async () => {}),
      bootstrapSecretStorage,
      createRecoveryKeyFromPassphrase,
      getSecretStorageStatus: vi.fn(async () => ({ ready: true, defaultKeyId: "NEW" })),
      requestOwnUserVerification: vi.fn(async () => null),
    } as unknown as MatrixCryptoBootstrapApi;

    await store.bootstrapSecretStorageWithRecoveryKey(crypto);

    expect(createRecoveryKeyFromPassphrase).not.toHaveBeenCalled();
    await expectRecoveryKeySummary(store, {
      keyId: "NEW",
    });
  });

  it("recreates secret storage when default key exists but is not usable locally", async () => {
    const { store, createRecoveryKeyFromPassphrase, bootstrapSecretStorage } =
      await runSecretStorageBootstrapScenario({
        generated: createGeneratedRecoveryKey({
          keyId: "RECOVERED",
          name: "recovered",
          bytes: [1, 1, 2, 3],
          encodedPrivateKey: "encoded-recovered-key", // pragma: allowlist secret
        }),
        status: { ready: false, defaultKeyId: "LEGACY" },
      });

    expect(createRecoveryKeyFromPassphrase).toHaveBeenCalledTimes(1);
    expect(bootstrapSecretStorageCallArg(bootstrapSecretStorage, 0)?.setupNewSecretStorage).toBe(
      true,
    );
    await expectRecoveryKeySummary(store, {
      keyId: "RECOVERED",
      encodedPrivateKey: "encoded-recovered-key", // pragma: allowlist secret
    });
  });

  it("recreates secret storage during explicit bootstrap when the server key exists but no local recovery key is available", async () => {
    const { store, createRecoveryKeyFromPassphrase, bootstrapSecretStorage } =
      await runSecretStorageBootstrapScenario({
        generated: createGeneratedRecoveryKey({
          keyId: "REPAIRED",
          name: "repaired",
          bytes: [7, 7, 8, 9],
          encodedPrivateKey: "encoded-repaired-key", // pragma: allowlist secret
        }),
        status: {
          ready: true,
          defaultKeyId: "LEGACY",
          secretStorageKeyValidityMap: { LEGACY: true },
        },
        allowSecretStorageRecreateWithoutRecoveryKey: true,
        firstBootstrapError: "getSecretStorageKey callback returned falsey",
      });

    expect(createRecoveryKeyFromPassphrase).toHaveBeenCalledTimes(1);
    expect(bootstrapSecretStorage).toHaveBeenCalledTimes(2);
    expect(bootstrapSecretStorageCallArg(bootstrapSecretStorage, 1)?.setupNewSecretStorage).toBe(
      true,
    );
    await expectRecoveryKeySummary(store, {
      keyId: "REPAIRED",
      encodedPrivateKey: "encoded-repaired-key", // pragma: allowlist secret
    });
  });

  it("recreates secret storage during explicit bootstrap when decrypting a stored secret fails with bad MAC", async () => {
    const { createRecoveryKeyFromPassphrase, bootstrapSecretStorage } =
      await runSecretStorageBootstrapScenario({
        generated: createGeneratedRecoveryKey({
          keyId: "REPAIRED",
          name: "repaired",
          bytes: [7, 7, 8, 9],
          encodedPrivateKey: "encoded-repaired-key", // pragma: allowlist secret
        }),
        status: {
          ready: true,
          defaultKeyId: "LEGACY",
          secretStorageKeyValidityMap: { LEGACY: true },
        },
        allowSecretStorageRecreateWithoutRecoveryKey: true,
        firstBootstrapError: "Error decrypting secret m.cross_signing.master: bad MAC",
      });

    expect(createRecoveryKeyFromPassphrase).toHaveBeenCalledTimes(1);
    expect(bootstrapSecretStorage).toHaveBeenCalledTimes(2);
    expect(bootstrapSecretStorageCallArg(bootstrapSecretStorage, 1)?.setupNewSecretStorage).toBe(
      true,
    );
  });

  it("stages a recovery key for secret storage without persisting it until commit", async () => {
    const recoveryKeyPath = createTempRecoveryKeyPath();
    fs.rmSync(recoveryKeyPath, { force: true });
    const store = new MatrixRecoveryKeyStore(recoveryKeyPath);
    const encoded = encodeRecoveryKey(
      new Uint8Array(Array.from({ length: 32 }, (_, i) => (i + 11) % 255)),
    );
    expect(encoded).toBeTypeOf("string");

    await store.stageEncodedRecoveryKey({
      encodedPrivateKey: encoded as string,
      keyId: "SSSSKEY",
    });

    expect(fs.existsSync(recoveryKeyPath)).toBe(false);
    const callbacks = store.buildCryptoCallbacks();
    const resolved = await callbacks.getSecretStorageKey?.(
      { keys: { SSSSKEY: { name: "test" } } },
      "m.cross_signing.master",
    );
    expect(resolved?.[0]).toBe("SSSSKEY");

    await store.commitStagedRecoveryKey({ keyId: "SSSSKEY" });

    const persisted = await readStoredRecoveryKey(recoveryKeyPath);
    expect(persisted.keyId).toBe("SSSSKEY");
    expect(persisted.encodedPrivateKey).toBe(encoded);
  });

  it("does not overwrite the stored recovery key while a staged key is only being validated", async () => {
    const recoveryKeyPath = createTempRecoveryKeyPath();
    const storedEncoded = encodeRecoveryKey(
      new Uint8Array(Array.from({ length: 32 }, (_, i) => (i + 1) % 255)),
    );
    fs.writeFileSync(
      recoveryKeyPath,
      JSON.stringify({
        version: 1,
        createdAt: "2026-03-12T00:00:00.000Z",
        keyId: "OLD",
        encodedPrivateKey: storedEncoded,
        privateKeyBase64: Buffer.from(
          new Uint8Array(Array.from({ length: 32 }, (_, i) => (i + 1) % 255)),
        ).toString("base64"),
      }),
      "utf8",
    );

    const store = new MatrixRecoveryKeyStore(recoveryKeyPath);
    const stagedEncoded = encodeRecoveryKey(
      new Uint8Array(Array.from({ length: 32 }, (_, i) => (i + 101) % 255)),
    );
    await store.stageEncodedRecoveryKey({
      encodedPrivateKey: stagedEncoded as string,
      keyId: "NEW",
    });

    const crypto = {
      on: vi.fn(),
      bootstrapCrossSigning: vi.fn(async () => {}),
      bootstrapSecretStorage: vi.fn(async () => {}),
      createRecoveryKeyFromPassphrase: vi.fn(async () => {
        throw new Error("should not be called");
      }),
      getSecretStorageStatus: vi.fn(async () => ({ ready: true, defaultKeyId: "NEW" })),
      requestOwnUserVerification: vi.fn(async () => null),
    } as unknown as MatrixCryptoBootstrapApi;

    await store.bootstrapSecretStorageWithRecoveryKey(crypto);

    const persisted = await readStoredRecoveryKey(recoveryKeyPath);
    expect(persisted.keyId).toBe("OLD");
    expect(persisted.encodedPrivateKey).toBe(storedEncoded);
  });

  it("generates a fresh recovery key when secret storage is explicitly rotated", async () => {
    const recoveryKeyPath = createTempRecoveryKeyPath();
    const oldEncoded = encodeRecoveryKey(
      new Uint8Array(Array.from({ length: 32 }, (_, i) => i + 1)),
    );
    fs.writeFileSync(
      recoveryKeyPath,
      JSON.stringify({
        version: 1,
        createdAt: "2026-03-12T00:00:00.000Z",
        keyId: "OLD",
        encodedPrivateKey: oldEncoded,
        privateKeyBase64: Buffer.from(
          new Uint8Array(Array.from({ length: 32 }, (_, i) => i + 1)),
        ).toString("base64"),
      }),
      "utf8",
    );

    const freshEncoded = encodeRecoveryKey(
      new Uint8Array(Array.from({ length: 32 }, (_, i) => i + 101)),
    ) as string;
    const bootstrapSecretStorage = createBootstrapSecretStorageMock();
    const createRecoveryKeyFromPassphrase = vi.fn(async () =>
      createGeneratedRecoveryKey({
        keyId: "NEW",
        name: "Fresh key",
        bytes: Array.from({ length: 32 }, (_, i) => i + 101),
        encodedPrivateKey: freshEncoded,
      }),
    );
    const crypto = createRecoveryKeyCrypto({
      bootstrapSecretStorage,
      createRecoveryKeyFromPassphrase,
      status: { ready: true, defaultKeyId: "OLD" },
    });
    const store = new MatrixRecoveryKeyStore(recoveryKeyPath);

    await store.bootstrapSecretStorageWithRecoveryKey(crypto, {
      forceNewRecoveryKey: true,
      forceNewSecretStorage: true,
    });

    const persisted = await readStoredRecoveryKey(recoveryKeyPath);
    expect(createRecoveryKeyFromPassphrase).toHaveBeenCalledTimes(1);
    expect(persisted.keyId).toBe("NEW");
    expect(persisted.encodedPrivateKey).toBe(freshEncoded);
    expect(persisted.encodedPrivateKey).not.toBe(oldEncoded);
  });
});
