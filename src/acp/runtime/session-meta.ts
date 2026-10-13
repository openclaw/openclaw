/** SQLite-backed ACP session metadata storage keyed through session-store entries. */
import type { SessionAcpMeta } from "../../config/sessions/types.js";
import { sessionChanges } from "../../sessions/session-row-changes.js";
import {
  type OpenClawStateDatabaseOptions,
  runOpenClawStateWriteTransaction,
} from "../../state/openclaw-state-db.js";
import { parseAcpDatabaseSessionKey, upsertAcpSessionMetaRow } from "./session-meta-keys.js";
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

export { listAcpSessionEntries } from "./session-meta-list.js";

export { readAcpSessionEntryAsync, readAcpSessionMetaAsync } from "./session-meta-read.js";
export { upsertAcpSessionMeta, upsertAcpSessionMetaForControl } from "./session-meta-write.js";

export { prepareAcpSessionControlRead } from "./session-meta-control.js";
