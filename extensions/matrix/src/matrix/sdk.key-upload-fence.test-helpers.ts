import fs from "node:fs";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { getMatrixRuntime, setMatrixRuntime } from "../runtime.js";
import type { MatrixSnapshotStateRuntime } from "./crypto-state-store.js";
import { restoreIdbFromDisk } from "./sdk/idb-persistence.js";
import {
  clearAllIndexedDbState,
  readDatabaseRecords,
  seedDatabase,
} from "./sdk/idb-persistence.test-helpers.js";

const TEST_UNDICI_RUNTIME_DEPS_KEY = "__OPENCLAW_TEST_UNDICI_RUNTIME_DEPS__";

export function clearTestUndiciRuntimeDepsOverride(): void {
  Reflect.deleteProperty(globalThis as object, TEST_UNDICI_RUNTIME_DEPS_KEY);
}

export function stubRuntimeFetch(fetchImpl: typeof fetch): void {
  (globalThis as Record<string, unknown>)[TEST_UNDICI_RUNTIME_DEPS_KEY] = {
    Agent: function MockAgent() {},
    EnvHttpProxyAgent: function MockEnvHttpProxyAgent() {},
    ProxyAgent: function MockProxyAgent() {},
    fetch: fetchImpl,
  };
}

export const KEY_UPLOAD_FENCE_MODES = [
  "fresh-device-restart",
  "existing-device-restart",
  "durable-prefixed",
  "deferred-runtime",
  "storage-failure",
  "missing-database",
  "missing-account",
] as const;

export function testKeyUploadFenceModes(
  params: Omit<Parameters<typeof runKeyUploadFenceCase>[0], "mode">,
): void {
  it.each(KEY_UPLOAD_FENCE_MODES)("fences keys upload on durable crypto state: %s", async (mode) =>
    runKeyUploadFenceCase({ ...params, mode }),
  );
}

type MatrixClientConstructor = new (
  baseUrl: string,
  accessToken: string,
  options: {
    encryption: boolean;
    idbSnapshotPath: string;
    cryptoDatabasePrefix: string;
    ssrfPolicy: { allowPrivateNetwork: boolean };
    stateRuntime?: MatrixSnapshotStateRuntime;
  },
) => object;

export async function runKeyUploadFenceCase(params: {
  mode: (typeof KEY_UPLOAD_FENCE_MODES)[number];
  MatrixClient: MatrixClientConstructor;
  makeTempDir: () => string;
  getFetchFn: () => typeof fetch;
  readSnapshot: (
    snapshotPath: string,
    stateRuntime: MatrixSnapshotStateRuntime,
  ) => Promise<string | null>;
  stubRuntimeFetch: (fetchImpl: typeof fetch) => void;
}): Promise<void> {
  const {
    mode,
    MatrixClient,
    makeTempDir,
    getFetchFn,
    readSnapshot,
    stubRuntimeFetch: installRuntimeFetch,
  } = params;
  const baseUrl = `http://127.0.0.1:8008${mode === "durable-prefixed" ? "/matrix" : ""}`;
  const root = makeTempDir();
  const prefix = path.basename(root);
  const storageRoot = path.join(root, "state-root");
  if (mode === "storage-failure") {
    fs.writeFileSync(storageRoot, "not a directory");
  }
  const record = { key: "account", value: { pendingKey: "fixture-private-material" } };
  const records = [
    record,
    ...(mode === "existing-device-restart"
      ? [{ key: "session::existing-room", value: { session: "retained-session" } }]
      : []),
  ];
  if (mode !== "missing-database") {
    await seedDatabase({
      name: `${prefix}::matrix-sdk-crypto`,
      storeName: "core",
      records: mode === "missing-account" ? [] : records,
    });
  }
  try {
    const stateRuntime = getMatrixRuntime().state;
    const fetchMock = vi.fn(async () => {
      const snapshot = await readSnapshot(storageRoot, stateRuntime);
      expect(snapshot).not.toBeNull();
      expect(JSON.parse(snapshot!)).toEqual([
        expect.objectContaining({
          name: `${prefix}::matrix-sdk-crypto`,
          stores: [expect.objectContaining({ name: "core", records })],
        }),
      ]);
      return new Response('{"one_time_key_counts":{"signed_curve25519":1}}');
    });
    installRuntimeFetch(fetchMock as typeof fetch);
    const client = new MatrixClient(baseUrl, "token", {
      encryption: true,
      idbSnapshotPath: path.join(storageRoot, "crypto-idb-snapshot.json"),
      cryptoDatabasePrefix: prefix,
      ssrfPolicy: { allowPrivateNetwork: true },
      stateRuntime,
    });
    expect(client).toBeInstanceOf(MatrixClient);
    const fetchFn = getFetchFn();
    if (mode === "deferred-runtime") {
      setMatrixRuntime({
        ...getMatrixRuntime(),
        state: {
          ...stateRuntime,
          openKeyedStore: () => {
            throw new Error("ambient Matrix runtime is unavailable");
          },
        },
      });
    }
    const upload = fetchFn(`${baseUrl}/_matrix/client/v3/keys/upload`, {
      method: "POST",
      body: '{"one_time_keys":{"signed_curve25519:fixture":{"key":"public"}}}',
    });
    if (
      [
        "fresh-device-restart",
        "existing-device-restart",
        "durable-prefixed",
        "deferred-runtime",
      ].includes(mode)
    ) {
      await expect(upload).resolves.toBeInstanceOf(Response);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      if (mode.endsWith("-restart")) {
        await clearAllIndexedDbState({ databasePrefix: prefix });
        await expect(
          restoreIdbFromDisk(path.join(storageRoot, "crypto-idb-snapshot.json")),
        ).resolves.toBe(true);
        await expect(
          readDatabaseRecords({ name: `${prefix}::matrix-sdk-crypto`, storeName: "core" }),
        ).resolves.toEqual(records);
        const restartedClient = new MatrixClient(baseUrl, "token", {
          encryption: true,
          idbSnapshotPath: path.join(storageRoot, "crypto-idb-snapshot.json"),
          cryptoDatabasePrefix: prefix,
          ssrfPolicy: { allowPrivateNetwork: true },
        });
        expect(restartedClient).toBeInstanceOf(MatrixClient);
        await expect(
          getFetchFn()(`${baseUrl}/_matrix/client/v3/keys/upload`, {
            method: "POST",
            body: '{"one_time_keys":{"signed_curve25519:fixture":{"key":"public"}}}',
          }),
        ).resolves.toBeInstanceOf(Response);
        expect(fetchMock).toHaveBeenCalledTimes(2);
      }
    } else {
      await expect(upload).rejects.toThrow();
      expect(fetchMock).not.toHaveBeenCalled();
    }
  } finally {
    await clearAllIndexedDbState({ databasePrefix: prefix });
  }
}
