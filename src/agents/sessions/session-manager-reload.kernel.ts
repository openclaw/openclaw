// Borrowed native reads do not hydrate or acquire host session managers.
import { readSessionTranscriptBoundedActiveContextCore } from "../../config/sessions/session-accessor.sqlite-active-context.js";
import {
  inspectTranscriptEventsSync,
  loadTranscriptReadSnapshotSync,
  loadTranscriptEventsFromDatabase,
} from "../../config/sessions/session-accessor.sqlite-read.js";
import { resolveSqliteTranscriptReadScope } from "../../config/sessions/session-accessor.sqlite-scope.js";
import { readTranscriptContextVersionInTransaction } from "../../config/sessions/session-accessor.sqlite-transcript-state.js";
import type { SessionTranscriptRuntimeTarget } from "../../config/sessions/session-accessor.types.js";
import { resolveSqliteSessionTranscriptReadFence } from "../../config/sessions/session-transcript-read-fence.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db-contract.js";
import type {
  PreparedSessionTranscriptReload,
  SessionManagerBoundedContextLimits,
} from "./session-manager-view-types.js";

export function readSessionManagerReload(
  target: SessionTranscriptRuntimeTarget,
  limits: SessionManagerBoundedContextLimits | undefined,
  ignoreReadFence: boolean,
  transaction?: OpenClawAgentDatabase,
): PreparedSessionTranscriptReload {
  if (transaction && !transaction.db.isTransaction) {
    throw new Error("Session reload lost its borrowed transaction");
  }
  if (limits) {
    return {
      kind: "bounded",
      snapshot: readSessionTranscriptBoundedActiveContextCore(target, {
        ...limits,
        ...(ignoreReadFence ? { ignoreReadFence: true } : {}),
        transaction,
      }),
    };
  }
  if (transaction) {
    const resolved = resolveSqliteTranscriptReadScope(target);
    const fence = ignoreReadFence
      ? undefined
      : resolveSqliteSessionTranscriptReadFence({ database: transaction, ...resolved });
    return {
      kind: "full",
      snapshot: {
        events: loadTranscriptEventsFromDatabase(transaction, resolved.sessionId, {
          beforeEventSeq: fence?.beforeRawSeq,
        }),
        version: readTranscriptContextVersionInTransaction(transaction, resolved.sessionId),
      },
    };
  }
  if (!ignoreReadFence) {
    return { kind: "full", snapshot: loadTranscriptReadSnapshotSync(target) };
  }
  const { events, snapshot } = inspectTranscriptEventsSync(target);
  return {
    kind: "full",
    snapshot: {
      events,
      version: {
        generation: snapshot.generation,
        rawSeq: snapshot.lastSeq,
        updatedAt: snapshot.transcriptUpdatedAt,
      },
    },
  };
}
