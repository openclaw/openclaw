// Core Doctor tests own CLI dispatch and contract loading. This suite keeps the released account
// fixture at the registered Matrix migration boundary so plugin-shard startup cannot consume it.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import type { ISyncResponse } from "matrix-js-sdk/lib/matrix.js";
import { withStateMigrationBackupForTest } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { createFixtureLifetime } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, expect, it } from "vitest";
import {
  accountStorageRoot,
  createMigrationParams,
  migrationById,
  withDatabase,
  writeSource,
} from "./doctor-contract-api.test-support.js";
import { SqliteBackedMatrixSyncStore } from "./src/matrix/client/file-sync-store.js";
import { installMatrixTestRuntime, resetMatrixTestStores } from "./src/test-runtime.js";

const MATRIX_V2026_7_1_FIXTURE_BASE64 = new URL(
  "./test/fixtures/sqlite/matrix-account-v2026.7.1.sqlite.gz.base64",
  import.meta.url,
);
const sha256 = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");

function matrixSyncResponse(nextBatch: string): ISyncResponse {
  return {
    next_batch: nextBatch,
    rooms: { join: {}, invite: {}, leave: {}, knock: {} },
    account_data: { events: [] },
  };
}

function matrixStateRowsSha256(databasePath: string): string {
  return withDatabase(databasePath, true, (database) => {
    const rows = database
      .prepare(
        `SELECT plugin_id, namespace, entry_key, value_json, created_at, expires_at
         FROM plugin_state_entries
         WHERE plugin_id = 'matrix'
         ORDER BY namespace, entry_key`,
      )
      .all();
    return sha256(JSON.stringify(rows));
  });
}

const lifetime = createFixtureLifetime();

beforeEach(async () => {
  await resetMatrixTestStores();
  installMatrixTestRuntime();
});

afterEach(() => lifetime.cleanup());

it("repairs active account state without opening token-root archives", () =>
  lifetime.run(async () => {
    // Lifetime drains the body before closing stores, and retains files if closing fails.
    await lifetime.acquire(async () => ({ cleanup: resetMatrixTestStores }));
    const stateDir = lifetime.createTempDir("openclaw-matrix-doctor-");
    const root = accountStorageRoot(stateDir, "sync-cache-backup");
    const archiveRoot = accountStorageRoot(stateDir, "default", "sync-cache-backup");
    const databasePath = path.join(root, "state", "openclaw.sqlite");
    const archivedDatabasePath = path.join(archiveRoot, "state", "openclaw.sqlite");
    const compressedFixture = Buffer.from(
      fs.readFileSync(MATRIX_V2026_7_1_FIXTURE_BASE64, "utf8").replaceAll(/\s/gu, ""),
      "base64",
    );
    const rawFixture = gunzipSync(compressedFixture);
    expect(sha256(rawFixture)).toBe(
      "d8a543808fe9d4ae3cd989bbae9cb5e3c425fe5ecf8322309e08787fd87ec7f6",
    );
    writeSource(databasePath, rawFixture);
    writeSource(archivedDatabasePath, rawFixture);

    const beforeRepairRowsSha256 = matrixStateRowsSha256(databasePath);
    const openStore = async (token: string) => {
      const store = await SqliteBackedMatrixSyncStore.create(root);
      await expect(store.getSavedSyncToken()).resolves.toBe(token);
      return store;
    };
    const staleStore = await openStore("cursor-a");
    await staleStore.setSyncData(matrixSyncResponse("cursor-after-repair"));
    await expect(staleStore.flush()).rejects.toMatchObject({
      cause: {
        name: "OpenClawStateDatabaseSchemaMigrationRequiredError",
        message: expect.stringContaining("audit-events-v2"),
      },
    });
    await lifetime.verifyCleanup(resetMatrixTestStores);

    const migration = await migrationById("matrix-account-sqlite-schema");
    const migrationParams = {
      ...createMigrationParams(stateDir),
      context: {
        openPluginStateKeyedStore() {
          throw new Error("account schema migration must not open the plugin state store");
        },
      },
    };
    const expectActiveOnly = (messages: string[] | undefined) => {
      expect(messages).toContainEqual(expect.stringContaining(root));
      expect(messages).not.toContainEqual(expect.stringContaining(archiveRoot));
    };
    expectActiveOnly((await migration.detectLegacyState(migrationParams))?.preview);
    const doctor = await withStateMigrationBackupForTest({ env: migrationParams.env }, () =>
      migration.migrateLegacyState(migrationParams),
    );
    expect(doctor.warnings).toEqual([]);
    expectActiveOnly(doctor.changes);
    expect(matrixStateRowsSha256(databasePath)).toBe(beforeRepairRowsSha256);
    assert.deepStrictEqual(fs.readFileSync(archivedDatabasePath), rawFixture);

    const repairedStore = await openStore("cursor-a");
    await repairedStore.setSyncData(matrixSyncResponse("cursor-after-repair"));
    await repairedStore.flush();
    await lifetime.verifyCleanup(resetMatrixTestStores);

    await openStore("cursor-after-repair");
  }));
