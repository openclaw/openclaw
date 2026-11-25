import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { OpenKeyedStoreOptions } from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  createPluginStateKeyedStoreForTests,
  createPluginStateSyncKeyedStoreForTests,
  createChannelIngressQueueForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import type { PluginDoctorStateMigrationContext } from "openclaw/plugin-sdk/runtime-doctor-migrations";
import type { MatrixStoredCredentialRecord } from "./src/matrix/credentials-state.js";

export const MATRIX_INBOUND_DEDUPE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export function createContext(
  env?: NodeJS.ProcessEnv,
  inheritStoreEnv = true,
): PluginDoctorStateMigrationContext {
  const openQueue = <TPayload, TMetadata = unknown, TCompletedMetadata = unknown>({
    accountId,
  }: { accountId?: string } = {}) =>
    createChannelIngressQueueForTests<TPayload, TMetadata, TCompletedMetadata>({
      channelId: "matrix",
      accountId,
      stateDir: env?.OPENCLAW_STATE_DIR,
    });
  return {
    readPluginStateEntriesInKeyRange(namespace, range) {
      return createPluginStateSyncKeyedStoreForTests<unknown>("matrix", {
        namespace,
        maxEntries: 20_000,
        defaultTtlMs: MATRIX_INBOUND_DEDUPE_TTL_MS,
        env,
      })
        .entries()
        .filter(({ key }) => key.startsWith(range.prefix) && (!range.after || key > range.after))
        .toSorted((a, b) => a.key.localeCompare(b.key))
        .slice(0, range.limit)
        .map((entry) =>
          Object.assign(entry, {
            valueJson: JSON.stringify(entry.value),
            expiresAt: entry.expiresAt ?? null,
          }),
        );
    },
    channelIngressQueues: [
      {
        channelId: "matrix",
        listChannelIngressQueueAccountIds: async () => [],
        openChannelIngressQueueForInspection: openQueue,
        openChannelIngressQueue: openQueue,
      },
    ],
    openPluginStateKeyedStore: <T>(options: OpenKeyedStoreOptions) =>
      createPluginStateKeyedStoreForTests<T>("matrix", {
        ...options,
        env: options.env ?? (inheritStoreEnv ? env : undefined),
      }),
  };
}

export function createMigrationParams(stateDir: string, inheritStoreEnv = true) {
  const env: NodeJS.ProcessEnv = { OPENCLAW_STATE_DIR: stateDir };
  return {
    config: {} as OpenClawConfig,
    env,
    stateDir,
    oauthDir: path.join(stateDir, "oauth"),
    context: createContext(env, inheritStoreEnv),
  };
}

export const accountStorageRoot = (
  stateDir: string,
  accountId = "default",
  token = "0123456789abcdef",
) => path.join(stateDir, "matrix", "accounts", accountId, "matrix.example.org__bot", token);

export function writeSource(file: string, contents: string | Uint8Array): string {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);
  return file;
}

export function archiveScanRoots(stateDir: string) {
  const matrixRoot = path.join(stateDir, "matrix");
  const tokenParent = path.dirname(accountStorageRoot(stateDir, "ops"));
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

export const legacyCredentials = (
  overrides: Partial<Omit<MatrixStoredCredentialRecord, "accountId">> = {},
) => ({
  homeserver: "https://matrix.example.org",
  userId: "@bot:example.org",
  accessToken: "legacy-token",
  createdAt: "2026-07-01T12:00:00.000Z",
  ...overrides,
});

export function withDatabase<T>(file: string, readOnly: boolean, run: (db: DatabaseSync) => T): T {
  using db = new DatabaseSync(file, { readOnly });
  return run(db);
}

export function createLegacyDatabase(databasePath: string) {
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  const db = new DatabaseSync(databasePath);
  db.exec(`
    CREATE TABLE plugin_state_entries (
      plugin_id TEXT NOT NULL,
      namespace TEXT NOT NULL,
      entry_key TEXT NOT NULL,
      value_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER,
      PRIMARY KEY (plugin_id, namespace, entry_key)
    ) STRICT;
    PRAGMA user_version = 1;
  `);
  return db;
}

export async function migrationById(id: string) {
  const { stateMigrations } = await import("./doctor-contract-api.js");
  const migration = stateMigrations.find((entry) => entry.id === id);
  if (!migration) {
    throw new Error(`missing migration ${id}`);
  }
  return migration;
}

export function writeSqliteDedupeSource(
  storageRootDir: string,
  accountId: string,
  eventId: string,
  ts: number,
): string {
  const databasePath = path.join(storageRootDir, "state", "openclaw.sqlite");
  const roomId = "!room:example.org";
  const key = `${accountId}:${createHash("sha256")
    .update(`${accountId}\0${roomId}\0${eventId}`)
    .digest("hex")}`;
  using db = createLegacyDatabase(databasePath);
  db.prepare(`
      INSERT INTO plugin_state_entries VALUES ('matrix', 'inbound-dedupe', ?, ?, ?, NULL)
    `).run(key, JSON.stringify({ roomId, eventId, ts }), ts);
  return databasePath;
}

export const syncCachePayload = (nextBatch: string, cleanShutdown = true) => ({
  version: 1,
  savedSync: {
    nextBatch,
    accountData: [],
    roomsData: { join: {}, invite: {}, leave: {}, knock: {} },
  },
  cleanShutdown,
});

export const writeLegacySyncCache = (root: string, nextBatch: string): string =>
  writeSource(path.join(root, "bot-storage.json"), JSON.stringify(syncCachePayload(nextBatch)));
