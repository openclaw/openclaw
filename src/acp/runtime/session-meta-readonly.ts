import { safeParseJsonRecord } from "@openclaw/normalization-core";
import { normalizeStoreSessionKey } from "../../config/sessions/store-entry.js";
import type {
  AcpSessionRuntimeOptions,
  SessionAcpIdentity,
  SessionAcpMeta,
} from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { parseAgentSessionKey } from "../../routing/session-key.js";
import {
  executeExistingOpenClawStateRead,
  getActiveOpenClawStateDatabaseReadSnapshot,
  withExistingOpenClawStateDatabaseReadOnly,
  withExistingOpenClawStateDatabaseCurrentReadOnly,
} from "../../state/openclaw-state-db-readonly.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { captureOpenClawStateReadWorkerContext } from "../../state/openclaw-state-worker-context.js";
import {
  buildAcpDatabaseSessionKey,
  readPublishedAcpSessionRows,
  resolveReadableAcpSessionRow,
  selectAcpSessionRowForStoreEntry,
} from "./session-meta-keys.js";
import type { AcpSessionEntryBinding, AcpSessionRow } from "./session-meta-read.types.js";

/** Each result stays bound to the entry lifecycle captured by the row reader. */
export async function readAcpSessionMetaForEntries(
  params: {
    entries: readonly {
      sessionKey: string;
      agentId?: string;
      entry: AcpSessionEntryBinding | undefined;
    }[];
    cfg?: OpenClawConfig;
    env?: NodeJS.ProcessEnv;
    databasePath?: string;
  },
  options: { current?: true; signal?: AbortSignal } = {},
): Promise<Array<SessionAcpMeta | null>> {
  if (params.entries.length === 0) {
    return [];
  }
  const entries = params.entries.map((item) => ({
    keys: [
      buildAcpDatabaseSessionKey(
        normalizeStoreSessionKey(item.sessionKey),
        item.agentId ?? parseAgentSessionKey(item.sessionKey)?.agentId,
      ),
    ],
    entry: item.entry
      ? {
          lifecycleRevision: item.entry.lifecycleRevision,
          sessionId: item.entry.sessionId,
          sessionStartedAt: item.entry.sessionStartedAt,
        }
      : undefined,
  }));
  const database = {
    env: params.env,
    path: params.databasePath ?? resolveOpenClawStateSqlitePath(params.env),
  };
  const context =
    options.current || !getActiveOpenClawStateDatabaseReadSnapshot(database)
      ? captureOpenClawStateReadWorkerContext(database)
      : undefined;
  if (context) {
    const published = readPublishedAcpSessionRows(database.path, entries);
    if (published) {
      options.signal?.throwIfAborted();
      context.maintenanceScope?.assertAdmission();
      context.admission.assertCurrent();
      return published.map((row) => (row ? rowToAcpSessionMeta(row) : null));
    }
  }
  const result = await executeExistingOpenClawStateRead(
    database,
    {
      type: "acpSessions.metadata",
      entries,
    },
    { ...options, context },
  );
  if (result === undefined) {
    return entries.map(() => null);
  }
  return result.rows.map((row) => (row ? rowToAcpSessionMeta(row) : null));
}

/** Read metadata for an already selected entry without loading its session row again. */
export async function readAcpSessionMetaForEntryAsync(
  params: {
    sessionKey: string;
    agentId?: string;
    cfg?: OpenClawConfig;
    entry: AcpSessionEntryBinding | undefined;
    env?: NodeJS.ProcessEnv;
    databasePath?: string;
  },
  options: { current?: true; signal?: AbortSignal } = {},
): Promise<SessionAcpMeta | undefined> {
  if (!params.sessionKey.trim()) {
    return undefined;
  }
  const [metadata] = await readAcpSessionMetaForEntries({ ...params, entries: [params] }, options);
  return metadata ?? undefined;
}

export function rowToAcpSessionMeta(
  row: Omit<AcpSessionRow, "resume_agent_session_id" | "resume_acpx_session_id">,
): SessionAcpMeta {
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
