import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import {
  createChannelIngressQueueForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  migrationById,
  accountStorageRoot,
  createMigrationParams as migrationParams,
  dedupeMigrationResult,
  writeLegacySyncCache,
  writeSqliteDedupeSource,
} from "./doctor-contract-api.test-support.js";
import { SqliteBackedMatrixSyncStore } from "./src/matrix/client/file-sync-store.js";
import { installMatrixTestRuntime } from "./src/test-runtime.js";
import { useAutoCleanupTempDirTracker } from "./test-support.js";

const createMigrationParams = (stateDir: string) => migrationParams(stateDir, false);

function createStateRoots(stateDir: string) {
  const matrixRoot = path.join(stateDir, "matrix");
  const tokenParent = path.join(matrixRoot, "accounts", "ops", "matrix.example.org__bot");
  const archivedAccount = path.relative(
    matrixRoot,
    accountStorageRoot(stateDir, "ops", "fedcba9876543210"),
  );
  return {
    activeRoots: [
      path.join(matrixRoot, "accounts", "legacy"),
      accountStorageRoot(stateDir, "sync-cache-backup"),
    ],
    excludedRoots: [
      "0123456789abcdef.apr24-cutover-20260424",
      "fedcba9876543210.reset-20260720",
      "0123456789abcdef.pre-stable-token-20260716",
      "fedcba9876543210.migrated",
      "sync-cache-backup",
      "_archive",
    ]
      .map((name) => path.join(tokenParent, name))
      .concat(
        ["crypto-backup-20260720", ".apr24-cutover-20260424", "operator-copy"].map((name) =>
          path.join(matrixRoot, name, archivedAccount),
        ),
      ),
  };
}

function trackVisitedDirectories(): string[] {
  const visitedDirs: string[] = [];
  const originalReaddir = fsPromises.readdir.bind(fsPromises);
  vi.spyOn(fsPromises, "readdir").mockImplementation(async (...args) => {
    visitedDirs.push(path.resolve(String(args[0])));
    return originalReaddir(...args);
  });
  return visitedDirs;
}

describe("matrix doctor archive scan boundaries", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);

  beforeEach(() => {
    resetPluginStateStoreForTests();
    installMatrixTestRuntime();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetPluginStateStoreForTests();
  });

  it.each(["sync-cache", "inbound-dedupe"] as const)(
    "migrates %s for archive-like account IDs without opening archives",
    async (kind) => {
      const stateDir = tempDirs.make("openclaw-matrix-doctor-");
      const { activeRoots, excludedRoots } = createStateRoots(stateDir);
      const now = Date.now();
      const accounts = ["sync-cache-backup", "legacy"];
      const sentinel = "archived SQLite sentinel must not be opened";
      const filename = kind === "sync-cache" ? "bot-storage.json" : "inbound-dedupe.json";
      if (kind === "sync-cache") {
        [...activeRoots, ...excludedRoots].forEach((root, i) =>
          writeLegacySyncCache(root, `legacy-token-${i}`),
        );
      } else {
        activeRoots.forEach((root, i) =>
          writeSqliteDedupeSource(
            root,
            i === 0 ? "sync-cache-backup" : "legacy",
            `$active-${i}`,
            now - 60_000,
          ),
        );
        for (const root of excludedRoots) {
          fs.mkdirSync(path.join(root, "state"), { recursive: true });
          fs.writeFileSync(path.join(root, "state", "openclaw.sqlite"), sentinel);
          fs.writeFileSync(path.join(root, filename), "{}");
        }
      }
      const visitedDirs = trackVisitedDirectories();
      const migration = await migrationById(
        kind === "sync-cache"
          ? "matrix-sync-cache-json-to-plugin-state"
          : "matrix-inbound-dedupe-to-claimable-dedupe",
      );
      const params = createMigrationParams(stateDir);
      if (kind === "sync-cache") {
        await expect(migration.detectLegacyState(params)).resolves.toEqual({
          preview: activeRoots.map(
            (root) => `Matrix sync cache JSON can migrate to SQLite: ${root}`,
          ),
        });
      }
      const result = await migration.migrateLegacyState(params);
      expect(result.warnings).toEqual([]);
      if (kind === "sync-cache") {
        expect(result.changes).toHaveLength(activeRoots.length * 2);
        for (const [i, root] of activeRoots.entries()) {
          const store = await SqliteBackedMatrixSyncStore.create(root);
          await expect(store.getSavedSyncToken()).resolves.toBe(`legacy-token-${i}`);
          expect(fs.existsSync(path.join(root, filename))).toBe(false);
          expect(fs.existsSync(path.join(root, `${filename}.migrated`))).toBe(true);
        }
      } else {
        expect(result.changes).toEqual(dedupeMigrationResult(activeRoots, 2).changes);
        for (const [i, accountId] of accounts.entries()) {
          const queue = createChannelIngressQueueForTests({
            channelId: "matrix",
            accountId,
            stateDir,
          });
          await expect(queue.enqueue(`$active-${i}`, {})).resolves.toMatchObject({
            kind: "completed",
          });
        }
      }
      for (const root of excludedRoots) {
        expect(fs.existsSync(path.join(root, filename))).toBe(true);
        if (kind === "inbound-dedupe") {
          expect(fs.readFileSync(path.join(root, "state", "openclaw.sqlite"), "utf8")).toBe(
            sentinel,
          );
        }
        const resolved = path.resolve(root);
        expect(
          visitedDirs.some((dir) => dir === resolved || dir.startsWith(`${resolved}${path.sep}`)),
        ).toBe(false);
      }
    },
  );
});
