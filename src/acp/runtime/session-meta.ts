/** SQLite-backed ACP session metadata storage keyed through session-store entries. */
import type { SessionAcpMeta, SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { executeSqliteQuerySync } from "../../infra/kysely-sync.js";
import { sessionChanges } from "../../sessions/session-row-changes.js";
import { withExistingOpenClawStateDatabaseReadOnly } from "../../state/openclaw-state-db-readonly.js";
import {
  type OpenClawStateDatabaseOptions,
  runOpenClawStateWriteTransaction,
} from "../../state/openclaw-state-db.js";
import {
  acpSessionRowMatchesEntry,
  buildAcpDatabaseSessionKey,
  getAcpSessionKysely,
  legacyAcpDatabaseSessionKeys,
  parseAcpDatabaseSessionKeyCandidates,
  resolveLegacyFreeAcpSessionKey,
  resolveReadableAcpSessionRow,
  selectLegacyFreeAcpSessionRows,
  upsertAcpSessionMetaRow,
} from "./session-meta-keys.js";
import { readAcpSessionMetaForEntry, rowToAcpSessionMeta } from "./session-meta-readonly.js";
import { readSessionEntryFromStore, type AcpSessionStoreEntry } from "./session-meta-store.js";
import { bindAcpSessionMeta } from "./session-meta-write.kernel.js";

/** ACP metadata joined with its legacy session-store row and config context. */
export { resolveSessionStorePathForAcp } from "./session-meta-store.js";

export type { AcpSessionStoreEntry } from "./session-meta-store.js";

/** @deprecated Use readAcpSessionMetaAsync for runtime reads. Native maintenance retains this reader. */
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

/** @deprecated Use readAcpSessionEntryAsync; retained for the v2026.9.4 Plugin SDK contract. */
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

export { readAcpSessionEntryAsync, readAcpSessionMetaAsync } from "./session-meta-read.js";
export { upsertAcpSessionMeta } from "./session-meta-write.js";
