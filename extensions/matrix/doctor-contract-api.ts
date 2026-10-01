import type { Dirent } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { normalizeAccountId } from "openclaw/plugin-sdk/account-id";
import {
  archiveLegacyStateSource,
  type PluginDoctorStateMigration,
  type OpenKeyedStoreOptions,
  type PluginStateKeyedStore,
} from "openclaw/plugin-sdk/runtime-doctor-migrations";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { matrixAccountStateSchemaMigration } from "./src/matrix/account-state-schema-doctor.js";
import {
  hasMatrixStorageMetaStateInStore,
  normalizeMatrixStorageMetadata,
  openMatrixStorageMetaStoreOptions,
  writeMatrixStorageMetaStateToStore,
  type MatrixStorageMetadata,
} from "./src/matrix/client/storage-metadata.js";
import {
  hasMatrixSyncCacheStateInStore,
  openMatrixSyncCacheStoreOptions,
  readLegacyMatrixSyncCacheState,
  writeMatrixSyncCacheStateToStore,
  type MatrixSyncCacheRecord,
} from "./src/matrix/client/sync-cache-state.js";
import {
  MATRIX_CREDENTIALS_MAX_ENTRIES,
  MATRIX_CREDENTIALS_NAMESPACE,
  isMatrixCredentialRevocation,
  matrixCredentialsStoreKey,
  normalizeMatrixStoredCredentials,
  type MatrixCredentialStateRecord,
  type MatrixStoredCredentialRecord,
} from "./src/matrix/credentials-state.js";
import {
  MATRIX_IDB_SNAPSHOT_FILENAME,
  MATRIX_LEGACY_CRYPTO_MIGRATION_FILENAME,
  MATRIX_RECOVERY_KEY_FILENAME,
  hasMatrixLegacyCryptoMigrationStateInStore,
  hasMatrixRecoveryKeyStateInStore,
  openMatrixLegacyCryptoMigrationStoreOptions,
  openMatrixRecoveryKeyStoreOptions,
  readLegacyMatrixLegacyCryptoMigrationState,
  readLegacyMatrixRecoveryKeyState,
  writeMatrixLegacyCryptoMigrationStateToStore,
  writeMatrixRecoveryKeyStateToStore,
} from "./src/matrix/crypto-state-store.js";
import {
  collectMatrixInboundDedupeSources,
  hasCompletedMatrixInboundDedupeMigration,
  importNewestInboundDedupeMarkers,
  MATRIX_LEGACY_INBOUND_DEDUPE_FILENAME,
  readLegacyInboundDedupeJsonSource,
  readLegacyInboundDedupeSqliteSource,
  recordMatrixInboundDedupeMigrationCompletion,
  reserveMatrixInboundDedupeMigrationCompletion,
  retireLegacyInboundDedupeSqliteRows,
  verifyMatrixInboundDedupeSourcesRetired,
  type LegacyInboundDedupeMarker,
  type MatrixInboundDedupeMigrationIo,
} from "./src/matrix/monitor/inbound-dedupe-migration.js";
import { walkMatrixStateFiles } from "./src/matrix/state-layout-walk.js";
import { resolveMatrixCredentialsDir } from "./src/storage-paths.js";

export { normalizeCompatibilityConfig, legacyConfigRules } from "./config-doctor-api.js";

const MATRIX_SYNC_CACHE_FILENAME = "bot-storage.json";
const MATRIX_STORAGE_META_FILENAME = "storage-meta.json";

type LegacyMatrixCredentialSource = {
  accountId: string | null;
  filePath: string;
};

