import "fake-indexeddb/auto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  resetPluginBlobStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-runtime";
import { getSessionBindingService, __testing } from "openclaw/plugin-sdk/session-binding-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MATRIX_LEGACY_CRYPTO_MIGRATION_FILENAME,
  readMatrixLegacyCryptoMigrationState,
} from "./legacy-crypto-migration-state.js";
import { FileBackedMatrixSyncStore } from "./matrix/client/file-sync-store.js";
import { readMatrixStorageMetadata } from "./matrix/client/storage-meta-state.js";
import { createMatrixInboundEventDeduper } from "./matrix/monitor/inbound-dedupe.js";
import { restoreIdbFromState } from "./matrix/sdk/idb-persistence.js";
import {
  clearAllIndexedDbState,
  readDatabaseRecords,
} from "./matrix/sdk/idb-persistence.test-helpers.js";
import { resetMatrixThreadBindingsForTests } from "./matrix/thread-bindings-shared.js";
import { createMatrixThreadBindingManager } from "./matrix/thread-bindings.js";
import { detectMatrixLegacyStateMigrations } from "./state-migrations.js";
import { installMatrixTestRuntime } from "./test-runtime.js";

const tempDirs: string[] = [];

const auth = {
  accountId: "ops",
  homeserver: "https://matrix.example.org",
  userId: "@bot:example.org",
  accessToken: "token",
  deviceId: "DEVICE",
  encryption: true,
} as const;

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  resetMatrixThreadBindingsForTests();
  __testing.resetSessionBindingAdaptersForTests();
  resetPluginStateStoreForTests();
  resetPluginBlobStoreForTests();
  await clearAllIndexedDbState({ databasePrefix: "openclaw-matrix-migration-test" });
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeStateDir(): string {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-matrix-migrate-"));
  tempDirs.push(stateDir);
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  installMatrixTestRuntime({ stateDir });
  return stateDir;
}

function makeLegacyAccountRoot(stateDir: string): string {
  const root = path.join(
    stateDir,
    "matrix",
    "accounts",
    "ops",
    "matrix.example.org__bot_example.org",
    "tokenhash",
  );
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(
    path.join(root, "storage-meta.json"),
    `${JSON.stringify({
      homeserver: auth.homeserver,
      userId: auth.userId,
      accountId: auth.accountId,
      deviceId: auth.deviceId,
    })}\n`,
  );
  return root;
}

async function applyPlan(stateDir: string, label: string) {
  const plan = detectMatrixLegacyStateMigrations({ stateDir }).find(
    (entry) => entry.label === label,
  );
  if (!plan || plan.kind !== "custom") {
    throw new Error(`missing Matrix migration plan: ${label}`);
  }
  return await plan.apply({
    cfg: {},
    env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
    stateDir,
    oauthDir: path.join(stateDir, "oauth"),
  });
}

