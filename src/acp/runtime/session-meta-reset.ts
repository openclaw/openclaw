import type { SessionResetCommitContext } from "../../config/sessions/session-accessor.lifecycle-types.js";
import { createSessionTranscriptOwnerPredicate } from "../../config/sessions/session-accessor.sqlite-transcript-write-guard.js";
import type {
  SessionAcpMeta,
  InternalSessionEntry as SessionEntry,
} from "../../config/sessions/types.js";
import { getSqlitePinnedReadSnapshot } from "../../infra/sqlite-pinned-read-snapshot.js";
import {
  assertExistingDatabaseIdentity,
  readDatabasePathIdentitySync,
} from "../../infra/sqlite-worker-identity.js";
import { assertOpenClawAgentDatabaseIdentity } from "../../state/openclaw-agent-db-identity.js";
import { retainOpenClawAgentDatabaseReadCandidates } from "../../state/openclaw-agent-db.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import { commitAcpSessionMutation } from "./session-meta-worker-mutation.js";

/** Rebind a durable reset; Gateway incognito resets delete their session through the actor owner. */
export async function rebindDurableAcpSessionMetaAfterReset(params: {
  agentId: string;
  sessionKey: string;
  context: SessionResetCommitContext;
  entry: SessionEntry;
  meta: SessionAcpMeta;
  assertCurrent?: () => void;
}): Promise<void> {
  const assertCallerCurrent = params.assertCurrent;
  const committedSource = params.context;
  committedSource.assertCurrent();
  assertCallerCurrent?.();
  const context = captureOpenClawStateWorkerContext({ env: committedSource.env });
  const retained = retainOpenClawAgentDatabaseReadCandidates(
    [{ path: committedSource.source.path }],
    committedSource.env,
  );
  try {
    const source = {
      ...committedSource.source,
      identity: readDatabasePathIdentitySync(committedSource.source.path),
    };
    const native = retained.databases.find((database) => database.agentId === source.agentId);
    const entry = structuredClone(params.entry);
    const matchesOwner =
      native &&
      createSessionTranscriptOwnerPredicate(native, {
        sessionKey: params.sessionKey,
        sessionId: entry.sessionId,
        lifecycleRevision: entry.lifecycleRevision,
        activeWriterRunId: entry.activeWriterRunId,
      });
    const assertCurrent = () => {
      committedSource.assertCurrent();
      assertCallerCurrent?.();
      if (native) {
        assertOpenClawAgentDatabaseIdentity(native, source.identity);
        if (native.db.isTransaction || getSqlitePinnedReadSnapshot(native.db)) {
          throw new Error(
            "Canonical ACP session changed before reset publication: pinned snapshot",
          );
        }
      }
      context.admission.assertCurrent();
      assertExistingDatabaseIdentity(source.path, source.identity.key, source.identity.birthtime);
    };
    assertCurrent();
    await commitAcpSessionMutation(
      context,
      {
        agentId: params.agentId,
        storageSessionKey: params.sessionKey,
        sessionKey: params.sessionKey,
        entry,
        updatedAt: entry.updatedAt,
        decision: { kind: "set", meta: structuredClone(params.meta) },
        source: native ? { ...source, kind: "reset" } : source,
      },
      assertCurrent,
      matchesOwner
        ? () => {
            assertCurrent();
            // Foreign writers bypass lifecycle publications; each final grant reads the live row.
            if (!matchesOwner()) {
              throw new Error("Canonical ACP session changed before reset publication");
            }
          }
        : undefined,
    );
    assertCurrent();
  } finally {
    retained.release();
  }
}
