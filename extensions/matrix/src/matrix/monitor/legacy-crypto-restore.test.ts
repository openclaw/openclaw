import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { withTempHome } from "../../../../../test/helpers/temp-home.js";
import { resolveMatrixAccountStorageRoot } from "../../../runtime-api.js";
import { maybeRestoreLegacyMatrixBackup } from "./legacy-crypto-restore.js";

function createBackupStatus() {
  return {
    serverVersion: "1",
    activeVersion: "1",
    trusted: true,
    matchesDecryptionKey: true,
    decryptionKeyCached: true,
    keyLoadAttempted: true,
    keyLoadError: null,
  };
}

function writeFile(filePath: string, value: string) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, value, "utf8");
}

describe("maybeRestoreLegacyMatrixBackup", () => {
  it("marks pending legacy backup restore as completed after success", async () => {
    await withTempHome(async (home) => {
      const stateDir = path.join(home, ".openclaw");
      const auth = {
        accountId: "default",
        homeserver: "https://matrix.example.org",
        userId: "@bot:example.org",
        accessToken: "tok-123",
      };
      const { rootDir } = resolveMatrixAccountStorageRoot({
        stateDir,
        ...auth,
      });
      writeFile(
        path.join(rootDir, "legacy-crypto-migration.json"),
        JSON.stringify({
          version: 1,
          accountId: "default",
          roomKeyCounts: { total: 10, backedUp: 8 },
          restoreStatus: "pending",
        }),
      );

      const restoreRoomKeyBackup = vi.fn(async () => ({
        success: true,
        restoredAt: "2026-03-08T10:00:00.000Z",
        imported: 8,
        total: 8,
        loadedFromSecretStorage: true,
        backupVersion: "1",
        backup: createBackupStatus(),
      }));

      const result = await maybeRestoreLegacyMatrixBackup({
        client: { restoreRoomKeyBackup },
        auth,
        stateDir,
        env: {
          ...process.env,
          OPENCLAW_STATE_DIR: stateDir,
          HOME: home,
        },
      });

      expect(result).toEqual({
        kind: "restored",
        imported: 8,
        total: 8,
        localOnlyKeys: 2,
      });
      const state = JSON.parse(
        fs.readFileSync(path.join(rootDir, "legacy-crypto-migration.json"), "utf8"),
      ) as {
        restoreStatus: string;
        importedCount: number;
        totalCount: number;
      };
      expect(state.restoreStatus).toBe("completed");
      expect(state.importedCount).toBe(8);
      expect(state.totalCount).toBe(8);
    });
  });

  it("keeps the restore pending when startup restore fails", async () => {
    await withTempHome(async (home) => {
      const stateDir = path.join(home, ".openclaw");
      const auth = {
        accountId: "default",
        homeserver: "https://matrix.example.org",
        userId: "@bot:example.org",
        accessToken: "tok-123",
      };
      const { rootDir } = resolveMatrixAccountStorageRoot({
        stateDir,
        ...auth,
      });
      writeFile(
        path.join(rootDir, "legacy-crypto-migration.json"),
        JSON.stringify({
          version: 1,
          accountId: "default",
          roomKeyCounts: { total: 5, backedUp: 5 },
          restoreStatus: "pending",
        }),
      );

      const result = await maybeRestoreLegacyMatrixBackup({
        client: {
          restoreRoomKeyBackup: async () => ({
            success: false,
            error: "backup unavailable",
            imported: 0,
            total: 0,
            loadedFromSecretStorage: false,
            backupVersion: null,
            backup: createBackupStatus(),
          }),
        },
        auth,
        stateDir,
        env: {
          ...process.env,
          OPENCLAW_STATE_DIR: stateDir,
          HOME: home,
        },
      });

      expect(result).toEqual({
        kind: "failed",
        error: "backup unavailable",
        localOnlyKeys: 0,
      });
      const state = JSON.parse(
        fs.readFileSync(path.join(rootDir, "legacy-crypto-migration.json"), "utf8"),
      ) as {
        restoreStatus: string;
        lastError: string;
      };
      expect(state.restoreStatus).toBe("pending");
      expect(state.lastError).toBe("backup unavailable");
    });
  });

  it("restores from a sibling token-hash directory when the access token changed", async () => {
    await withTempHome(async (home) => {
      const stateDir = path.join(home, ".openclaw");
      const oldAuth = {
        accountId: "default",
        homeserver: "https://matrix.example.org",
        userId: "@bot:example.org",
        accessToken: "tok-old",
      };
      const newAuth = {
        ...oldAuth,
        accessToken: "tok-new",
      };
      const { rootDir: oldRootDir } = resolveMatrixAccountStorageRoot({
        stateDir,
        ...oldAuth,
      });
      const { rootDir: newRootDir } = resolveMatrixAccountStorageRoot({
        stateDir,
        ...newAuth,
      });
      writeFile(
        path.join(oldRootDir, "legacy-crypto-migration.json"),
        JSON.stringify({
          version: 1,
          accountId: "default",
          roomKeyCounts: { total: 3, backedUp: 3 },
          restoreStatus: "pending",
        }),
      );

      const restoreRoomKeyBackup = vi.fn(async () => ({
        success: true,
        restoredAt: "2026-03-08T10:00:00.000Z",
        imported: 3,
        total: 3,
        loadedFromSecretStorage: true,
        backupVersion: "1",
        backup: createBackupStatus(),
      }));

      const result = await maybeRestoreLegacyMatrixBackup({
        client: { restoreRoomKeyBackup },
        auth: newAuth,
        stateDir,
        env: {
          ...process.env,
          OPENCLAW_STATE_DIR: stateDir,
          HOME: home,
        },
      });

      expect(result).toEqual({
        kind: "restored",
        imported: 3,
        total: 3,
        localOnlyKeys: 0,
      });
      const oldState = JSON.parse(
        fs.readFileSync(path.join(oldRootDir, "legacy-crypto-migration.json"), "utf8"),
      ) as {
        restoreStatus: string;
      };
      expect(oldState.restoreStatus).toBe("completed");
      expect(fs.existsSync(path.join(newRootDir, "legacy-crypto-migration.json"))).toBe(false);
    });
  });
});
