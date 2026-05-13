import fs from "node:fs";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { resetPluginStateStoreForTests } from "openclaw/plugin-sdk/plugin-state-runtime";
import { withTempHome } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it } from "vitest";
import { detectLegacyMatrixState } from "./doctor-legacy-state-detection.js";
import { autoMigrateLegacyMatrixState } from "./doctor-legacy-state.js";
import { SqliteBackedMatrixSyncStore } from "./matrix/client/sqlite-sync-store.js";
import { saveMatrixCredentialsState } from "./matrix/credentials-read.js";

function writeFile(filePath: string, value: string) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, value, "utf-8");
}

function writeLegacySyncStore(filePath: string) {
  writeFile(
    filePath,
    JSON.stringify({
      next_batch: "s1",
      rooms: { join: {}, invite: {}, leave: {}, knock: {} },
      account_data: { events: [] },
    }),
  );
}

describe("matrix legacy state migration", () => {
  afterEach(() => {
    resetPluginStateStoreForTests();
  });

  it("migrates the flat legacy Matrix store into account-scoped storage", async () => {
    await withTempHome(async (home) => {
      const stateDir = path.join(home, ".openclaw");
      writeLegacySyncStore(path.join(stateDir, "matrix", "bot-storage.json"));
      writeFile(path.join(stateDir, "matrix", "crypto", "store.db"), "crypto");

      const cfg: OpenClawConfig = {
        channels: {
          matrix: {
            homeserver: "https://matrix.example.org",
            userId: "@bot:example.org",
            accessToken: "tok-123",
          },
        },
      };

      const detection = detectLegacyMatrixState({ cfg, env: process.env });
      expect(detection && "warning" in detection).toBe(false);
      if (!detection || "warning" in detection) {
        throw new Error("expected a migratable Matrix legacy state plan");
      }

      const result = await autoMigrateLegacyMatrixState({ cfg, env: process.env });
      expect(result.migrated).toBe(true);
      expect(result.warnings).toStrictEqual([]);
      expect(fs.existsSync(path.join(stateDir, "matrix", "bot-storage.json"))).toBe(false);
      expect(fs.existsSync(path.join(stateDir, "matrix", "crypto"))).toBe(false);
      expect(fs.existsSync(path.join(detection.targetCryptoPath, "store.db"))).toBe(true);
      await expect(
        new SqliteBackedMatrixSyncStore(detection.targetRootDir).getSavedSyncToken(),
      ).resolves.toBe("s1");
    });
  });

  it("uses cached Matrix credentials when the config no longer stores an access token", async () => {
    await withTempHome(async (home) => {
      const stateDir = path.join(home, ".openclaw");
      writeLegacySyncStore(path.join(stateDir, "matrix", "bot-storage.json"));
      saveMatrixCredentialsState(
        {
          homeserver: "https://matrix.example.org",
          userId: "@bot:example.org",
          accessToken: "tok-from-cache",
          createdAt: "2026-04-05T00:00:00.000Z",
        },
        process.env,
      );

      const cfg: OpenClawConfig = {
        channels: {
          matrix: {
            homeserver: "https://matrix.example.org",
            userId: "@bot:example.org",
            password: "secret",
          },
        },
      };

      const detection = detectLegacyMatrixState({ cfg, env: process.env });
      expect(detection && "warning" in detection).toBe(false);
      if (!detection || "warning" in detection) {
        throw new Error("expected cached credentials to make Matrix migration resolvable");
      }

      expect(detection.targetRootDir).toContain("matrix.example.org__bot_example.org");

      const result = await autoMigrateLegacyMatrixState({ cfg, env: process.env });
      expect(result.migrated).toBe(true);
      await expect(
        new SqliteBackedMatrixSyncStore(detection.targetRootDir).getSavedSyncToken(),
      ).resolves.toBe("s1");
    });
  });
});
