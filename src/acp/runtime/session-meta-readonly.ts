import { safeParseJsonRecord } from "@openclaw/normalization-core";
import type {
  AcpSessionRuntimeOptions,
  SessionAcpIdentity,
  SessionAcpMeta,
} from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { withExistingOpenClawStateDatabaseReadOnly } from "../../state/openclaw-state-db-readonly.js";
import {
  type AcpSessionEntryBinding,
  type AcpSessionRow,
  resolveReadableAcpSessionRow,
  selectAcpSessionRowForStoreEntry,
} from "./session-meta-keys.js";

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

export function readAcpSessionMetaForEntry(params: {
  sessionKey: string;
  agentId?: string;
  cfg?: OpenClawConfig;
  entry: AcpSessionEntryBinding | undefined;
  env?: NodeJS.ProcessEnv;
  databasePath?: string;
}): SessionAcpMeta | undefined {
  const sessionKey = params.sessionKey.trim();
  if (!sessionKey) {
    return undefined;
  }
  const row = withExistingOpenClawStateDatabaseReadOnly(
    ({ db }) =>
      resolveReadableAcpSessionRow({
        row: selectAcpSessionRowForStoreEntry(
          db,
          sessionKey,
          params.agentId,
          params.cfg,
          params.entry,
        ),
        entry: params.entry,
      }),
    { env: params.env, path: params.databasePath },
  );
  if (!row) {
    return undefined;
  }
  return rowToAcpSessionMeta(row);
}
