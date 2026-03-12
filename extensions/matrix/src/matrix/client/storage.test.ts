import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveMatrixAccountStorageRoot } from "openclaw/plugin-sdk/matrix";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setMatrixRuntime } from "../../runtime.js";
import { maybeMigrateLegacyStorage, resolveMatrixStoragePaths } from "./storage.js";

const maybeCreateMatrixMigrationSnapshotMock = vi.hoisted(() =>
  vi.fn(async (_params: unknown) => undefined),
);

vi.mock("openclaw/plugin-sdk/matrix", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/matrix")>();
  return {
    ...actual,
    maybeCreateMatrixMigrationSnapshot: (params: unknown) =>
      maybeCreateMatrixMigrationSnapshotMock(params),
  };
});

describe("matrix client storage paths", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    maybeCreateMatrixMigrationSnapshotMock.mockReset();
    vi.restoreAllMocks();
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  function setupStateDir(
    cfg: Record<string, unknown> = {
      channels: {
        matrix: {},
      },
    },
  ): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-matrix-storage-"));
    tempDirs.push(dir);
    setMatrixRuntime({
      config: {
        loadConfig: () => cfg,
      },
      logging: {
        getChildLogger: () => ({
          info: () => {},
          warn: () => {},
          error: () => {},
        }),
      },
      state: {
        resolveStateDir: () => dir,
      },
    } as never);
    return dir;
  }

  it("uses the simplified matrix runtime root for account-scoped storage", () => {
    const stateDir = setupStateDir();

    const storagePaths = resolveMatrixStoragePaths({
      homeserver: "https://matrix.example.org",
      userId: "@Bot:example.org",
      accessToken: "secret-token",
      accountId: "ops",
      env: {},
    });

    expect(storagePaths.rootDir).toBe(
      path.join(
        stateDir,
        "matrix",
        "accounts",
        "ops",
        "matrix.example.org__bot_example.org",
        storagePaths.tokenHash,
      ),
    );
    expect(storagePaths.storagePath).toBe(path.join(storagePaths.rootDir, "bot-storage.json"));
    expect(storagePaths.cryptoPath).toBe(path.join(storagePaths.rootDir, "crypto"));
    expect(storagePaths.metaPath).toBe(path.join(storagePaths.rootDir, "storage-meta.json"));
    expect(storagePaths.recoveryKeyPath).toBe(path.join(storagePaths.rootDir, "recovery-key.json"));
    expect(storagePaths.idbSnapshotPath).toBe(
      path.join(storagePaths.rootDir, "crypto-idb-snapshot.json"),
    );
  });

  it("falls back to migrating the older flat matrix storage layout", async () => {
    const stateDir = setupStateDir();
    const storagePaths = resolveMatrixStoragePaths({
      homeserver: "https://matrix.example.org",
      userId: "@bot:example.org",
      accessToken: "secret-token",
      env: {},
    });
    const legacyRoot = path.join(stateDir, "matrix");
    fs.mkdirSync(path.join(legacyRoot, "crypto"), { recursive: true });
    fs.writeFileSync(path.join(legacyRoot, "bot-storage.json"), '{"legacy":true}');

    await maybeMigrateLegacyStorage({
      storagePaths,
      env: {},
    });

    expect(maybeCreateMatrixMigrationSnapshotMock).toHaveBeenCalledWith(
      expect.objectContaining({ trigger: "matrix-client-fallback" }),
    );
    expect(fs.existsSync(path.join(legacyRoot, "bot-storage.json"))).toBe(false);
    expect(fs.readFileSync(storagePaths.storagePath, "utf8")).toBe('{"legacy":true}');
    expect(fs.existsSync(storagePaths.cryptoPath)).toBe(true);
  });

  it("continues migrating whichever legacy artifact is still missing", async () => {
    const stateDir = setupStateDir();
    const storagePaths = resolveMatrixStoragePaths({
      homeserver: "https://matrix.example.org",
      userId: "@bot:example.org",
      accessToken: "secret-token",
      env: {},
    });
    const legacyRoot = path.join(stateDir, "matrix");
    fs.mkdirSync(storagePaths.rootDir, { recursive: true });
    fs.writeFileSync(storagePaths.storagePath, '{"new":true}');
    fs.mkdirSync(path.join(legacyRoot, "crypto"), { recursive: true });

    await maybeMigrateLegacyStorage({
      storagePaths,
      env: {},
    });

    expect(maybeCreateMatrixMigrationSnapshotMock).toHaveBeenCalledWith(
      expect.objectContaining({ trigger: "matrix-client-fallback" }),
    );
    expect(fs.readFileSync(storagePaths.storagePath, "utf8")).toBe('{"new":true}');
    expect(fs.existsSync(path.join(legacyRoot, "crypto"))).toBe(false);
    expect(fs.existsSync(storagePaths.cryptoPath)).toBe(true);
  });

  it("refuses to migrate legacy storage when the snapshot step fails", async () => {
    const stateDir = setupStateDir();
    const storagePaths = resolveMatrixStoragePaths({
      homeserver: "https://matrix.example.org",
      userId: "@bot:example.org",
      accessToken: "secret-token",
      env: {},
    });
    const legacyRoot = path.join(stateDir, "matrix");
    fs.mkdirSync(path.join(legacyRoot, "crypto"), { recursive: true });
    fs.writeFileSync(path.join(legacyRoot, "bot-storage.json"), '{"legacy":true}');
    maybeCreateMatrixMigrationSnapshotMock.mockRejectedValueOnce(new Error("snapshot failed"));

    await expect(
      maybeMigrateLegacyStorage({
        storagePaths,
        env: {},
      }),
    ).rejects.toThrow("snapshot failed");
    expect(fs.existsSync(path.join(legacyRoot, "bot-storage.json"))).toBe(true);
    expect(fs.existsSync(storagePaths.storagePath)).toBe(false);
  });

  it("rolls back moved legacy storage when the crypto move fails", async () => {
    const stateDir = setupStateDir();
    const storagePaths = resolveMatrixStoragePaths({
      homeserver: "https://matrix.example.org",
      userId: "@bot:example.org",
      accessToken: "secret-token",
      env: {},
    });
    const legacyRoot = path.join(stateDir, "matrix");
    fs.mkdirSync(path.join(legacyRoot, "crypto"), { recursive: true });
    fs.writeFileSync(path.join(legacyRoot, "bot-storage.json"), '{"legacy":true}');
    const realRenameSync = fs.renameSync.bind(fs);
    const renameSync = vi.spyOn(fs, "renameSync");
    renameSync.mockImplementation((sourcePath, targetPath) => {
      if (String(targetPath) === storagePaths.cryptoPath) {
        throw new Error("disk full");
      }
      return realRenameSync(sourcePath, targetPath);
    });

    await expect(
      maybeMigrateLegacyStorage({
        storagePaths,
        env: {},
      }),
    ).rejects.toThrow("disk full");
    expect(fs.existsSync(path.join(legacyRoot, "bot-storage.json"))).toBe(true);
    expect(fs.existsSync(storagePaths.storagePath)).toBe(false);
    expect(fs.existsSync(path.join(legacyRoot, "crypto"))).toBe(true);
  });

  it("refuses fallback migration when multiple Matrix accounts need explicit selection", async () => {
    const stateDir = setupStateDir({
      channels: {
        matrix: {
          accounts: {
            ops: {},
            work: {},
          },
        },
      },
    });
    const storagePaths = resolveMatrixStoragePaths({
      homeserver: "https://matrix.example.org",
      userId: "@bot:example.org",
      accessToken: "secret-token",
      accountId: "ops",
      env: {},
    });
    const legacyRoot = path.join(stateDir, "matrix");
    fs.mkdirSync(path.join(legacyRoot, "crypto"), { recursive: true });
    fs.writeFileSync(path.join(legacyRoot, "bot-storage.json"), '{"legacy":true}');

    await expect(
      maybeMigrateLegacyStorage({
        storagePaths,
        env: {},
      }),
    ).rejects.toThrow(/defaultAccount is not set/i);
    expect(maybeCreateMatrixMigrationSnapshotMock).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(legacyRoot, "bot-storage.json"))).toBe(true);
  });

  it("refuses fallback migration for a non-selected Matrix account", async () => {
    const stateDir = setupStateDir({
      channels: {
        matrix: {
          defaultAccount: "ops",
          homeserver: "https://matrix.default.example.org",
          accessToken: "default-token",
          accounts: {
            ops: {
              homeserver: "https://matrix.ops.example.org",
              accessToken: "ops-token",
            },
          },
        },
      },
    });
    const storagePaths = resolveMatrixStoragePaths({
      homeserver: "https://matrix.default.example.org",
      userId: "@default:example.org",
      accessToken: "default-token",
      env: {},
    });
    const legacyRoot = path.join(stateDir, "matrix");
    fs.mkdirSync(path.join(legacyRoot, "crypto"), { recursive: true });
    fs.writeFileSync(path.join(legacyRoot, "bot-storage.json"), '{"legacy":true}');

    await expect(
      maybeMigrateLegacyStorage({
        storagePaths,
        env: {},
      }),
    ).rejects.toThrow(/targets account "ops"/i);
    expect(maybeCreateMatrixMigrationSnapshotMock).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(legacyRoot, "bot-storage.json"))).toBe(true);
  });

  it("reuses an existing token-hash storage root after the access token changes", () => {
    const stateDir = setupStateDir();
    const oldStoragePaths = resolveMatrixStoragePaths({
      homeserver: "https://matrix.example.org",
      userId: "@bot:example.org",
      accessToken: "secret-token-old",
      env: {},
    });
    fs.mkdirSync(oldStoragePaths.rootDir, { recursive: true });
    fs.writeFileSync(oldStoragePaths.storagePath, '{"legacy":true}');

    const rotatedStoragePaths = resolveMatrixStoragePaths({
      homeserver: "https://matrix.example.org",
      userId: "@bot:example.org",
      accessToken: "secret-token-new",
      env: {},
    });

    expect(rotatedStoragePaths.rootDir).toBe(oldStoragePaths.rootDir);
    expect(rotatedStoragePaths.tokenHash).toBe(oldStoragePaths.tokenHash);
    expect(rotatedStoragePaths.storagePath).toBe(oldStoragePaths.storagePath);
  });

  it("prefers a populated older token-hash storage root over a newer empty root", () => {
    const stateDir = setupStateDir();
    const oldStoragePaths = resolveMatrixStoragePaths({
      homeserver: "https://matrix.example.org",
      userId: "@bot:example.org",
      accessToken: "secret-token-old",
      env: {},
    });
    fs.mkdirSync(oldStoragePaths.rootDir, { recursive: true });
    fs.writeFileSync(oldStoragePaths.storagePath, '{"legacy":true}');

    const newerCanonicalPaths = resolveMatrixAccountStorageRoot({
      stateDir,
      homeserver: "https://matrix.example.org",
      userId: "@bot:example.org",
      accessToken: "secret-token-new",
    });
    fs.mkdirSync(newerCanonicalPaths.rootDir, { recursive: true });
    fs.writeFileSync(
      path.join(newerCanonicalPaths.rootDir, "storage-meta.json"),
      JSON.stringify({ accessTokenHash: newerCanonicalPaths.tokenHash }, null, 2),
    );

    const resolvedPaths = resolveMatrixStoragePaths({
      homeserver: "https://matrix.example.org",
      userId: "@bot:example.org",
      accessToken: "secret-token-new",
      env: {},
    });

    expect(resolvedPaths.rootDir).toBe(oldStoragePaths.rootDir);
    expect(resolvedPaths.tokenHash).toBe(oldStoragePaths.tokenHash);
  });
});
