import { randomUUID } from "node:crypto";
/** SQLite-backed ACP session metadata storage keyed through session-store entries. */
import type { DatabaseSync } from "node:sqlite";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import type { Insertable } from "kysely";
import { patchSessionEntryWithKey } from "../../config/sessions/session-accessor.js";
import { readLegacyAcpMigrationContext } from "../../config/sessions/session-accessor.sqlite-acp-provenance.js";
import {
  mergeSessionEntry,
  type SessionAcpMeta,
  type SessionEntry,
} from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { executeSqliteQuerySync } from "../../infra/kysely-sync.js";
import {
  legacyAcpMigrationBindingMatches,
  recordLegacyAcpMigrationCompletion,
} from "../../infra/legacy-acp-migration-source.js";
import { sessionChanges } from "../../sessions/session-row-changes.js";
import { withExistingOpenClawStateDatabaseReadOnly } from "../../state/openclaw-state-db-readonly.js";
import {
  type OpenClawStateDatabaseOptions,
  runOpenClawStateWriteTransaction,
} from "../../state/openclaw-state-db.js";
import {
  acpSessionRowMatchesEntry,
  type AcpSessionsTable,
  buildAcpDatabaseSessionKey,
  getAcpSessionKysely,
  legacyAcpDatabaseSessionKeys,
  parseAcpDatabaseSessionKeyCandidates,
  resolveLegacyFreeAcpSessionKey,
  resolveReadableAcpSessionRow,
  selectAcpSessionRow,
  selectAcpSessionRowForStoreEntry,
  selectLegacyFreeAcpSessionRows,
  upsertAcpSessionMetaRow,
} from "./session-meta-keys.js";
import { clearLegacyEmbeddedAcpMetadata } from "./session-meta-legacy-cleanup.js";
import { readAcpSessionMetaForEntry, rowToAcpSessionMeta } from "./session-meta-readonly.js";
import { readSessionEntryFromStore, type AcpSessionStoreEntry } from "./session-meta-store.js";

/** ACP metadata joined with its legacy session-store row and config context. */
export { resolveSessionStorePathForAcp } from "./session-meta-store.js";

export type { AcpSessionStoreEntry } from "./session-meta-store.js";

function bindAcpSessionMeta(params: {
  sessionKey: string;
  sessionId?: string;
  lifecycleRevision?: string;
  meta: SessionAcpMeta;
  updatedAt: number;
}): Insertable<AcpSessionsTable> {
  return {
    session_key: params.sessionKey,
    // Kept in the existing column for schema neutrality. New rows prefer the
    // lifecycle revision; pre-revision entries retain the session-id fence.
    session_id: params.lifecycleRevision ?? params.sessionId ?? null,
    backend: params.meta.backend,
    agent: params.meta.agent,
    runtime_session_name: params.meta.runtimeSessionName,
    identity_json: params.meta.identity ? JSON.stringify(params.meta.identity) : null,
    mode: params.meta.mode,
    runtime_options_json: params.meta.runtimeOptions
      ? JSON.stringify(params.meta.runtimeOptions)
      : null,
    cwd: params.meta.cwd ?? null,
    state: params.meta.state,
    last_activity_at: params.meta.lastActivityAt,
    last_error: params.meta.lastError ?? null,
    updated_at: params.updatedAt,
  };
}

export function readAcpSessionMeta(params: {
  sessionKey: string;
  agentId?: string;
  cfg?: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  databasePath?: string;
}): SessionAcpMeta | undefined {
  return readAcpSessionEntry({
    ...params,
    sessionKey: params.sessionKey.trim(),
    clone: false,
  })?.acp;
}

