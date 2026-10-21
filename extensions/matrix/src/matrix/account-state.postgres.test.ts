import "fake-indexeddb/auto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { getEnvironmentData } from "node:worker_threads";
import * as state from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { closeOpenClawStateDatabaseAsync } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getMatrixRuntime } from "../runtime.js";
import { resolveMatrixAccountStorageRoot } from "../storage-paths.js";
import { installMatrixTestRuntime } from "../test-runtime.js";
import { resolveMatrixStoragePaths, writeStorageMeta } from "./client/storage.js";
import type { MatrixStoragePaths } from "./client/types.js";
import * as recovery from "./crypto-state-store.js";
import { persistIdbToDisk, restoreIdbFromDisk } from "./sdk/idb-persistence.js";
import * as idb from "./sdk/idb-persistence.test-helpers.js";
import type { MatrixStoredRecoveryKey } from "./sdk/types.js";

const configured: unknown = getEnvironmentData("openclaw.test.state.conformance.connection");
const connection = typeof configured === "string" ? configured : undefined;
const databasePrefix = "openclaw-matrix-postgres-conformance";
const cryptoDatabase = `${databasePrefix}::matrix-sdk-crypto`;
const auth = {
  homeserver: "https://matrix.example.org",
  userId: "@bot:example.org",
  accessToken: "synthetic-matrix-token",
  deviceId: "SYNTHETIC_DEVICE",
};
type Anchor = { engine: string; schema: string };
const recoveryKey: MatrixStoredRecoveryKey = {
  version: 1,
  createdAt: "2026-10-01T00:00:00.000Z",
  keyId: "synthetic-recovery-key",
  privateKeyBase64: Buffer.alloc(32, 7).toString("base64"),
};

