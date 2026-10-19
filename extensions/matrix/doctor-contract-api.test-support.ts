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
  getPluginStateCapacityForTests,
  importPluginStateEntriesForDoctorForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import type { PluginDoctorStateMigrationContext } from "openclaw/plugin-sdk/runtime-doctor-migrations";
import type { MatrixStoredCredentialRecord } from "./src/matrix/credentials-state.js";

// Released Matrix replay markers retain their identities for 30 days.
export const MATRIX_INBOUND_DEDUPE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export function createContext(
  env?: NodeJS.ProcessEnv,
  inheritStoreEnv = true,
): PluginDoctorStateMigrationContext {
  return {
    readPluginStateEntriesInKeyRange(namespace, range) {
      return createPluginStateSyncKeyedStoreForTests<unknown>("matrix", {
        namespace,
        maxEntries: 20_000,
        defaultTtlMs: MATRIX_INBOUND_DEDUPE_TTL_MS,
        env,
      })
        .entries()
        .filter(
          (entry) =>
            entry.key.startsWith(range.prefix) && (!range.after || entry.key > range.after),
        )
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
        openChannelIngressQueueForInspection: <TPayload, TMetadata>({
          accountId,
        }: { accountId?: string } = {}) =>
          createChannelIngressQueueForTests<TPayload, TMetadata>({
            channelId: "matrix",
            accountId,
            stateDir: env?.OPENCLAW_STATE_DIR,
          }),
        openChannelIngressQueue: <TPayload, TMetadata, TCompletedMetadata>({
          accountId,
        }: { accountId?: string } = {}) =>
          createChannelIngressQueueForTests<TPayload, TMetadata, TCompletedMetadata>({
            channelId: "matrix",
            accountId,
            stateDir: env?.OPENCLAW_STATE_DIR,
          }),
      },
    ],
    getPluginStateCapacity: () => getPluginStateCapacityForTests("matrix", env),
    importPluginStateEntries: (options, entries) =>
      importPluginStateEntriesForDoctorForTests("matrix", options, entries),
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

export function accountStorageRoot(
  stateDir: string,
  accountId = "default",
  token = "0123456789abcdef",
) {
  return path.join(stateDir, "matrix", "accounts", accountId, "matrix.example.org__bot", token);
}

export function writeSource(file: string, contents: string): string {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);
  return file;
}

export function legacyCredentials(
  overrides: Partial<Omit<MatrixStoredCredentialRecord, "accountId">> = {},
) {
  return {
    homeserver: "https://matrix.example.org",
    userId: "@bot:example.org",
    accessToken: "legacy-token",
    createdAt: "2026-07-01T12:00:00.000Z",
    ...overrides,
  };
}

export function withDatabase<T>(
  databasePath: string,
  readOnly: boolean,
  run: (db: DatabaseSync) => T,
): T {
  const db = new DatabaseSync(databasePath, { readOnly });
  try {
    return run(db);
  } finally {
    db.close();
  }
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

export function dedupeMigrationResult(roots: string[], imported: number, total = imported) {
  return {
    changes: [
      `Migrated Matrix inbound dedupe markers to the durable ingress spool (${imported} of ${total} entries)`,
      ...roots.map((root) => `Retired Matrix inbound dedupe rows for ${root}`),
      `Recorded Matrix inbound dedupe migration completion (${roots.length} SQLite roots scanned)`,
    ],
    warnings: [],
  };
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
  const db = createLegacyDatabase(databasePath);
  try {
    db.prepare(`
      INSERT INTO plugin_state_entries VALUES ('matrix', 'inbound-dedupe', ?, ?, ?, NULL)
    `).run(key, JSON.stringify({ roomId, eventId, ts }), ts);
  } finally {
    db.close();
  }
  return databasePath;
}

export function syncCachePayload(nextBatch: string, cleanShutdown = true) {
  return {
    version: 1,
    savedSync: {
      nextBatch,
      accountData: [],
      roomsData: { join: {}, invite: {}, leave: {}, knock: {} },
    },
    cleanShutdown,
  };
}

export function writeLegacySyncCache(storageRootDir: string, nextBatch: string): void {
  writeSource(
    path.join(storageRootDir, "bot-storage.json"),
    JSON.stringify(syncCachePayload(nextBatch)),
  );
}