export function readAcpSessionMetaBatch(params: {
  entries: ReadonlyArray<{
    sessionKey: string;
    agentId?: string;
    entry: SessionEntry;
  }>;
  env?: NodeJS.ProcessEnv;
  databasePath?: string;
  cfg?: OpenClawConfig;
}): Map<SessionEntry, SessionAcpMeta | undefined> {
  const result = new Map<SessionEntry, SessionAcpMeta | undefined>();
  const entriesByKey = new Map<
    string,
    Array<{ entry: SessionEntry; rawSessionKey: string; legacyKeys: string[] }>
  >();
  for (const item of params.entries) {
    const rawSessionKey = item.sessionKey.trim();
    const sessionKey = buildAcpDatabaseSessionKey(rawSessionKey, item.agentId);
    if (item.entry?.acp) {
      result.set(item.entry, item.entry.acp);
      continue;
    }
    const legacyKeys = legacyAcpDatabaseSessionKeys(rawSessionKey, item.agentId, params.cfg);
    const entries = entriesByKey.get(sessionKey) ?? [];
    entries.push({ entry: item.entry, rawSessionKey, legacyKeys });
    entriesByKey.set(sessionKey, entries);
  }
  if (entriesByKey.size === 0) {
    return result;
  }

  withExistingOpenClawStateDatabaseReadOnly(
    ({ db: database }) => {
      // Chunked IN keeps each statement under SQLite's bind-variable cap, matching the
      // sharing-store membership precedent; one statement per 500 keys instead of per row.
      const db = getAcpSessionKysely(database);
      const requestedKeySet = new Set<string>();
      for (const [sessionKey, entries] of entriesByKey) {
        requestedKeySet.add(sessionKey);
        for (const item of entries) {
          for (const legacyKey of item.legacyKeys) {
            requestedKeySet.add(legacyKey);
          }
        }
      }
      const requestedKeys = [...requestedKeySet];
      const keyChunks: string[][] = [];
      for (let index = 0; index < requestedKeys.length; index += 500) {
        keyChunks.push(requestedKeys.slice(index, index + 500));
      }
      const rows = keyChunks.flatMap(
        (chunk) =>
          executeSqliteQuerySync(
            database,
            db.selectFrom("acp_sessions").selectAll().where("session_key", "in", chunk),
          ).rows,
      );
      const rowsByKey = new Map(rows.map((row) => [row.session_key, row]));
      const unresolved: Array<{ entry: SessionEntry; key: string }> = [];
      for (const [sessionKey, entries] of entriesByKey) {
        for (const item of entries) {
          const row = [sessionKey, ...item.legacyKeys]
            .map((key) => rowsByKey.get(key))
            .map((candidateRow) =>
              resolveReadableAcpSessionRow({ row: candidateRow, entry: item.entry }),
            )
            .find((candidateRow) => candidateRow !== undefined);
          result.set(item.entry, row ? rowToAcpSessionMeta(row) : undefined);
          const legacyKey = !row && resolveLegacyFreeAcpSessionKey(item.rawSessionKey);
          if (legacyKey) {
            unresolved.push({ entry: item.entry, key: legacyKey });
          }
        }
      }
      const legacyRows = selectLegacyFreeAcpSessionRows(
        database,
        unresolved.map(({ key }) => key),
      );
      for (const { entry, key } of unresolved) {
        const row = legacyRows
          .get(key)
          ?.find((candidate) => acpSessionRowMatchesEntry(candidate, entry));
        result.set(entry, row ? rowToAcpSessionMeta(row) : undefined);
      }
    },
    { env: params.env, path: params.databasePath },
  );
  return result;
}

export function writeAcpSessionMetaForMigration(params: {
  sessionKey: string;
  sessionId?: string;
  lifecycleRevision?: string;
  meta: SessionAcpMeta;
  env?: NodeJS.ProcessEnv;
  database?: OpenClawStateDatabaseOptions["database"];
  databasePath?: string;
  now?: () => number;
}): void {
  const sessionKey = params.sessionKey.trim();
  if (!sessionKey) {
    return;
  }
  const row = bindAcpSessionMeta({
    sessionKey,
    sessionId: params.sessionId,
    lifecycleRevision: params.lifecycleRevision,
    meta: params.meta,
    updatedAt: params.now?.() ?? Date.now(),
  });
  runOpenClawStateWriteTransaction(
    (database) => {
      upsertAcpSessionMetaRow(database.db, row);
      for (const identity of parseAcpDatabaseSessionKeyCandidates(sessionKey)) {
        const keys = new Set([
          identity.storeSessionKey,
          resolveLegacyFreeAcpSessionKey(identity.storeSessionKey),
        ]);
        for (const key of keys) {
          if (key) {
            sessionChanges.emit({ sessionKey: key, agentId: identity.agentId }, database.db);
          }
        }
      }
    },
    { database: params.database, env: params.env, path: params.databasePath },
  );
}