describe("Matrix legacy state migrations", () => {
  it("imports sync store files into SQLite plugin state", async () => {
    const stateDir = makeStateDir();
    const legacyRoot = makeLegacyAccountRoot(stateDir);
    const storageFile = path.join(legacyRoot, "bot-storage.json");
    fs.writeFileSync(
      storageFile,
      `${JSON.stringify({
        version: 1,
        savedSync: {
          nextBatch: "sync-token",
          accountData: [],
          roomsData: {
            join: {},
            invite: {},
            leave: {},
            knock: {},
          },
        },
        cleanShutdown: true,
      })}\n`,
    );

    await applyPlan(stateDir, "Matrix sync store");

    const store = new FileBackedMatrixSyncStore(storageFile);
    expect(store.hasSavedSync()).toBe(true);
    expect(store.hasSavedSyncFromCleanShutdown()).toBe(true);
    await expect(store.getSavedSyncToken()).resolves.toBe("sync-token");
    expect(fs.existsSync(storageFile)).toBe(false);
  });

  it("imports storage metadata into SQLite plugin state", async () => {
    const stateDir = makeStateDir();
    const legacyRoot = makeLegacyAccountRoot(stateDir);
    const metadataFile = path.join(legacyRoot, "storage-meta.json");

    await applyPlan(stateDir, "Matrix storage metadata");

    expect(readMatrixStorageMetadata(legacyRoot)).toMatchObject({
      homeserver: auth.homeserver,
      userId: auth.userId,
      accountId: auth.accountId,
      deviceId: auth.deviceId,
    });
    expect(fs.existsSync(metadataFile)).toBe(false);
  });

  it("imports legacy crypto migration state into SQLite plugin state", async () => {
    const stateDir = makeStateDir();
    const legacyRoot = makeLegacyAccountRoot(stateDir);
    const migrationFile = path.join(legacyRoot, MATRIX_LEGACY_CRYPTO_MIGRATION_FILENAME);
    fs.writeFileSync(
      migrationFile,
      `${JSON.stringify({
        version: 1,
        source: "matrix-bot-sdk-rust",
        accountId: "ops",
        deviceId: auth.deviceId,
        roomKeyCounts: { total: 3, backedUp: 2 },
        backupVersion: "1",
        decryptionKeyImported: true,
        restoreStatus: "pending",
        detectedAt: "2026-03-08T12:00:00.000Z",
        lastError: null,
      })}\n`,
    );

    await applyPlan(stateDir, "Matrix legacy crypto migration state");

    await expect(readMatrixLegacyCryptoMigrationState(migrationFile)).resolves.toMatchObject({
      accountId: "ops",
      restoreStatus: "pending",
      roomKeyCounts: { total: 3, backedUp: 2 },
    });
    expect(fs.existsSync(migrationFile)).toBe(false);
  });

  it("imports IndexedDB crypto snapshots into SQLite plugin blobs", async () => {
    const stateDir = makeStateDir();
    const legacyRoot = makeLegacyAccountRoot(stateDir);
    const snapshotFile = path.join(legacyRoot, "crypto-idb-snapshot.json");
    const databaseName = "openclaw-matrix-migration-test::matrix-sdk-crypto";
    fs.writeFileSync(
      snapshotFile,
      `${JSON.stringify([
        {
          name: databaseName,
          version: 1,
          stores: [
            {
              name: "sessions",
              keyPath: null,
              autoIncrement: false,
              indexes: [],
              records: [{ key: "room-1", value: { session: "abc123" } }],
            },
          ],
        },
      ])}\n`,
    );

    await applyPlan(stateDir, "Matrix IndexedDB snapshot");

    expect(fs.existsSync(snapshotFile)).toBe(false);
    expect(await restoreIdbFromState(snapshotFile)).toBe(true);
    await expect(
      readDatabaseRecords({
        name: databaseName,
        storeName: "sessions",
      }),
    ).resolves.toEqual([{ key: "room-1", value: { session: "abc123" } }]);
  });

  it("imports thread bindings into SQLite plugin state", async () => {
    const stateDir = makeStateDir();
    const legacyRoot = makeLegacyAccountRoot(stateDir);
    const bindingsFile = path.join(legacyRoot, "thread-bindings.json");
    fs.writeFileSync(
      bindingsFile,
      `${JSON.stringify({
        version: 1,
        bindings: [
          {
            conversationId: "$thread",
            parentConversationId: "!room:example",
            targetKind: "subagent",
            targetSessionKey: "agent:ops:subagent:child",
            boundAt: 1_800,
            lastActivityAt: 1_900,
          },
        ],
      })}\n`,
    );

    await applyPlan(stateDir, "Matrix thread binding");

    await createMatrixThreadBindingManager({
      cfg: {},
      accountId: "ops",
      auth,
      client: {} as never,
      stateDir,
      idleTimeoutMs: 24 * 60 * 60 * 1000,
      maxAgeMs: 0,
      enableSweeper: false,
    });
    expect(
      getSessionBindingService().resolveByConversation({
        channel: "matrix",
        accountId: "ops",
        conversationId: "$thread",
        parentConversationId: "!room:example",
      }),
    ).toMatchObject({
      targetSessionKey: "agent:ops:subagent:child",
    });
    expect(fs.existsSync(bindingsFile)).toBe(false);
  });

  it("imports inbound dedupe entries into SQLite plugin state", async () => {
    const stateDir = makeStateDir();
    const legacyRoot = makeLegacyAccountRoot(stateDir);
    const dedupeFile = path.join(legacyRoot, "inbound-dedupe.json");
    fs.writeFileSync(
      dedupeFile,
      `${JSON.stringify({
        version: 1,
        entries: [{ key: "!room:example|$event", ts: Date.now() }],
      })}\n`,
    );

    await applyPlan(stateDir, "Matrix inbound dedupe");

    const deduper = await createMatrixInboundEventDeduper({
      auth,
      stateDir,
    });
    expect(deduper.claimEvent({ roomId: "!room:example", eventId: "$event" })).toBe(false);
    expect(fs.existsSync(dedupeFile)).toBe(false);
  });

  it("imports startup verification state into SQLite plugin state", async () => {
    const stateDir = makeStateDir();
    const legacyRoot = makeLegacyAccountRoot(stateDir);
    const verificationFile = path.join(legacyRoot, "startup-verification.json");
    fs.writeFileSync(
      verificationFile,
      `${JSON.stringify({
        userId: auth.userId,
        deviceId: auth.deviceId,
        attemptedAt: "2026-03-08T12:00:00.000Z",
        outcome: "requested",
        requestId: "verification-1",
        transactionId: "txn-1",
      })}\n`,
    );

    await applyPlan(stateDir, "Matrix startup verification");

    const requestVerification = vi.fn(async () => ({
      id: "verification-2",
      transactionId: "txn-2",
    }));
    const { ensureMatrixStartupVerification } =
      await import("./matrix/monitor/startup-verification.js");
    const result = await ensureMatrixStartupVerification({
      auth,
      accountConfig: {},
      nowMs: Date.parse("2026-03-08T12:05:00.000Z"),
      client: {
        getOwnDeviceVerificationStatus: async () => ({
          encryptionEnabled: true,
          userId: auth.userId,
          deviceId: auth.deviceId,
          verified: false,
          localVerified: false,
          crossSigningVerified: false,
          signedByOwner: false,
          recoveryKeyStored: false,
          recoveryKeyCreatedAt: null,
          recoveryKeyId: null,
          backupVersion: null,
          backup: {
            serverVersion: null,
            activeVersion: null,
            trusted: null,
            matchesDecryptionKey: null,
            decryptionKeyCached: null,
            keyLoadAttempted: false,
            keyLoadError: null,
          },
        }),
        crypto: {
          listVerifications: async () => [],
          requestVerification,
        },
      } as never,
    });

    expect(result.kind).toBe("cooldown");
    expect(requestVerification).not.toHaveBeenCalled();
    expect(fs.existsSync(verificationFile)).toBe(false);
  });
});
