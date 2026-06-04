import type {
  SessionTranscriptRuntimeScope,
  SessionTranscriptRuntimeTarget,
} from "../../config/sessions/session-accessor.js";
import {
  appendSqliteTranscriptEvent,
  deleteSqliteTranscript,
  loadSqliteTranscriptEvents,
  replaceSqliteTranscriptEvents,
  resolveSqliteSessionTranscriptRuntimeTarget,
  sqliteTranscriptExists,
  type SqliteSessionTranscriptRuntimeTarget,
} from "../../config/sessions/session-accessor.sqlite.js";
import type { SessionEntry, SessionHeader } from "../sessions/index.js";
import {
  createTranscriptFileStateFromEntries,
  type TranscriptFileState,
} from "./transcript-file-state.js";

export type SqliteRuntimeTranscriptScope = SessionTranscriptRuntimeScope;
export type SqliteRuntimeTranscriptTarget = SqliteSessionTranscriptRuntimeTarget;

export type SqliteRuntimeTranscriptState = {
  state: TranscriptFileState;
  target: SqliteRuntimeTranscriptTarget;
};

/** Resolves the additive SQLite runtime transcript target for test-only flip proof. */
export function resolveSqliteRuntimeTranscriptTarget(
  scope: SqliteRuntimeTranscriptScope,
): SqliteRuntimeTranscriptTarget {
  return resolveSqliteSessionTranscriptRuntimeTarget(scope);
}

/** Reads transcript state from ordered SQLite transcript rows. */
export async function readSqliteRuntimeTranscriptState(
  scope: SqliteRuntimeTranscriptScope,
): Promise<SqliteRuntimeTranscriptState> {
  const target = resolveSqliteRuntimeTranscriptTarget(scope);
  return {
    state: createTranscriptFileStateFromEntries(await loadSqliteTranscriptEvents(target)),
    target,
  };
}

/** Persists an append or migrated rewrite for a resolved SQLite runtime transcript. */
export async function persistSqliteRuntimeTranscriptStateMutation(params: {
  appendedEntries: SessionEntry[];
  state: TranscriptFileState;
  target: SqliteRuntimeTranscriptTarget;
}): Promise<void> {
  if (params.appendedEntries.length === 0 && !params.state.migrated) {
    return;
  }
  if (params.state.migrated) {
    await replaceSqliteRuntimeTranscriptEntries({
      entries: [
        ...(params.state.getHeader() ? [params.state.getHeader() as SessionHeader] : []),
        ...params.state.getEntries(),
      ],
      target: params.target,
    });
    return;
  }
  for (const entry of params.appendedEntries) {
    await appendSqliteTranscriptEvent(params.target, entry);
  }
}

/** Fully replaces the SQLite transcript rows for a runtime transcript. */
export async function replaceSqliteRuntimeTranscriptEntries(params: {
  entries: Array<SessionHeader | SessionEntry>;
  target: SessionTranscriptRuntimeTarget;
}): Promise<void> {
  await replaceSqliteTranscriptEvents(params.target, params.entries);
}

/** Checks existence of the SQLite runtime transcript rows. */
export async function sqliteRuntimeTranscriptExists(
  scope: SqliteRuntimeTranscriptScope,
): Promise<boolean> {
  return sqliteTranscriptExists(scope);
}

/** Deletes the SQLite runtime transcript rows without deleting the session entry. */
export async function deleteSqliteRuntimeTranscript(
  scope: SqliteRuntimeTranscriptScope,
): Promise<boolean> {
  return await deleteSqliteTranscript(scope);
}

/** Reads the latest leaf id for a SQLite runtime transcript scope. */
export async function readSqliteRuntimeSessionLeafId(
  scope: SqliteRuntimeTranscriptScope,
): Promise<string | null> {
  return (await readSqliteRuntimeTranscriptState(scope)).state.getLeafId();
}

/** Captures checkpoint metadata for a SQLite runtime transcript scope. */
export async function captureSqliteRuntimeCompactionCheckpointSnapshot(params: {
  sessionManager?: Pick<TranscriptFileState, "getLeafId">;
  scope: SqliteRuntimeTranscriptScope;
}): Promise<{ leafId: string; sessionId: string } | null> {
  const liveLeafId = params.sessionManager?.getLeafId();
  if (params.sessionManager && !liveLeafId) {
    return null;
  }
  const { state, target } = await readSqliteRuntimeTranscriptState(params.scope);
  const leafId = liveLeafId ?? state.getLeafId();
  if (!leafId) {
    return null;
  }
  return {
    leafId,
    sessionId: state.getHeader()?.id ?? target.sessionId,
  };
}
