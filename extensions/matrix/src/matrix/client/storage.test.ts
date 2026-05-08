import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resetPluginStateStoreForTests } from "openclaw/plugin-sdk/plugin-state-runtime";
import { afterEach, describe, expect, it } from "vitest";
import { resolveMatrixAccountStorageRoot } from "../../storage-paths.js";
import { installMatrixTestRuntime } from "../../test-runtime.js";
import { readMatrixStorageMetadata, writeMatrixStorageMetadata } from "./storage-meta-state.js";
import {
  claimCurrentTokenStorageState,
  repairCurrentTokenStorageMetaDeviceId,
  resolveMatrixStateFilePath,
  resolveMatrixStoragePaths,
} from "./storage.js";
describe("matrix client storage paths", () => {
  const tempDirs: string[] = [];
  const defaultStorageAuth = {
    homeserver: "https://matrix.example.org",
    userId: "@bot:example.org",
    accessToken: "secret-token",
  };

  afterEach(() => {
    resetPluginStateStoreForTests();
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
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-matrix-storage-"));
    const stateDir = path.join(homeDir, ".openclaw");
    fs.mkdirSync(stateDir, { recursive: true });
    tempDirs.push(homeDir);
    installMatrixTestRuntime({
      cfg,
      logging: {
        getChildLogger: () => ({
          info: () => {},
          warn: () => {},
          error: () => {},
        }),
      },
      stateDir,
    });
    return stateDir;
  }

  function createMigrationEnv(stateDir: string): NodeJS.ProcessEnv {
    return {
      HOME: path.dirname(stateDir),
      OPENCLAW_HOME: path.dirname(stateDir),
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_TEST_FAST: "1",
    } as NodeJS.ProcessEnv;
  }

  function resolveDefaultStoragePaths(
    overrides: Partial<{
      homeserver: string;
      userId: string;
      accessToken: string;
      accountId: string;
      deviceId: string;
    }> = {},
  ) {
    return resolveMatrixStoragePaths({
      ...defaultStorageAuth,
      ...overrides,
      env: {},
    });
  }

  function setupCurrentTokenBackfillScenario(params: {
    currentRootFiles: "thread-bindings" | "startup-verification";
    oldRootFiles: "crypto-only" | "thread-bindings";
  }) {
    const stateDir = setupStateDir();
    const canonicalPaths = resolveMatrixAccountStorageRoot({
      stateDir,
      homeserver: defaultStorageAuth.homeserver,
      userId: defaultStorageAuth.userId,
      accessToken: "secret-token-new",
    });
    fs.mkdirSync(canonicalPaths.rootDir, { recursive: true });
    writeMatrixStorageMetadata(canonicalPaths.rootDir, {
      homeserver: defaultStorageAuth.homeserver,
      userId: defaultStorageAuth.userId,
      accountId: "default",
      accessTokenHash: canonicalPaths.tokenHash,
      deviceId: null,
    });
    if (params.currentRootFiles === "thread-bindings") {
      writeJson(canonicalPaths.rootDir, "thread-bindings.json", {
        version: 1,
        bindings: [
          {
            accountId: "default",
            conversationId: "$thread-new",
            targetKind: "subagent",
            targetSessionKey: "agent:ops:subagent:new",
            boundAt: 1,
            lastActivityAt: 1,
          },
        ],
      });
      expect(
        claimCurrentTokenStorageState({
          rootDir: canonicalPaths.rootDir,
        }),
      ).toBe(true);
    } else {
      writeJson(canonicalPaths.rootDir, "startup-verification.json", {
        deviceId: "DEVICE123",
      });
    }

    const oldStoragePaths = seedExistingStorageRoot({
      accessToken: "secret-token-old",
      deviceId: "DEVICE123",
      storageMeta: {
        homeserver: defaultStorageAuth.homeserver,
        userId: defaultStorageAuth.userId,
        accountId: "default",
        accessTokenHash: resolveDefaultStoragePaths({ accessToken: "secret-token-old" }).tokenHash,
        deviceId: "DEVICE123",
      },
    });
    fs.mkdirSync(oldStoragePaths.cryptoPath, { recursive: true });
    if (params.oldRootFiles === "thread-bindings") {
      writeJson(oldStoragePaths.rootDir, "thread-bindings.json", {
        version: 1,
        bindings: [
          {
            accountId: "default",
            conversationId: "$thread-old",
            targetKind: "subagent",
            targetSessionKey: "agent:ops:subagent:old",
            boundAt: 1,
            lastActivityAt: 1,
          },
        ],
      });
    } else {
      writeJson(oldStoragePaths.rootDir, "startup-verification.json", {
        deviceId: "DEVICE123",
      });
    }

    return { stateDir, canonicalPaths, oldStoragePaths };
  }

  it("resolves state file paths inside the selected storage root", () => {
    setupStateDir();
    const filePath = resolveMatrixStateFilePath({
      auth: {
        ...defaultStorageAuth,
        accountId: "ops",
        deviceId: "DEVICE1",
      },
      filename: "thread-bindings.json",
      env: {},
    });

    expect(filePath).toBe(
      path.join(
        resolveDefaultStoragePaths({ accountId: "ops", deviceId: "DEVICE1" }).rootDir,
        "thread-bindings.json",
      ),
    );
  });

  function writeJson(rootDir: string, filename: string, value: Record<string, unknown>) {
    fs.writeFileSync(path.join(rootDir, filename), JSON.stringify(value, null, 2));
  }

  function seedExistingStorageRoot(params: {
    accessToken: string;
    deviceId?: string;
    storageBody?: string;
    storageMeta?: Record<string, unknown>;
    startupVerificationDeviceId?: string;
  }) {
    const storagePaths = resolveDefaultStoragePaths({
      accessToken: params.accessToken,
      ...(params.deviceId ? { deviceId: params.deviceId } : {}),
    });
    fs.mkdirSync(storagePaths.rootDir, { recursive: true });
    fs.writeFileSync(storagePaths.storagePath, params.storageBody ?? '{"legacy":true}');
    if (params.storageMeta) {
      writeMatrixStorageMetadata(storagePaths.rootDir, params.storageMeta);
    }
    if (params.startupVerificationDeviceId) {
      writeJson(storagePaths.rootDir, "startup-verification.json", {
        deviceId: params.startupVerificationDeviceId,
      });
    }
    return storagePaths;
  }

  function seedCanonicalStorageRoot(params: {
    stateDir: string;
    accessToken: string;
    storageMeta: Record<string, unknown>;
  }) {
    const canonicalPaths = resolveMatrixAccountStorageRoot({
      stateDir: params.stateDir,
      homeserver: defaultStorageAuth.homeserver,
      userId: defaultStorageAuth.userId,
      accessToken: params.accessToken,
    });
    fs.mkdirSync(canonicalPaths.rootDir, { recursive: true });
    writeMatrixStorageMetadata(canonicalPaths.rootDir, params.storageMeta);
    return canonicalPaths;
  }

  function expectCanonicalRootForNewDevice(stateDir: string) {
    const newerCanonicalPaths = seedCanonicalStorageRoot({
      stateDir,
      accessToken: "secret-token-new",
      storageMeta: {
        homeserver: defaultStorageAuth.homeserver,
        userId: defaultStorageAuth.userId,
        accountId: "default",
        accessTokenHash: resolveDefaultStoragePaths({ accessToken: "secret-token-new" }).tokenHash,
        deviceId: "NEWDEVICE",
      },
    });

    const resolvedPaths = resolveDefaultStoragePaths({
      accessToken: "secret-token-new",
      deviceId: "NEWDEVICE",
    });

    expect(resolvedPaths.rootDir).toBe(newerCanonicalPaths.rootDir);
    expect(resolvedPaths.tokenHash).toBe(newerCanonicalPaths.tokenHash);
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

  it("keeps the canonical current-token storage root when deviceId is still unknown", () => {
    const stateDir = setupStateDir();
    const oldStoragePaths = seedExistingStorageRoot({
      accessToken: "secret-token-old",
    });

    const rotatedStoragePaths = resolveDefaultStoragePaths({
      accessToken: "secret-token-new",
    });
    const canonicalPaths = resolveMatrixAccountStorageRoot({
      stateDir,
      homeserver: defaultStorageAuth.homeserver,
      userId: defaultStorageAuth.userId,
      accessToken: "secret-token-new",
    });

    expect(rotatedStoragePaths.rootDir).toBe(canonicalPaths.rootDir);
    expect(rotatedStoragePaths.tokenHash).toBe(canonicalPaths.tokenHash);
    expect(rotatedStoragePaths.rootDir).not.toBe(oldStoragePaths.rootDir);
  });

  it("reuses an existing token-hash storage root for the same device after the access token changes", () => {
    setupStateDir();
    const oldStoragePaths = seedExistingStorageRoot({
      accessToken: "secret-token-old",
      deviceId: "DEVICE123",
      storageMeta: {
        homeserver: defaultStorageAuth.homeserver,
        userId: defaultStorageAuth.userId,
        accountId: "default",
        accessTokenHash: resolveDefaultStoragePaths({ accessToken: "secret-token-old" }).tokenHash,
        deviceId: "DEVICE123",
      },
    });

    const rotatedStoragePaths = resolveDefaultStoragePaths({
      accessToken: "secret-token-new",
      deviceId: "DEVICE123",
    });

    expect(rotatedStoragePaths.rootDir).toBe(oldStoragePaths.rootDir);
    expect(rotatedStoragePaths.tokenHash).toBe(oldStoragePaths.tokenHash);
    expect(rotatedStoragePaths.storagePath).toBe(oldStoragePaths.storagePath);
  });

  it("does not reuse a populated older token-hash root while deviceId is unknown", () => {
    const stateDir = setupStateDir();
    const oldStoragePaths = seedExistingStorageRoot({
      accessToken: "secret-token-old",
    });

    const newerCanonicalPaths = seedCanonicalStorageRoot({
      stateDir,
      accessToken: "secret-token-new",
      storageMeta: {
        accessTokenHash: resolveDefaultStoragePaths({ accessToken: "secret-token-new" }).tokenHash,
      },
    });

    const resolvedPaths = resolveDefaultStoragePaths({
      accessToken: "secret-token-new",
    });

    expect(resolvedPaths.rootDir).toBe(newerCanonicalPaths.rootDir);
    expect(resolvedPaths.tokenHash).toBe(newerCanonicalPaths.tokenHash);
    expect(resolvedPaths.rootDir).not.toBe(oldStoragePaths.rootDir);
  });

  it("does not reuse a populated sibling storage root from a different device", () => {
    const stateDir = setupStateDir();
    seedExistingStorageRoot({
      accessToken: "secret-token-old",
      deviceId: "OLDDEVICE",
      storageMeta: {
        homeserver: defaultStorageAuth.homeserver,
        userId: defaultStorageAuth.userId,
        accountId: "default",
        accessTokenHash: resolveDefaultStoragePaths({ accessToken: "secret-token-old" }).tokenHash,
        deviceId: "OLDDEVICE",
      },
    });
    expectCanonicalRootForNewDevice(stateDir);
  });

  it("does not reuse a populated sibling storage root with ambiguous device metadata", () => {
    const stateDir = setupStateDir();
    seedExistingStorageRoot({
      accessToken: "secret-token-old",
    });
    expectCanonicalRootForNewDevice(stateDir);
  });

  it("keeps the current-token storage root stable after deviceId backfill when startup claimed state there", () => {
    const { stateDir, canonicalPaths } = setupCurrentTokenBackfillScenario({
      currentRootFiles: "thread-bindings",
      oldRootFiles: "crypto-only",
    });

    repairCurrentTokenStorageMetaDeviceId({
      homeserver: defaultStorageAuth.homeserver,
      userId: defaultStorageAuth.userId,
      accessToken: "secret-token-new",
      accountId: "default",
      deviceId: "DEVICE123",
      env: createMigrationEnv(stateDir),
    });

    const repairedMeta = readMatrixStorageMetadata(canonicalPaths.rootDir);
    expect(repairedMeta.deviceId).toBe("DEVICE123");
    const startupPaths = resolveDefaultStoragePaths({
      accessToken: "secret-token-new",
    });
    expect(startupPaths.rootDir).toBe(canonicalPaths.rootDir);
    const restartedPaths = resolveDefaultStoragePaths({
      accessToken: "secret-token-new",
      deviceId: "DEVICE123",
    });
    expect(restartedPaths.rootDir).toBe(canonicalPaths.rootDir);
  });

  it("does not keep the current-token storage root sticky when only marker files exist after backfill", () => {
    const { stateDir, oldStoragePaths } = setupCurrentTokenBackfillScenario({
      currentRootFiles: "startup-verification",
      oldRootFiles: "thread-bindings",
    });

    repairCurrentTokenStorageMetaDeviceId({
      homeserver: defaultStorageAuth.homeserver,
      userId: defaultStorageAuth.userId,
      accessToken: "secret-token-new",
      accountId: "default",
      deviceId: "DEVICE123",
      env: createMigrationEnv(stateDir),
    });

    const restartedPaths = resolveDefaultStoragePaths({
      accessToken: "secret-token-new",
      deviceId: "DEVICE123",
    });
    expect(restartedPaths.rootDir).toBe(oldStoragePaths.rootDir);
  });
});
