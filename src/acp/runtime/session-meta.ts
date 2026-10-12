import { getSessionActorStorageBinding } from "../../config/sessions/session-actor-storage-binding.js";
import { captureIncognitoSessionBinding } from "../../config/sessions/session-incognito-binding.js";
import { normalizeStoreSessionKey } from "../../config/sessions/store-entry.js";
/** SQLite-backed ACP session metadata storage keyed through session-store entries. */
import type { SessionAcpMeta, SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { parseAgentSessionKey } from "../../routing/session-key.js";
import { sessionChanges } from "../../sessions/session-row-changes.js";
import { IncognitoSessionSyncAccessError } from "../../state/incognito-session-error.js";
import { withExistingOpenClawStateDatabaseReadOnly } from "../../state/openclaw-state-db-readonly.js";
import {
  type OpenClawStateDatabaseOptions,
  runOpenClawStateWriteTransaction,
} from "../../state/openclaw-state-db.js";
import {
  buildAcpDatabaseSessionKey,
  parseAcpDatabaseSessionKey,
  resolveReadableAcpSessionRow,
  selectAcpSessionRowsByKeys,
  upsertAcpSessionMetaRow,
} from "./session-meta-keys.js";
import { readAcpSessionMetaForEntry, rowToAcpSessionMeta } from "./session-meta-readonly.js";
import { readSessionEntryFromStore, type AcpSessionStoreEntry } from "./session-meta-store.js";
import { bindAcpSessionMeta } from "./session-meta-write.kernel.js";

/** ACP metadata joined with its legacy session-store row and config context. */
export { resolveSessionStorePathForAcp } from "./session-meta-store.js";

export type { AcpSessionStoreEntry } from "./session-meta-store.js";

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
  const entriesByKey = new Map<string, SessionEntry[]>();
  for (const item of params.entries) {
    result.set(item.entry, undefined);
    const sessionKey = normalizeStoreSessionKey(item.sessionKey);
    const key = buildAcpDatabaseSessionKey(
      sessionKey,
      item.agentId ?? parseAgentSessionKey(sessionKey)?.agentId,
    );
    const entries = entriesByKey.get(key) ?? [];
    entries.push(item.entry);
    entriesByKey.set(key, entries);
  }
  if (entriesByKey.size === 0) {
    return result;
  }
  withExistingOpenClawStateDatabaseReadOnly(
    ({ db: database }) => {
      for (const row of selectAcpSessionRowsByKeys(database, [...entriesByKey.keys()])) {
        for (const entry of entriesByKey.get(row.session_key) ?? []) {
          const readable = resolveReadableAcpSessionRow({ row, entry });
          result.set(entry, readable ? rowToAcpSessionMeta(readable) : undefined);
        }
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
      const identity = parseAcpDatabaseSessionKey(sessionKey);
      if (identity) {
        sessionChanges.emit(
          { sessionKey: identity.storeSessionKey, agentId: identity.agentId },
          database.db,
        );
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
  if (
    getSessionActorStorageBinding({ ...params, sessionKey }) ||
    captureIncognitoSessionBinding(params)
  ) {
    throw new IncognitoSessionSyncAccessError("readAcpSessionEntry", "readAcpSessionEntryAsync");
  }
  const storeEntry = readSessionEntryFromStore(params);
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
export { upsertAcpSessionMeta, upsertAcpSessionMetaForControl } from "./session-meta-write.js";

export { prepareAcpSessionControlRead } from "./session-meta-control.js";