export function readAcpSessionEntry(params: {
  sessionKey: string;
  agentId?: string;
  cfg?: OpenClawConfig;
  clone?: boolean;
  env?: NodeJS.ProcessEnv;
  databasePath?: string;
}): AcpSessionStoreEntry | null {
  const sessionKey = params.sessionKey.trim();
  if (!sessionKey) {
    return null;
  }
  const storeEntry = readSessionEntryFromStore(params);
  if (!storeEntry.storePath) {
    return null;
  }
  const acp = readAcpSessionMetaForEntry({
    sessionKey: storeEntry.storeSessionKey,
    agentId: storeEntry.agentId,
    cfg: storeEntry.cfg,
    entry: storeEntry.entry,
    env: params.env,
    databasePath: params.databasePath,
  });
  return {
    cfg: storeEntry.cfg,
    agentId: storeEntry.agentId,
    storePath: storeEntry.storePath,
    sessionKey,
    storeSessionKey: storeEntry.storeSessionKey,
    entry: storeEntry.entry,
    acp,
    storeReadFailed: storeEntry.storeReadFailed,
  };
}

export { listAcpSessionEntries } from "./session-meta-list.js";

function mergeAcpForReturn(entry: SessionEntry | undefined, acp: SessionAcpMeta): SessionEntry {
  return mergeSessionEntry(entry, { acp });
}

function sessionStoreUpdateOptions(params: {
  sessionKey: string;
  skipMaintenance?: boolean;
  takeCacheOwnership?: boolean;
}) {
  return {
    activeSessionKey: normalizeLowercaseStringOrEmpty(params.sessionKey),
    ...(params.skipMaintenance === true ? { skipMaintenance: true } : {}),
    ...(params.takeCacheOwnership === true ? { takeCacheOwnership: true } : {}),
  };
}

function consumeLegacyAcpMigrationSources(params: {
  database: DatabaseSync;
  agentId?: string;
  storePath: string;
  sessionKey: string;
  entry: SessionEntry | undefined;
  env?: NodeJS.ProcessEnv;
  now: number;
}): void {
  if (!params.entry) {
    return;
  }
  const current = readLegacyAcpMigrationContext(params);
  if (current.sources.length === 0) {
    return;
  }
  if (
    current.entry?.sessionId !== params.entry.sessionId ||
    current.entry.lifecycleRevision !== params.entry.lifecycleRevision
  ) {
    throw new Error("Canonical ACP session changed before legacy source consumption.");
  }
  for (const source of current.sources) {
    if (legacyAcpMigrationBindingMatches(source, current.entry)) {
      recordLegacyAcpMigrationCompletion(params.database, source, params.now);
    }
  }
}

