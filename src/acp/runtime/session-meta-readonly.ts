import { safeParseJsonRecord } from "@openclaw/normalization-core";
import { normalizeStoreSessionKey } from "../../config/sessions/store-entry.js";
import type {
  AcpSessionRuntimeOptions,
  SessionAcpIdentity,
  SessionAcpMeta,
} from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  executeExistingOpenClawStateRead,
  withExistingOpenClawStateDatabaseReadOnly,
  withExistingOpenClawStateDatabaseCurrentReadOnly,
} from "../../state/openclaw-state-db-readonly.js";
import {
  buildAcpDatabaseSessionKey,
  resolveReadableAcpSessionRow,
  selectAcpSessionRowForStoreEntry,
} from "./session-meta-keys.js";
import type { AcpSessionEntryBinding, AcpSessionRow } from "./session-meta-read.types.js";

/** Each result stays bound to the entry lifecycle captured by the row reader. */
export async function readAcpSessionMetaForEntries(
  params: {
    entries: readonly {
      sessionKey: string;
      agentId: string;
      entry: AcpSessionEntryBinding | undefined;
    }[];
    cfg: OpenClawConfig;
    env?: NodeJS.ProcessEnv;
    databasePath?: string;
  },
  options: { current?: true; signal?: AbortSignal } = {},
): Promise<Array<SessionAcpMeta | null>> {
  if (params.entries.length === 0) {
    return [];
  }
  const entries = params.entries.map((item) => ({
    keys: [buildAcpDatabaseSessionKey(normalizeStoreSessionKey(item.sessionKey), item.agentId)],
    entry: item.entry
      ? {
          lifecycleRevision: item.entry.lifecycleRevision,
          sessionId: item.entry.sessionId,
          sessionStartedAt: item.entry.sessionStartedAt,
        }
      : undefined,
  }));
  const result = await executeExistingOpenClawStateRead(
    { env: params.env, path: params.databasePath },
    {
      type: "acpSessions.metadata",
      entries,
    },
    options,
  );
  if (result === undefined) {
    return entries.map(() => null);
  }
  if (result.ok && result.type === "acpSessions.metadata") {
    return result.rows.map((row, index) => {
      const readable = resolveReadableAcpSessionRow({
        row: row ?? undefined,
        entry: entries[index]?.entry,
      });
      return readable ? rowToAcpSessionMeta(readable) : null;
    });
  }
  throw new Error("Unexpected ACP session metadata read result");
}

export function rowToAcpSessionMeta(row: AcpSessionRow): SessionAcpMeta {
  // SAFETY: These JSON columns are written from the typed ACP metadata by its storage owner.
  const identity = safeParseJsonRecord(row.identity_json ?? "") as SessionAcpIdentity | undefined;
  // SAFETY: Runtime options share the same typed persisted metadata contract.
  const runtimeOptions = safeParseJsonRecord(row.runtime_options_json ?? "") as
    | AcpSessionRuntimeOptions
    | undefined;
  return {
    backend: row.backend,
    agent: row.agent,
    runtimeSessionName: row.runtime_session_name,
    ...(identity ? { identity } : {}),
    mode: row.mode === "oneshot" ? "oneshot" : "persistent",
    ...(runtimeOptions ? { runtimeOptions } : {}),
    ...(row.cwd != null ? { cwd: row.cwd } : {}),
    state: row.state === "running" || row.state === "error" ? row.state : "idle",
    lastActivityAt: row.last_activity_at,
    ...(row.last_error != null ? { lastError: row.last_error } : {}),
  };
}

export function readAcpSessionMetaForEntry(
  params: {
    sessionKey: string;
    agentId?: string;
    cfg?: OpenClawConfig;
    entry: AcpSessionEntryBinding | undefined;
    env?: NodeJS.ProcessEnv;
    databasePath?: string;
  },
  options: { current?: true } = {},
): SessionAcpMeta | undefined {
  const sessionKey = params.sessionKey.trim();
  if (!sessionKey) {
    return undefined;
  }
  const read = options.current
    ? withExistingOpenClawStateDatabaseCurrentReadOnly
    : withExistingOpenClawStateDatabaseReadOnly;
  const row = read(
    ({ db }) =>
      resolveReadableAcpSessionRow({
        row: selectAcpSessionRowForStoreEntry(db, sessionKey, params.agentId, params.entry),
        entry: params.entry,
      }),
    { env: params.env, path: params.databasePath },
  );
  if (!row) {
    return undefined;
  }
  return rowToAcpSessionMeta(row);
}