describe.skipIf(!connection)("Matrix account-root PostgreSQL persistence", () => {
  const client = new pg.Client({ connectionString: connection });
  const roots = new Set<string>();
  let stateDir: string;

  const selected = (stateEngine: "postgres" | "sqlite") => ({
    effectiveEngines: state.resolveDatabaseFamilyEngines({
      database: {
        engine: "sqlite",
        families: { state: { engine: stateEngine }, workboard: { engine: "postgres" } },
      },
    }),
    postgres: { connection: connection!, schemaPrefix: "matrix_conformance" },
  });

  const withPostgres = <T>(run: () => T) =>
    state.withDatabaseEngineSelection(selected("postgres"), run);

  async function accountPaths(accountId: string, accessToken = auth.accessToken) {
    const input = { ...auth, accountId, accessToken, stateDir };
    roots.add(resolveMatrixAccountStorageRoot(input).rootDir);
    const paths = await resolveMatrixStoragePaths(input);
    roots.add(paths.rootDir);
    return paths;
  }

  const writeMeta = (paths: MatrixStoragePaths) =>
    expect(
      writeStorageMeta({ storagePaths: paths, ...auth, accountId: paths.accountKey }),
    ).resolves.toBe(true);
  const writeKey = (paths: MatrixStoragePaths) =>
    recovery.writeMatrixRecoveryKeyStateForPathAsync({
      recoveryKeyPath: paths.recoveryKeyPath,
      payload: recoveryKey,
      stateRuntime: getMatrixRuntime().state,
    });
  const readKey = (paths: MatrixStoragePaths) =>
    recovery.readMatrixRecoveryKeyStateForPathAsync(
      paths.recoveryKeyPath,
      getMatrixRuntime().state,
    );

  function readAnchor(root: string): Anchor | undefined {
    using anchor = new DatabaseSync(path.join(root, "state", "openclaw.sqlite"), {
      readOnly: true,
    });
    if (
      !anchor.prepare("SELECT 1 FROM sqlite_master WHERE name = ?").get("openclaw_engine_anchor")
    ) {
      return undefined;
    }
    return anchor.prepare("SELECT engine, schema FROM openclaw_engine_anchor").get() as
      | Anchor
      | undefined;
  }

  async function restartStores() {
    await closeOpenClawStateDatabaseAsync();
    state.resetPluginStateStoreForTests();
    installMatrixTestRuntime({ stateDir });
  }

  beforeAll(async () => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "matrix-postgres-"));
    installMatrixTestRuntime({ stateDir });
    await client.connect();
  });

  afterAll(async () => {
    await closeOpenClawStateDatabaseAsync();
    state.resetPluginStateStoreForTests();
    await idb.clearAllIndexedDbState({ databasePrefix });
    try {
      for (const root of roots) {
        if (!fs.existsSync(path.join(root, "state", "openclaw.sqlite"))) {
          continue;
        }
        const anchor = readAnchor(root);
        if (anchor) {
          await client.query(
            `DROP SCHEMA IF EXISTS "${anchor.schema.replaceAll('"', '""')}" CASCADE`,
          );
        }
      }
    } finally {
      await client.end();
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("restores multi-chunk crypto after closing state workers and isolates two account namespaces", async () => {
    await withPostgres(async () => {
      const primary = await accountPaths("primary");
      const secondary = await accountPaths("secondary");
      await writeMeta(primary);
      await writeMeta(secondary);
      await writeKey(primary);
      const records = Array.from({ length: 24 }, (_, index) => ({
        key: `room-${String(index).padStart(2, "0")}`,
        value: { session: `session-${index}:🦞${"x".repeat(15_000)}` },
      }));
      await idb.seedDatabase({ name: cryptoDatabase, storeName: "sessions", records });
      await persistIdbToDisk({
        snapshotPath: primary.idbSnapshotPath,
        databasePrefix,
        strict: true,
      });
      await idb.clearAllIndexedDbState({ databasePrefix });
      await restartStores();

      await expect(
        restoreIdbFromDisk(primary.idbSnapshotPath, undefined, databasePrefix),
      ).resolves.toBe(true);
      await expect(
        idb.readDatabaseRecords({ name: cryptoDatabase, storeName: "sessions" }),
      ).resolves.toEqual(records);
      await expect(readKey(primary)).resolves.toEqual(recoveryKey);
      await expect(readKey(secondary)).resolves.toBeNull();
      expect(fs.existsSync(primary.idbSnapshotPath)).toBe(false);

      await closeOpenClawStateDatabaseAsync();
      const primaryAnchor = readAnchor(primary.rootDir);
      const secondaryAnchor = readAnchor(secondary.rootDir);
      expect(primaryAnchor?.engine).toBe("postgres");
      expect(secondaryAnchor?.engine).toBe("postgres");
      expect(primaryAnchor?.schema).not.toBe(secondaryAnchor?.schema);
      const result = await client.query(
        `SELECT count(*)::int AS chunks FROM "${primaryAnchor!.schema}".plugin_state_entries WHERE namespace = $1 AND value_json::jsonb->>'kind' = 'snapshot-chunk'`,
        ["idb-snapshot"],
      );
      expect(result.rows[0].chunks).toBeGreaterThan(10);
    });
  });

  it("keeps a populated account root and its namespace across a token rotation", async () => {
    await withPostgres(async () => {
      const original = await accountPaths("rotated", "synthetic-old-token");
      await writeMeta(original);
      await writeKey(original);
      await restartStores();
      const originalAnchor = readAnchor(original.rootDir);
      const rotated = await accountPaths("rotated", "synthetic-new-token");
      expect(rotated.rootDir).toBe(original.rootDir);
      await expect(readKey(rotated)).resolves.toEqual(recoveryKey);
      await closeOpenClawStateDatabaseAsync();
      expect(readAnchor(rotated.rootDir)).toEqual(originalAnchor);
    });
  });

  it("keeps Matrix native when state is SQLite and workboard is PostgreSQL", async () => {
    await state.withDatabaseEngineSelection(selected("sqlite"), async () => {
      await restartStores();
      const native = await accountPaths("native");
      await writeKey(native);
      await restartStores();
      await expect(readKey(native)).resolves.toEqual(recoveryKey);
      await closeOpenClawStateDatabaseAsync();
      expect(readAnchor(native.rootDir)).toBeUndefined();
    });
  });
});
