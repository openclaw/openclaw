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
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
const MATRIX_V2026_7_1_GZIP_SHA256 =
  "2bbfc5b55c083a1532ac1162baa9a01a886b2bd6f17fb060c6794b2a10f7aeb0";
const MATRIX_V2026_7_1_RAW_SHA256 =
  "d8a543808fe9d4ae3cd989bbae9cb5e3c425fe5ecf8322309e08787fd87ec7f6";

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
    return createHash("sha256").update(JSON.stringify(rows)).digest("hex");
  });
}

describe("Matrix account state Doctor migration", () => {
  const lifetime = createFixtureLifetime();

  beforeEach(async () => {
    await resetMatrixTestStores();
    installMatrixTestRuntime();
  });

  afterEach(() => lifetime.cleanup());

  it("repairs active account state without opening token-root archives", () =>
    lifetime.run(async () => {
      let bodyFailure: { error: unknown } | undefined;
      try {
        const stateDir = lifetime.createTempDir("openclaw-matrix-doctor-");
        const storageRootDir = accountStorageRoot(stateDir, "sync-cache-backup");
        const archivedStorageRootDir = accountStorageRoot(stateDir, "default", "sync-cache-backup");
        const databasePath = path.join(storageRootDir, "state", "openclaw.sqlite");
        const archivedDatabasePath = path.join(archivedStorageRootDir, "state", "openclaw.sqlite");
        const compressedFixture = Buffer.from(
          fs.readFileSync(MATRIX_V2026_7_1_FIXTURE_BASE64, "utf8").replaceAll(/\s/gu, ""),
          "base64",
        );
        expect(createHash("sha256").update(compressedFixture).digest("hex")).toBe(
          MATRIX_V2026_7_1_GZIP_SHA256,
        );
        const rawFixture = gunzipSync(compressedFixture);
        expect(createHash("sha256").update(rawFixture).digest("hex")).toBe(
          MATRIX_V2026_7_1_RAW_SHA256,
        );
        writeSource(databasePath, rawFixture);
        writeSource(archivedDatabasePath, rawFixture);

        const beforeRepairRowsSha256 = matrixStateRowsSha256(databasePath);
        const staleStore = await SqliteBackedMatrixSyncStore.create(storageRootDir);
        await expect(staleStore.getSavedSyncToken()).resolves.toBe("cursor-a");
        await staleStore.setSyncData(matrixSyncResponse("cursor-after-repair"));
        await expect(staleStore.flush()).rejects.toMatchObject({
          cause: {
            name: "OpenClawStateDatabaseSchemaMigrationRequiredError",
            message: expect.stringContaining("audit-events-v2"),
          },
        });
        await lifetime.verifyCleanup(resetMatrixTestStores);

        withDatabase(databasePath, true, (stale) => {
          expect(stale.prepare("PRAGMA user_version").get()).toEqual({ user_version: 1 });
          expect(stale.prepare("PRAGMA integrity_check").get()).toEqual({
            integrity_check: "ok",
          });
        });

        const migration = await migrationById("matrix-account-sqlite-schema");
        const migrationParams = {
          ...createMigrationParams(stateDir),
          context: {
            openPluginStateKeyedStore() {
              throw new Error("account schema migration must not open the plugin state store");
            },
          },
        };
        const detected = await migration.detectLegacyState(migrationParams);
        expect(detected?.preview).toContainEqual(
          expect.stringContaining(`Matrix account SQLite schema migration`),
        );
        expect(detected?.preview).toContainEqual(expect.stringContaining(storageRootDir));
        expect(detected?.preview).not.toContainEqual(
          expect.stringContaining(archivedStorageRootDir),
        );
        const doctor = await withStateMigrationBackupForTest({ env: migrationParams.env }, () =>
          migration.migrateLegacyState(migrationParams),
        );
        expect(doctor.warnings).toEqual([]);
        expect(doctor.changes).toContainEqual(
          expect.stringContaining(`Matrix account SQLite ${storageRootDir}`),
        );
        expect(doctor.changes).not.toContainEqual(
          expect.stringContaining(`Matrix account SQLite ${archivedStorageRootDir}`),
        );
        expect(doctor.changes).toContainEqual(
          expect.stringContaining(
            "Migrated shared state audit event ledger → versioned message lifecycle schema",
          ),
        );
        expect(matrixStateRowsSha256(databasePath)).toBe(beforeRepairRowsSha256);
        assert.deepStrictEqual(fs.readFileSync(archivedDatabasePath), rawFixture);

        const repairedStore = await SqliteBackedMatrixSyncStore.create(storageRootDir);
        await expect(repairedStore.getSavedSyncToken()).resolves.toBe("cursor-a");
        await repairedStore.setSyncData(matrixSyncResponse("cursor-after-repair"));
        await repairedStore.flush();
        await lifetime.verifyCleanup(resetMatrixTestStores);

        const reopenedStore = await SqliteBackedMatrixSyncStore.create(storageRootDir);
        await expect(reopenedStore.getSavedSyncToken()).resolves.toBe("cursor-after-repair");
      } catch (error) {
        bodyFailure = { error };
      }
      // Join database work before removal, retaining the fixture if cleanup cannot be verified.
      try {
        await lifetime.verifyCleanup(resetMatrixTestStores);
      } catch (cleanupError) {
        if (bodyFailure) {
          throw new AggregateError(
            [bodyFailure.error, cleanupError],
            "Matrix Doctor fixture and cleanup failed",
            { cause: cleanupError },
          );
        }
        throw cleanupError;
      }
      if (bodyFailure) {
        throw bodyFailure.error;
      }
    }));
});
