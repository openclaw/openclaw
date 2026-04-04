import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyMatrixDoctorRepair,
  cleanStaleMatrixPluginConfig,
  collectMatrixInstallPathWarnings,
  formatMatrixLegacyCryptoPreview,
  formatMatrixLegacyStatePreview,
  matrixDoctor,
  runMatrixDoctorSequence,
} from "./doctor.js";

vi.mock("./matrix-migration.runtime.js", async () => {
  const actual = await vi.importActual<typeof import("./matrix-migration.runtime.js")>(
    "./matrix-migration.runtime.js",
  );
  return {
    ...actual,
    hasActionableMatrixMigration: vi.fn(() => false),
    hasPendingMatrixMigration: vi.fn(() => false),
    maybeCreateMatrixMigrationSnapshot: vi.fn(),
    autoMigrateLegacyMatrixState: vi.fn(async () => ({ changes: [], warnings: [] })),
    autoPrepareLegacyMatrixCrypto: vi.fn(async () => ({ changes: [], warnings: [] })),
  };
});

describe("matrix doctor", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("formats state and crypto previews", () => {
    expect(
      formatMatrixLegacyStatePreview({
        accountId: "default",
        legacyStoragePath: "/tmp/legacy-sync.json",
        targetStoragePath: "/tmp/new-sync.json",
        legacyCryptoPath: "/tmp/legacy-crypto.json",
        targetCryptoPath: "/tmp/new-crypto.json",
        selectionNote: "Picked the newest account.",
        targetRootDir: "/tmp/account-root",
      }),
    ).toContain("Matrix plugin upgraded in place.");

    const previews = formatMatrixLegacyCryptoPreview({
      warnings: ["matrix warning"],
      plans: [
        {
          accountId: "default",
          rootDir: "/tmp/account-root",
          homeserver: "https://matrix.example.org",
          userId: "@bot:example.org",
          accessToken: "tok-123",
          deviceId: "DEVICE123",
          legacyCryptoPath: "/tmp/legacy-crypto.json",
          recoveryKeyPath: "/tmp/recovery-key.txt",
          statePath: "/tmp/state.json",
        },
      ],
    });
    expect(previews[0]).toBe("- matrix warning");
    expect(previews[1]).toContain("/tmp/recovery-key.txt");
  });

  it("warns on stale custom Matrix plugin paths and cleans them", async () => {
    const missingPath = path.join(tmpdir(), `openclaw-matrix-missing-${Date.now()}`);
    await fs.rm(missingPath, { recursive: true, force: true });

    const warnings = await collectMatrixInstallPathWarnings({
      plugins: {
        installs: {
          matrix: { source: "path", sourcePath: missingPath, installPath: missingPath },
        },
      },
    });
    expect(warnings[0]).toContain("custom path that no longer exists");

    const cleaned = await cleanStaleMatrixPluginConfig({
      plugins: {
        installs: {
          matrix: { source: "path", sourcePath: missingPath, installPath: missingPath },
        },
        load: { paths: [missingPath, "/other/path"] },
        allow: ["matrix", "other-plugin"],
      },
    });
    expect(cleaned.changes[0]).toContain("Removed stale Matrix plugin references");
    expect(cleaned.config.plugins?.load?.paths).toEqual(["/other/path"]);
    expect(cleaned.config.plugins?.allow).toEqual(["other-plugin"]);
  });

  it("surfaces matrix sequence warnings and repair changes", async () => {
    const runtimeApi = await import("./matrix-migration.runtime.js");
    vi.mocked(runtimeApi.hasActionableMatrixMigration).mockReturnValue(true);
    vi.mocked(runtimeApi.maybeCreateMatrixMigrationSnapshot).mockResolvedValue({
      archivePath: "/tmp/matrix-backup.tgz",
      created: true,
      markerPath: "/tmp/marker.json",
    });
    vi.mocked(runtimeApi.autoMigrateLegacyMatrixState).mockResolvedValue({
      migrated: true,
      changes: ["Migrated legacy sync state"],
      warnings: [],
    });
    vi.mocked(runtimeApi.autoPrepareLegacyMatrixCrypto).mockResolvedValue({
      migrated: true,
      changes: ["Prepared recovery key export"],
      warnings: [],
    });

    const cfg = {
      channels: {
        matrix: {},
      },
    } as never;

    const repair = await applyMatrixDoctorRepair({ cfg, env: process.env });
    expect(repair.changes.join("\n")).toContain("Matrix migration snapshot");

    const sequence = await runMatrixDoctorSequence({
      cfg,
      env: process.env,
      shouldRepair: true,
    });
    expect(sequence.changeNotes.join("\n")).toContain("Matrix migration snapshot");
  });

  it("normalizes legacy Matrix room allow aliases to enabled", () => {
    const normalize = matrixDoctor.normalizeCompatibilityConfig;
    expect(normalize).toBeDefined();
    if (!normalize) {
      return;
    }

    const result = normalize({
      cfg: {
        channels: {
          matrix: {
            groups: {
              "!ops:example.org": {
                allow: true,
              },
            },
            accounts: {
              work: {
                rooms: {
                  "!legacy:example.org": {
                    allow: false,
                  },
                },
              },
            },
          },
        },
      } as never,
    });

    expect(result.config.channels?.matrix?.groups?.["!ops:example.org"]).toEqual({
      enabled: true,
    });
    expect(result.config.channels?.matrix?.accounts?.work?.rooms?.["!legacy:example.org"]).toEqual(
      {
        enabled: false,
      },
    );
    expect(result.changes).toEqual(
      expect.arrayContaining([
        "Moved channels.matrix.groups.!ops:example.org.allow → channels.matrix.groups.!ops:example.org.enabled (true).",
        "Moved channels.matrix.accounts.work.rooms.!legacy:example.org.allow → channels.matrix.accounts.work.rooms.!legacy:example.org.enabled (false).",
      ]),
    );
  });
});