async function collectLegacyMatrixCredentialSources(params: {
  config: Parameters<PluginDoctorStateMigration["migrateLegacyState"]>[0]["config"];
  env: NodeJS.ProcessEnv;
  stateDir: string;
}): Promise<LegacyMatrixCredentialSource[]> {
  const credentialsDir = resolveMatrixCredentialsDir(params.stateDir);
  let entries: Dirent[];
  try {
    entries = await fs.readdir(credentialsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files = entries
    .filter((entry) => entry.isFile() && /^credentials(?:-[a-z0-9._-]+)?\.json$/iu.test(entry.name))
    .toSorted((left, right) => {
      if (left.name === "credentials.json") {
        return 1;
      }
      if (right.name === "credentials.json") {
        return -1;
      }
      return left.name.localeCompare(right.name);
    });
  if (files.length === 0) {
    return [];
  }
  // Empty-state Doctor scans do not need account topology.
  const { requiresExplicitMatrixDefaultAccount, resolveMatrixDefaultOrOnlyAccountId } =
    await import("./src/account-selection.js");
  return files.map((entry) => {
    const match = /^credentials(?:-([a-z0-9._-]+))?\.json$/iu.exec(entry.name);
    const namedAccount = match?.[1];
    const accountId = namedAccount
      ? normalizeAccountId(namedAccount)
      : requiresExplicitMatrixDefaultAccount(params.config, params.env)
        ? null
        : normalizeAccountId(resolveMatrixDefaultOrOnlyAccountId(params.config, params.env));
    return { accountId, filePath: path.join(credentialsDir, entry.name) };
  });
}

async function readLegacyMatrixCredentials(
  source: LegacyMatrixCredentialSource,
): Promise<MatrixStoredCredentialRecord | null> {
  if (!source.accountId) {
    return null;
  }
  try {
    const raw = JSON.parse(await fs.readFile(source.filePath, "utf8")) as unknown;
    const createdAt =
      isRecord(raw) && typeof raw.createdAt === "string" && raw.createdAt
        ? raw.createdAt
        : (await fs.stat(source.filePath)).mtime.toISOString();
    return normalizeMatrixStoredCredentials(
      isRecord(raw) ? { ...raw, createdAt } : raw,
      source.accountId,
    );
  } catch {
    return null;
  }
}

async function collectLegacyMatrixStateRoots(
  stateDir: string,
  filename: string,
  options?: { includeMatrixRoot?: boolean },
): Promise<string[]> {
  const { entries } = await walkMatrixStateFiles(
    stateDir,
    (name, depth) =>
      name === filename &&
      (depth === 2 || depth === 4 || (depth === 0 && options?.includeMatrixRoot === true)),
  );
  return entries.map((entry) => path.dirname(entry.path)).toSorted();
}

async function readLegacyMatrixStorageMetadata(
  storageRootDir: string,
): Promise<MatrixStorageMetadata | null> {
  try {
    return normalizeMatrixStorageMetadata(
      JSON.parse(
        await fs.readFile(path.join(storageRootDir, MATRIX_STORAGE_META_FILENAME), "utf8"),
      ),
    );
  } catch {
    return null;
  }
}

async function archiveLegacyMatrixStateFile(params: {
  storageRootDir: string;
  filename: string;
  label: string;
  changes: string[];
  warnings: string[];
  notices?: string[];
  notice?: string;
}): Promise<void> {
  const warningCount = params.warnings.length;
  await archiveLegacyStateSource({
    filePath: path.join(params.storageRootDir, params.filename),
    label: params.label,
    changes: params.changes,
    warnings: params.warnings,
  });
  if (params.notice && params.warnings.length === warningCount) {
    params.notices?.push(params.notice);
  }
}

function defineMatrixLegacyFileMigration<TPayload, TRecord = TPayload>(spec: {
  id: string;
  label: string;
  filename: string;
  jsonLabel?: string;
  includeMatrixRoot?: boolean;
  read: (storageRootDir: string) => TPayload | null | Promise<TPayload | null>;
  storeOptions: (storageRootDir: string) => OpenKeyedStoreOptions;
  hasState: (params: {
    storageRootDir: string;
    store: PluginStateKeyedStore<TRecord>;
  }) => Promise<boolean>;
  write: (params: {
    storageRootDir: string;
    payload: TPayload;
    store: PluginStateKeyedStore<TRecord>;
  }) => Promise<void>;
}): PluginDoctorStateMigration {
  const jsonLabel = spec.jsonLabel ?? spec.label;
  const readSources = async function* (stateDir: string) {
    for (const storageRootDir of await collectLegacyMatrixStateRoots(
      stateDir,
      spec.filename,
      spec,
    )) {
      const payload = await spec.read(storageRootDir);
      if (payload) {
        yield { storageRootDir, payload };
      }
    }
  };
  return {
    id: spec.id,
    label: spec.label,
    async detectLegacyState(params) {
      const previews: string[] = [];
      for await (const { storageRootDir } of readSources(params.stateDir)) {
        previews.push(`${jsonLabel} JSON can migrate to SQLite: ${storageRootDir}`);
      }
      return previews.length > 0 ? { preview: previews } : null;
    },
    async migrateLegacyState(params) {
      const changes: string[] = [];
      const warnings: string[] = [];
      const notices: string[] = [];
      for await (const source of readSources(params.stateDir)) {
        const store = params.context.openPluginStateKeyedStore<TRecord>(
          spec.storeOptions(source.storageRootDir),
        );
        const existing = await spec.hasState({ ...source, store });
        if (!existing) {
          await spec.write({ ...source, store });
          changes.push(`Migrated ${jsonLabel} JSON to SQLite for ${source.storageRootDir}`);
        }
        await archiveLegacyMatrixStateFile({
          storageRootDir: source.storageRootDir,
          filename: spec.filename,
          label: spec.label,
          changes,
          warnings,
          notices,
          notice: existing
            ? `Kept existing ${spec.label} in SQLite and archived the legacy source for ${source.storageRootDir}`
            : undefined,
        });
      }
      return { changes, warnings, ...(notices.length > 0 ? { notices } : {}) };
    },
  };
}

const legacyCryptoMigration = defineMatrixLegacyFileMigration({
  id: "matrix-legacy-crypto-migration-json-to-plugin-state",
  label: "Matrix legacy crypto migration",
  filename: MATRIX_LEGACY_CRYPTO_MIGRATION_FILENAME,
  includeMatrixRoot: true,
  read: readLegacyMatrixLegacyCryptoMigrationState,
  storeOptions: openMatrixLegacyCryptoMigrationStoreOptions,
  hasState: hasMatrixLegacyCryptoMigrationStateInStore,
  write: ({ payload, store }) =>
    writeMatrixLegacyCryptoMigrationStateToStore({ state: payload, store }),
});

export const stateMigrations: PluginDoctorStateMigration[] = [
  matrixAccountStateSchemaMigration,
  {
    id: "matrix-credentials-json-to-plugin-state",
    label: "Matrix credentials",
    async detectLegacyState(params) {
      const sources = await collectLegacyMatrixCredentialSources(params);
      return sources.length > 0
        ? {
            preview: [
              `Matrix credential JSON can migrate to SQLite (${sources.length} ${sources.length === 1 ? "file" : "files"})`,
            ],
          }
        : null;
    },
    async migrateLegacyState(params) {
      const changes: string[] = [];
      const warnings: string[] = [];
      const sources = await collectLegacyMatrixCredentialSources(params);
      const store = params.context.openPluginStateKeyedStore<MatrixCredentialStateRecord>({
        namespace: MATRIX_CREDENTIALS_NAMESPACE,
        maxEntries: MATRIX_CREDENTIALS_MAX_ENTRIES,
        overflowPolicy: "reject-new",
      });
      for (const source of sources) {
        if (!source.accountId) {
          warnings.push(
            `Left ambiguous Matrix credential legacy source in place because no default account is selected: ${source.filePath}`,
          );
          continue;
        }
        const credentials = await readLegacyMatrixCredentials(source);
        if (!credentials) {
          warnings.push(
            `Left invalid Matrix credential legacy source in place: ${source.filePath}`,
          );
          continue;
        }
        const key = matrixCredentialsStoreKey(source.accountId);
        const stored = await store.lookup(key);
        if (isMatrixCredentialRevocation(stored, source.accountId)) {
          changes.push(
            `Archived revoked Matrix credential legacy source for account ${source.accountId}`,
          );
          await archiveLegacyStateSource({
            filePath: source.filePath,
            label: "Matrix credentials",
            changes,
            warnings,
          });
          continue;
        }
        const existing = normalizeMatrixStoredCredentials(stored, source.accountId);
        if (existing && JSON.stringify(existing) !== JSON.stringify(credentials)) {
          changes.push(`Kept existing Matrix credentials for account ${source.accountId}`);
          await archiveLegacyStateSource({
            filePath: source.filePath,
            label: "Matrix credentials",
            changes,
            warnings,
          });
          continue;
        }
        if (!existing) {
          try {
            await store.registerIfAbsent(key, credentials);
          } catch (error) {
            warnings.push(
              `Failed importing Matrix credentials for account ${source.accountId}: ${String(error)}; left legacy source in place`,
            );
            continue;
          }
        }
        const persisted = normalizeMatrixStoredCredentials(
          await store.lookup(key),
          source.accountId,
        );
        if (!persisted || JSON.stringify(persisted) !== JSON.stringify(credentials)) {
          warnings.push(
            `Failed verifying Matrix credentials for account ${source.accountId}; left legacy source in place`,
          );
          continue;
        }
        changes.push(`Migrated Matrix credentials for account ${source.accountId} to SQLite`);
        await archiveLegacyStateSource({
          filePath: source.filePath,
          label: "Matrix credentials",
          changes,
          warnings,
        });
      }
      return { changes, warnings };
    },
  },
  {
    id: "matrix-inbound-dedupe-to-claimable-dedupe",
    label: "Matrix inbound dedupe markers",
    async detectLegacyState(params) {
      return (await hasCompletedMatrixInboundDedupeMigration(params.context, params.env))
        ? null
        : { preview: ["Matrix inbound dedupe legacy sources need a one-time migration scan"] };
    },
    async migrateLegacyState(params) {
      const io: MatrixInboundDedupeMigrationIo = { context: params.context, env: params.env };
      const changes: string[] = [];
      const warnings: string[] = [];
      if (await hasCompletedMatrixInboundDedupeMigration(params.context, params.env)) {
        return { changes, warnings };
      }
      try {
        await reserveMatrixInboundDedupeMigrationCompletion(params.context, params.env);
      } catch (err) {
        warnings.push(
          `Failed reserving Matrix inbound dedupe migration completion: ${String(err)}; left legacy sources in place`,
        );
        return { changes, warnings };
      }
      const sources = await collectMatrixInboundDedupeSources(params.stateDir);
      if (sources.status === "incomplete") {
        warnings.push(...sources.warnings);
      }

      const recordCompletionIfClean = async (verifyRetirement = false) => {
        if (warnings.length > 0) {
          return;
        }
        if (verifyRetirement) {
          warnings.push(...(await verifyMatrixInboundDedupeSourcesRetired(params.stateDir)));
          if (warnings.length > 0) {
            return;
          }
        }
        try {
          await recordMatrixInboundDedupeMigrationCompletion(params.context, params.env);
          // Fresh installs scan zero roots; keep the durable receipt silent
          // there so onboarding doesn't report a migration that touched nothing.
          if (sources.sqliteRoots.length + sources.jsonRoots.length > 0) {
            changes.push(
              `Recorded Matrix inbound dedupe migration completion (${sources.sqliteRoots.length} SQLite roots, ${sources.jsonRoots.length} JSON roots scanned)`,
            );
          }
        } catch (err) {
          warnings.push(
            `Failed recording Matrix inbound dedupe migration completion: ${String(err)}`,
          );
        }
      };

      // Gather every marker first so the capacity-aware import keeps the
      // globally newest ones instead of whichever storage root imports last.
      const gathered: LegacyInboundDedupeMarker[] = [];
      const sqliteRootsToRetire: string[] = [];
      for (const storageRootDir of sources.sqliteRoots) {
        try {
          const source = await readLegacyInboundDedupeSqliteSource(storageRootDir);
          if (source.legacyRowCount === 0) {
            continue;
          }
          gathered.push(...source.markers);
          sqliteRootsToRetire.push(storageRootDir);
        } catch (err) {
          warnings.push(
            `Failed reading Matrix inbound dedupe rows for ${storageRootDir}: ${String(err)}; left legacy rows in place`,
          );
        }
      }
      const jsonRootsToRetire: string[] = [];
      for (const storageRootDir of sources.jsonRoots) {
        try {
          const markers = await readLegacyInboundDedupeJsonSource(storageRootDir);
          if (markers === null) {
            // Nothing recoverable, but archiving (rename, not delete) resolves
            // the pending detection while preserving the bytes for inspection.
            warnings.push(
              `Matrix inbound dedupe JSON for ${storageRootDir} is malformed; archived without import`,
            );
          } else {
            gathered.push(...markers);
          }
          jsonRootsToRetire.push(storageRootDir);
        } catch (err) {
          warnings.push(
            `Failed reading Matrix inbound dedupe JSON for ${storageRootDir}: ${String(err)}; left legacy file in place`,
          );
        }
      }
      if (sqliteRootsToRetire.length + jsonRootsToRetire.length === 0) {
        await recordCompletionIfClean();
        return { changes, warnings };
      }

      try {
        const result = await importNewestInboundDedupeMarkers({ io, markers: gathered });
        changes.push(
          `Migrated Matrix inbound dedupe markers to the claimable dedupe store (${result.imported} of ${result.total} entries)`,
        );
      } catch (err) {
        warnings.push(
          `Failed importing Matrix inbound dedupe markers: ${String(err)}; left legacy sources in place`,
        );
        return { changes, warnings };
      }

      // Retire the legacy sources only after the import succeeded so a failed
      // run keeps them for the next doctor attempt.
      for (const storageRootDir of sqliteRootsToRetire) {
        try {
          await retireLegacyInboundDedupeSqliteRows(storageRootDir);
          changes.push(`Retired Matrix inbound dedupe rows for ${storageRootDir}`);
        } catch (err) {
          warnings.push(
            `Failed retiring Matrix inbound dedupe rows for ${storageRootDir}: ${String(err)}`,
          );
        }
      }
      for (const storageRootDir of jsonRootsToRetire) {
        await archiveLegacyMatrixStateFile({
          storageRootDir,
          filename: MATRIX_LEGACY_INBOUND_DEDUPE_FILENAME,
          label: "Matrix inbound dedupe",
          changes,
          warnings,
        });
      }
      await recordCompletionIfClean(true);
      return { changes, warnings };
    },
  },
  defineMatrixLegacyFileMigration({
    id: "matrix-storage-meta-json-to-plugin-state",
    label: "Matrix storage metadata",
    filename: MATRIX_STORAGE_META_FILENAME,
    read: readLegacyMatrixStorageMetadata,
    storeOptions: openMatrixStorageMetaStoreOptions,
    hasState: hasMatrixStorageMetaStateInStore,
    write: writeMatrixStorageMetaStateToStore,
  }),
  defineMatrixLegacyFileMigration<
    NonNullable<Awaited<ReturnType<typeof readLegacyMatrixSyncCacheState>>>,
    MatrixSyncCacheRecord
  >({
    id: "matrix-sync-cache-json-to-plugin-state",
    label: "Matrix sync cache",
    filename: MATRIX_SYNC_CACHE_FILENAME,
    read: readLegacyMatrixSyncCacheState,
    storeOptions: openMatrixSyncCacheStoreOptions,
    hasState: hasMatrixSyncCacheStateInStore,
    write: writeMatrixSyncCacheStateToStore,
  }),
  defineMatrixLegacyFileMigration({
    id: "matrix-recovery-key-json-to-plugin-state",
    label: "Matrix recovery key",
    jsonLabel: "Matrix recovery-key",
    filename: MATRIX_RECOVERY_KEY_FILENAME,
    read: readLegacyMatrixRecoveryKeyState,
    storeOptions: openMatrixRecoveryKeyStoreOptions,
    hasState: hasMatrixRecoveryKeyStateInStore,
    write: writeMatrixRecoveryKeyStateToStore,
  }),
  {
    id: "matrix-legacy-crypto-migration-json-to-plugin-state",
    label: "Matrix legacy crypto state",
    async detectLegacyState(params) {
      const previews = (await legacyCryptoMigration.detectLegacyState(params))?.preview ?? [];
      for (const storageRootDir of await collectLegacyMatrixStateRoots(
        params.stateDir,
        MATRIX_IDB_SNAPSHOT_FILENAME,
        { includeMatrixRoot: true },
      )) {
        previews.push(`Matrix IndexedDB snapshot JSON can migrate to SQLite: ${storageRootDir}`);
      }
      return previews.length > 0 ? { preview: previews } : null;
    },
    async migrateLegacyState(params) {
      const {
        changes,
        warnings,
        notices = [],
      } = await legacyCryptoMigration.migrateLegacyState(params);
      for (const storageRootDir of await collectLegacyMatrixStateRoots(
        params.stateDir,
        MATRIX_IDB_SNAPSHOT_FILENAME,
        { includeMatrixRoot: true },
      )) {
        // Keep empty-state Doctor scans from materializing the IndexedDB runtime.
        const { migrateLegacyMatrixIdbSnapshot } =
          await import("./src/matrix/crypto-snapshot-doctor.runtime.js");
        await migrateLegacyMatrixIdbSnapshot({
          storageRootDir,
          context: params.context,
          changes,
          notices,
          warnings,
        });
      }
      return { changes, warnings, ...(notices.length > 0 ? { notices } : {}) };
    },
  },
];
