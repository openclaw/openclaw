import fs from "node:fs/promises";
import path from "node:path";
import { withTempHome } from "openclaw/plugin-sdk/test-env";
import { beforeEach, describe, expect, it, vi } from "vitest";

const legacyCryptoInspectorAvailability = vi.hoisted(() => ({
  available: true,
}));

vi.mock("./legacy-crypto-inspector-availability.js", () => ({
  isMatrixLegacyCryptoInspectorAvailable: () => legacyCryptoInspectorAvailability.available,
}));

import { runMatrixStartupMaintenance } from "./startup-maintenance.js";
import { resolveMatrixAccountStorageRoot } from "./storage-paths.js";

async function seedLegacyMatrixState(home: string) {
  const stateDir = path.join(home, ".openclaw");
  await fs.mkdir(path.join(stateDir, "matrix"), { recursive: true });
  await fs.writeFile(path.join(stateDir, "matrix", "bot-storage.json"), '{"legacy":true}');
}

function makeMatrixStartupConfig(includeCredentials = true) {
  return {
    channels: {
      matrix: includeCredentials
        ? {
            homeserver: "https://matrix.example.org",
            userId: "@bot:example.org",
            accessToken: "tok-123",
          }
        : {
            homeserver: "https://matrix.example.org",
          },
    },
  } as const;
}

async function seedLegacyMatrixCrypto(home: string) {
  const stateDir = path.join(home, ".openclaw");
  const { rootDir } = resolveMatrixAccountStorageRoot({
    stateDir,
    homeserver: "https://matrix.example.org",
    userId: "@bot:example.org",
    accessToken: "tok-123",
  });
  await fs.mkdir(path.join(rootDir, "crypto"), { recursive: true });
  await fs.writeFile(
    path.join(rootDir, "crypto", "bot-sdk.json"),
    JSON.stringify({ deviceId: "DEVICE123" }),
    "utf8",
  );
}

function createWarningOnlyMaintenanceHarness() {
  return {
    log: {
      info: vi.fn(),
      warn: vi.fn(),
    },
  };
}

function expectWarningOnlyMaintenanceSkipped(
  harness: ReturnType<typeof createWarningOnlyMaintenanceHarness>,
) {
  expect(harness.log.info).toHaveBeenCalledWith(
    "matrix: migration remains in a warning-only state; no pre-migration snapshot was needed yet",
  );
}

describe("runMatrixStartupMaintenance", () => {
  beforeEach(() => {
    legacyCryptoInspectorAvailability.available = true;
  });

  it("warns instead of migrating actionable legacy state during startup", async () => {
    await withTempHome(async (home) => {
      await seedLegacyMatrixState(home);
      const warn = vi.fn();

      await runMatrixStartupMaintenance({
        cfg: makeMatrixStartupConfig(),
        env: process.env,
        log: { warn },
      });

      await expect(
        fs.stat(path.join(home, ".openclaw", "matrix", "bot-storage.json")),
      ).resolves.toBeTruthy();
      expect(warn).toHaveBeenCalledWith(
        'gateway: legacy Matrix state needs migration. Run "openclaw doctor --fix" to create a migration snapshot and move legacy files; startup will not mutate legacy state.',
      );
    });
  });

  it("skips snapshot creation when startup only has warning-only migration state", async () => {
    await withTempHome(async (home) => {
      await seedLegacyMatrixState(home);
      const harness = createWarningOnlyMaintenanceHarness();

      await runMatrixStartupMaintenance({
        cfg: makeMatrixStartupConfig(false),
        env: process.env,
        log: harness.log,
      });

      expectWarningOnlyMaintenanceSkipped(harness);
      expect(harness.log.warn).toHaveBeenCalledWith(
        `matrix: Legacy Matrix state detected at ${path.join(home, ".openclaw", "matrix")}, but the new account-scoped target could not be resolved yet (need homeserver, userId, and access token for channels.matrix). Start the gateway once with a working Matrix login, or rerun "openclaw doctor --fix" after cached credentials are available.`,
      );
    });
  });

  it("logs the concrete unavailable-inspector warning when startup migration is warning-only", async () => {
    legacyCryptoInspectorAvailability.available = false;

    await withTempHome(async (home) => {
      await seedLegacyMatrixCrypto(home);
      const harness = createWarningOnlyMaintenanceHarness();

      await runMatrixStartupMaintenance({
        cfg: makeMatrixStartupConfig(),
        env: process.env,
        log: harness.log,
      });

      expectWarningOnlyMaintenanceSkipped(harness);
      expect(harness.log.warn).toHaveBeenCalledWith(
        "matrix: legacy encrypted-state warnings:\n- Legacy Matrix encrypted state was detected, but the Matrix crypto inspector is unavailable.",
      );
    });
  });

  it("does not create snapshots during startup", async () => {
    await withTempHome(async (home) => {
      await seedLegacyMatrixState(home);
      const warn = vi.fn();

      await runMatrixStartupMaintenance({
        cfg: makeMatrixStartupConfig(),
        env: process.env,
        log: { warn },
      });

      await expect(
        fs.stat(path.join(home, ".openclaw", "matrix-migration-snapshot.json")),
      ).rejects.toMatchObject({ code: "ENOENT" });
      expect(warn).toHaveBeenCalledWith(
        'gateway: legacy Matrix state needs migration. Run "openclaw doctor --fix" to create a migration snapshot and move legacy files; startup will not mutate legacy state.',
      );
    });
  });
});
