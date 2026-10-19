import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import { resetPluginStateStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  migrationById,
  accountStorageRoot,
  createMigrationParams as migrationParams,
  writeLegacySyncCache,
  writeSqliteDedupeSource,
} from "./doctor-contract-api.test-support.js";
import { SqliteBackedMatrixSyncStore } from "./src/matrix/client/file-sync-store.js";
import { createMatrixInboundEventDeduper } from "./src/matrix/monitor/inbound-dedupe.js";
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

function expectRootNotVisited(visitedDirs: string[], storageRootDir: string): void {
  const root = path.resolve(storageRootDir);
  expect(
    visitedDirs.some(
      (visitedDir) => visitedDir === root || visitedDir.startsWith(`${root}${path.sep}`),
    ),
  ).toBe(false);
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

  it("keeps archive-like account IDs active while excluding token-root archives", async () => {
    const stateDir = tempDirs.make("openclaw-matrix-doctor-");
    const { activeRoots, excludedRoots } = createStateRoots(stateDir);
    for (const [index, storageRootDir] of [...activeRoots, ...excludedRoots].entries()) {
      writeLegacySyncCache(storageRootDir, `legacy-token-${index}`);
    }

    const visitedDirs = trackVisitedDirectories();

    const migration = migrationById("matrix-sync-cache-json-to-plugin-state");
    await expect(migration.detectLegacyState(createMigrationParams(stateDir))).resolves.toEqual({
      preview: activeRoots.map(
        (storageRootDir) => `Matrix sync cache JSON can migrate to SQLite: ${storageRootDir}`,
      ),
    });
    const result = await migration.migrateLegacyState(createMigrationParams(stateDir));

    expect(result.warnings).toEqual([]);
    expect(result.changes).toHaveLength(activeRoots.length * 2);
    for (const [index, storageRootDir] of activeRoots.entries()) {
      const store = await SqliteBackedMatrixSyncStore.create(storageRootDir);
      await expect(store.getSavedSyncToken()).resolves.toBe(`legacy-token-${index}`);
      expect(fs.existsSync(path.join(storageRootDir, "bot-storage.json"))).toBe(false);
      expect(fs.existsSync(path.join(storageRootDir, "bot-storage.json.migrated"))).toBe(true);
    }
    for (const storageRootDir of excludedRoots) {
      expect(fs.existsSync(path.join(storageRootDir, "bot-storage.json"))).toBe(true);
      expectRootNotVisited(visitedDirs, storageRootDir);
    }
  });

  it("imports dedupe state for archive-like account IDs without opening token archives", async () => {
    const stateDir = tempDirs.make("openclaw-matrix-doctor-");
    const { activeRoots, excludedRoots } = createStateRoots(stateDir);
    const now = Date.now();
    for (const [index, storageRootDir] of activeRoots.entries()) {
      writeSqliteDedupeSource(
        storageRootDir,
        index === 0 ? "sync-cache-backup" : "legacy",
        `$active-${index}`,
        now - 60_000,
      );
    }
    for (const storageRootDir of excludedRoots) {
      fs.mkdirSync(path.join(storageRootDir, "state"), { recursive: true });
      fs.writeFileSync(
        path.join(storageRootDir, "state", "openclaw.sqlite"),
        "archived SQLite sentinel must not be opened",
      );
      fs.writeFileSync(
        path.join(storageRootDir, "inbound-dedupe.json"),
        JSON.stringify({
          version: 1,
          entries: [{ key: "!room:example.org|$archived", ts: now - 60_000 }],
        }),
      );
    }

    const visitedDirs = trackVisitedDirectories();

    const result = await migrationById(
      "matrix-inbound-dedupe-to-claimable-dedupe",
    ).migrateLegacyState(createMigrationParams(stateDir));

    expect(result.warnings).toEqual([]);
    expect(result.changes).toEqual([
      "Migrated Matrix inbound dedupe markers to the claimable dedupe store (2 of 2 entries)",
      ...activeRoots.map(
        (storageRootDir) => `Retired Matrix inbound dedupe rows for ${storageRootDir}`,
      ),
      "Recorded Matrix inbound dedupe migration completion (2 SQLite roots scanned)",
    ]);
    for (const [index, accountId] of ["sync-cache-backup", "legacy"].entries()) {
      const deduper = createMatrixInboundEventDeduper({
        auth: { accountId },
        env: { OPENCLAW_STATE_DIR: stateDir },
      });
      await expect(
        deduper.claim({ roomId: "!room:example.org", eventId: `$active-${index}` }),
      ).resolves.toEqual({ kind: "duplicate" });
    }
    for (const storageRootDir of excludedRoots) {
      expect(fs.existsSync(path.join(storageRootDir, "inbound-dedupe.json"))).toBe(true);
      expect(fs.readFileSync(path.join(storageRootDir, "state", "openclaw.sqlite"), "utf8")).toBe(
        "archived SQLite sentinel must not be opened",
      );
      expectRootNotVisited(visitedDirs, storageRootDir);
    }
  });
});
