import type { DatabaseSync } from "node:sqlite";
import type { Insertable } from "kysely";
import type { SessionAcpMeta } from "../../config/sessions/types.js";
import { executeSqliteQuerySync } from "../../infra/kysely-sync.js";
import {
  acpSessionRowMatchesEntry,
  buildAcpDatabaseSessionKey,
  getAcpSessionKysely,
  resolveLegacyFreeAcpSessionKey,
  selectAcpSessionRow,
  selectLegacyFreeAcpSessionRows,
  upsertAcpSessionMetaRow,
  type AcpSessionsTable,
} from "./session-meta-keys.js";
import type { AcpSessionMutationCommit } from "./session-meta-write.types.js";

export function bindAcpSessionMeta(params: {
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

/** Shared SQL policy for worker writes and the retained native owner. */
export function applyAcpSessionMutation(
  db: DatabaseSync,
  input: Omit<AcpSessionMutationCommit, "agentId" | "source" | "updatedAt"> & { agentId?: string },
): void {
  const initialKey = buildAcpDatabaseSessionKey(input.storageSessionKey, input.agentId);
  const finalKey = buildAcpDatabaseSessionKey(input.sessionKey, input.agentId);
  const keys = new Set<string>();
  if (input.decision.kind === "clear") {
    keys.add(initialKey);
    keys.add(finalKey);
  } else {
    if (!input.entry) {
      throw new Error("ACP metadata publication lost its canonical entry");
    }
    upsertAcpSessionMetaRow(
      db,
      bindAcpSessionMeta({
        sessionKey: finalKey,
        sessionId: input.entry.sessionId,
        lifecycleRevision: input.entry.lifecycleRevision,
        meta: input.decision.meta,
        updatedAt: input.entry.updatedAt,
      }),
    );
    if (initialKey !== finalKey) {
      keys.add(initialKey);
    }
    if (finalKey !== input.sessionKey && !resolveLegacyFreeAcpSessionKey(input.sessionKey)) {
      const row = selectAcpSessionRow(db, input.sessionKey);
      if (row && acpSessionRowMatchesEntry(row, input.entry)) {
        keys.add(input.sessionKey);
      }
    }
  }
  if (
    input.currentRowKey &&
    (input.decision.kind === "clear" || input.currentRowKey !== finalKey) &&
    !resolveLegacyFreeAcpSessionKey(input.currentRowKey)
  ) {
    keys.add(input.currentRowKey);
  }
  // Aliases are reread after the awaited entry change; a rebound lifecycle keeps its row.
  for (const aliases of selectLegacyFreeAcpSessionRows(db, [
    input.storageSessionKey,
    input.sessionKey,
  ]).values()) {
    for (const alias of aliases) {
      if (acpSessionRowMatchesEntry(alias, input.entry)) {
        keys.add(alias.session_key);
      }
    }
  }
  for (const key of keys) {
    executeSqliteQuerySync(
      db,
      getAcpSessionKysely(db).deleteFrom("acp_sessions").where("session_key", "=", key),
    );
  }
}
