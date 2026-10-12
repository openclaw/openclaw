import { getSessionActorStorageBinding } from "../../config/sessions/session-actor-storage-binding.js";
import { captureIncognitoSessionBinding } from "../../config/sessions/session-incognito-binding.js";
/** SQLite-backed ACP session metadata storage keyed through session-store entries. */
import type { SessionAcpMeta } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { sessionChanges } from "../../sessions/session-row-changes.js";
import { IncognitoSessionSyncAccessError } from "../../state/incognito-session-error.js";
import {
  type OpenClawStateDatabaseOptions,
  runOpenClawStateWriteTransaction,
} from "../../state/openclaw-state-db.js";
import { parseAcpDatabaseSessionKey, upsertAcpSessionMetaRow } from "./session-meta-keys.js";
import { readAcpSessionMetaForEntry } from "./session-meta-readonly.js";
import { readSessionEntryFromStore, type AcpSessionStoreEntry } from "./session-meta-store.js";
import { bindAcpSessionMeta } from "./session-meta-write.kernel.js";

/** ACP metadata joined with its legacy session-store row and config context. */
export { resolveSessionStorePathForAcp } from "./session-meta-store.js";

export type { AcpSessionStoreEntry } from "./session-meta-store.js";

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
