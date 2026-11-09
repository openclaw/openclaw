import type { SessionResetCommitContext } from "../../config/sessions/session-accessor.lifecycle-types.js";
import type {
  SessionAcpMeta,
  InternalSessionEntry as SessionEntry,
} from "../../config/sessions/types.js";
import {
  assertExistingDatabaseIdentity,
  readDatabasePathIdentitySync,
} from "../../infra/sqlite-worker-identity.js";
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
  const source = {
    ...committedSource.source,
    identity: readDatabasePathIdentitySync(committedSource.source.path),
  };
  const entry = structuredClone(params.entry);
  const assertCurrent = () => {
    committedSource.assertCurrent();
    assertCallerCurrent?.();
    context.admission.assertCurrent();
    assertExistingDatabaseIdentity(source.path, source.identity.key, source.identity.birthtime);
  };
  await commitAcpSessionMutation(
    context,
    {
      agentId: params.agentId,
      storageSessionKey: params.sessionKey,
      sessionKey: params.sessionKey,
      entry,
      updatedAt: entry.updatedAt,
      decision: { kind: "set", meta: structuredClone(params.meta) },
      source: { ...source, kind: "reset" },
    },
    assertCurrent,
  );
}