export async function upsertAcpSessionMeta(params: {
  assertCommitAllowed?: () => void;
  sessionKey: string;
  agentId?: string;
  cfg?: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  databasePath?: string;
  now?: () => number;
  skipMaintenance?: boolean;
  takeCacheOwnership?: boolean;
  mutate: (
    current: SessionAcpMeta | undefined,
    entry: SessionEntry | undefined,
  ) => SessionAcpMeta | null | undefined;
}): Promise<SessionEntry | null> {
  const sessionKey = params.sessionKey.trim();
  if (!sessionKey) {
    return null;
  }
  const storeEntry = readSessionEntryFromStore({
    sessionKey,
    agentId: params.agentId,
    cfg: params.cfg,
    env: params.env,
    clone: false,
  });
  if (!storeEntry.storePath) {
    return null;
  }
  const { entry, storePath } = storeEntry;
  const storageSessionKey = storeEntry.storeSessionKey;
  const databaseSessionKey = buildAcpDatabaseSessionKey(storageSessionKey, storeEntry.agentId);
  let current: SessionAcpMeta | undefined;
  let currentRowKey: string | undefined;
  let nextMeta: SessionAcpMeta | null | undefined;
  let preparedEntry: SessionEntry | undefined;
  const updatedAt = params.now?.() ?? Date.now();
  runOpenClawStateWriteTransaction(
    (database) => {
      params.assertCommitAllowed?.();
      const currentRow = selectAcpSessionRowForStoreEntry(
        database.db,
        storageSessionKey,
        storeEntry.agentId,
        storeEntry.cfg,
        entry,
      );
      currentRowKey = currentRow?.session_key;
      current = currentRow ? rowToAcpSessionMeta(currentRow) : undefined;
      preparedEntry = mergeSessionEntry(entry, {
        updatedAt,
        ...(entry ? {} : { lifecycleRevision: randomUUID() }),
      });
      nextMeta = params.mutate(
        current,
        current ? mergeAcpForReturn(preparedEntry, current) : entry,
      );
    },
    { env: params.env, path: params.databasePath },
  );
  const metaToPersist = nextMeta;
  if (metaToPersist === undefined) {
    return current ? mergeAcpForReturn(entry, current) : (entry ?? null);
  }
  if (metaToPersist === null) {
    const patched = entry
      ? await patchSessionEntryWithKey(
          {
            ...(storeEntry.agentId ? { agentId: storeEntry.agentId } : {}),
            storePath: storeEntry.storePath,
            sessionKey: storageSessionKey,
          },
          (currentEntry) => {
            const next = { ...currentEntry };
            delete next.acp;
            return next;
          },
          {
            ...sessionStoreUpdateOptions({ ...params, sessionKey: storageSessionKey }),
            replaceEntry: true,
            assertCommitAllowed: params.assertCommitAllowed,
          },
        )
      : null;
    runOpenClawStateWriteTransaction(
      (database) => {
        params.assertCommitAllowed?.();
        consumeLegacyAcpMigrationSources({
          database: database.db,
          agentId: storeEntry.agentId,
          storePath,
          sessionKey: patched?.sessionKey ?? storageSessionKey,
          entry: patched?.entry ?? entry,
          env: params.env,
          now: updatedAt,
        });
        const sessionKeysToDelete = new Set([databaseSessionKey]);
        if (currentRowKey && !resolveLegacyFreeAcpSessionKey(currentRowKey)) {
          sessionKeysToDelete.add(currentRowKey);
        }
        if (patched?.sessionKey) {
          sessionKeysToDelete.add(
            buildAcpDatabaseSessionKey(patched.sessionKey, storeEntry.agentId),
          );
        }
        // An explicit close consumes every readable raw alias of this same lifecycle.
        // Leaving an alias behind would make the next read reopen the closed metadata.
        for (const aliases of selectLegacyFreeAcpSessionRows(database.db, [
          storageSessionKey,
          patched?.sessionKey ?? storageSessionKey,
        ]).values()) {
          for (const alias of aliases) {
            if (acpSessionRowMatchesEntry(alias, patched?.entry ?? entry)) {
              sessionKeysToDelete.add(alias.session_key);
            }
          }
        }
        for (const key of sessionKeysToDelete) {
          executeSqliteQuerySync(
            database.db,
            getAcpSessionKysely(database.db)
              .deleteFrom("acp_sessions")
              .where("session_key", "=", key),
          );
        }
        sessionChanges.emit(
          { agentId: storeEntry.agentId, sessionKey: patched?.sessionKey ?? storageSessionKey },
          database.db,
        );
      },
      { env: params.env, path: params.databasePath },
    );
    await clearLegacyEmbeddedAcpMetadata({
      agentId: storeEntry.agentId,
      storePath: storeEntry.storePath,
      sessionKeys: [storageSessionKey, patched?.sessionKey],
      assertCommitAllowed: params.assertCommitAllowed,
    });
    return patched?.entry ?? null;
  }
  const persisted = await patchSessionEntryWithKey(
    {
      ...(storeEntry.agentId ? { agentId: storeEntry.agentId } : {}),
      storePath: storeEntry.storePath,
      sessionKey: storageSessionKey,
    },
    (currentEntry) => {
      const next = mergeSessionEntry(currentEntry, {
        updatedAt,
      });
      delete next.acp;
      return next;
    },
    {
      ...sessionStoreUpdateOptions({ ...params, sessionKey: storageSessionKey }),
      fallbackEntry: preparedEntry,
      replaceEntry: true,
      assertCommitAllowed: params.assertCommitAllowed,
    },
  );
  if (!persisted) {
    return null;
  }
  await clearLegacyEmbeddedAcpMetadata({
    agentId: storeEntry.agentId,
    storePath: storeEntry.storePath,
    sessionKeys: [storageSessionKey, persisted.sessionKey],
    assertCommitAllowed: params.assertCommitAllowed,
  });
  runOpenClawStateWriteTransaction(
    (database) => {
      // The entry patch and legacy cleanup await before this authoritative publication.
      params.assertCommitAllowed?.();
      consumeLegacyAcpMigrationSources({
        database: database.db,
        agentId: storeEntry.agentId,
        storePath,
        sessionKey: persisted.sessionKey,
        entry: persisted.entry,
        env: params.env,
        now: updatedAt,
      });
      const persistedDatabaseSessionKey = buildAcpDatabaseSessionKey(
        persisted.sessionKey,
        storeEntry.agentId,
      );
      upsertAcpSessionMetaRow(
        database.db,
        bindAcpSessionMeta({
          sessionKey: persistedDatabaseSessionKey,
          sessionId: persisted.entry.sessionId,
          lifecycleRevision: persisted.entry.lifecycleRevision,
          meta: metaToPersist,
          updatedAt: persisted.entry.updatedAt,
        }),
      );
      if (persistedDatabaseSessionKey !== databaseSessionKey) {
        executeSqliteQuerySync(
          database.db,
          getAcpSessionKysely(database.db)
            .deleteFrom("acp_sessions")
            .where("session_key", "=", databaseSessionKey),
        );
      }
      if (
        currentRowKey &&
        currentRowKey !== persistedDatabaseSessionKey &&
        !resolveLegacyFreeAcpSessionKey(currentRowKey)
      ) {
        executeSqliteQuerySync(
          database.db,
          getAcpSessionKysely(database.db)
            .deleteFrom("acp_sessions")
            .where("session_key", "=", currentRowKey),
        );
      }
      if (
        persistedDatabaseSessionKey !== persisted.sessionKey &&
        !resolveLegacyFreeAcpSessionKey(persisted.sessionKey)
      ) {
        const legacyRow = selectAcpSessionRow(database.db, persisted.sessionKey);
        if (legacyRow && acpSessionRowMatchesEntry(legacyRow, persisted.entry)) {
          executeSqliteQuerySync(
            database.db,
            getAcpSessionKysely(database.db)
              .deleteFrom("acp_sessions")
              .where("session_key", "=", persisted.sessionKey),
          );
        }
      }
      for (const aliases of selectLegacyFreeAcpSessionRows(database.db, [
        storageSessionKey,
        persisted.sessionKey,
      ]).values()) {
        for (const alias of aliases) {
          if (acpSessionRowMatchesEntry(alias, persisted.entry)) {
            executeSqliteQuerySync(
              database.db,
              getAcpSessionKysely(database.db)
                .deleteFrom("acp_sessions")
                .where("session_key", "=", alias.session_key),
            );
          }
        }
      }
      sessionChanges.emit(
        { agentId: storeEntry.agentId, sessionKey: persisted.sessionKey },
        database.db,
      );
    },
    { env: params.env, path: params.databasePath },
  );
  return mergeAcpForReturn(persisted.entry, metaToPersist);
}
