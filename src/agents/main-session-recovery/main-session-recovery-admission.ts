import { retainPreparedSessionSharingFacts } from "../../config/sessions/session-accessor.sqlite-entry-cache-publication-state.js";
import {
  projectSessionSharingEntry,
  type SessionSharingEntry,
} from "../../config/sessions/session-accessor.sqlite-entry-cache.types.js";
import { withSessionStoreReaderInWorker } from "../../config/sessions/session-entry-read-runtime.js";
import type { InternalSessionEntry as SessionEntry } from "../../config/sessions/types.js";
import { getAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import {
  beginSessionWorkAdmission,
  cancelSessionWorkAdmissionHandoff,
} from "../../sessions/session-lifecycle-admission.js";

/** Process-wide identity for startup recovery before its reply operation is registered. */
export const MAIN_SESSION_RECOVERY_WORK_ADMISSION_OWNER = Symbol.for(
  "openclaw.mainSessionRecoveryWorkAdmission",
);

export type MainSessionRecoveryAdmission = {
  handoffId: string;
  shouldContinue: () => boolean;
  beginDispatch: () => boolean;
};

/** Keep the exact worker source and committed postimages through recovery admission. */
export async function withPreparedRestartRecoveryTarget<T>(
  params: { agentId?: string; sessionKey: string; storePath: string },
  consume: (target: {
    entry: SessionEntry | undefined;
    readCurrent: () => SessionSharingEntry | undefined;
    assertSourceCurrent: () => void;
  }) => Promise<T>,
): Promise<T> {
  let retained: ReturnType<typeof retainPreparedSessionSharingFacts> | undefined;
  try {
    return await withSessionStoreReaderInWorker(
      params,
      async ({ reader, database, continuation, assertCurrent }) => {
        if (!retained) {
          throw new Error("Restart recovery target has no prepared publication source");
        }
        await retained.prepareRead();
        assertCurrent();
        const result = await reader.readExactEntries({
          sessionKeys: [params.sessionKey],
          projection: "full",
          env: database.env,
          continuation,
        });
        assertCurrent();
        const entry = result.entries.find(
          ({ sessionKey }) => sessionKey === params.sessionKey,
        )?.entry;
        retained.initialize({
          entry: entry ? projectSessionSharingEntry(entry) : undefined,
          membership: new Set(),
        });
        const facts = retained;
        const value = await consume({
          entry,
          readCurrent: () => {
            assertCurrent();
            return facts.readCurrent()?.entry;
          },
          assertSourceCurrent: assertCurrent,
        });
        assertCurrent();
        return value;
      },
      {
        prepareSource: (_database, identity) => {
          retained = retainPreparedSessionSharingFacts({
            databaseIdentity: identity.key,
            sessionKey: params.sessionKey,
            acquiring: true,
          });
        },
      },
    );
  } finally {
    retained?.release();
  }
}

/** Keeps pending dispatch visible to foreground admission until the Gateway adopts it. */
export async function runWithMainSessionRecoveryAdmission<T>(params: {
  storePath: string;
  sessionKey: string;
  canonicalSessionKey?: string;
  sessionId: string;
  admission?: MainSessionRecoveryAdmission;
  lifecycleGeneration?: string;
  shouldContinue?: () => boolean;
  isCurrent: () => boolean;
  run: (admission: MainSessionRecoveryAdmission) => Promise<T>;
}): Promise<T | undefined> {
  const lifecycleGeneration = params.lifecycleGeneration ?? getAgentEventLifecycleGeneration();
  let interrupted = false;
  let dispatchStarted = false;
  const shouldContinue = () =>
    (!interrupted || dispatchStarted) &&
    params.shouldContinue?.() !== false &&
    lifecycleGeneration === getAgentEventLifecycleGeneration();
  if (!shouldContinue() || !params.isCurrent()) {
    return undefined;
  }
  if (params.admission) {
    return params.admission.shouldContinue() ? await params.run(params.admission) : undefined;
  }

  const ownershipChanged = new Error("restart recovery session ownership changed before dispatch");
  let admission: Awaited<ReturnType<typeof beginSessionWorkAdmission>>;
  try {
    admission = await beginSessionWorkAdmission({
      scope: params.storePath,
      identities: [params.sessionKey, params.canonicalSessionKey, params.sessionId],
      owner: MAIN_SESSION_RECOVERY_WORK_ADMISSION_OWNER,
      onInterrupt: () => {
        interrupted = true;
      },
      assertAllowed: () => {
        if (!shouldContinue() || !params.isCurrent()) {
          throw ownershipChanged;
        }
      },
    });
  } catch (error) {
    if (error === ownershipChanged || interrupted) {
      return undefined;
    }
    throw error;
  }
  const handoffId = admission.createHandoff();
  try {
    return await admission.run(() =>
      params.run({
        handoffId,
        shouldContinue,
        beginDispatch: () => {
          if (!shouldContinue()) {
            return false;
          }
          // Interrupted preparation may stop, but an in-flight RPC must
          // settle before lifecycle replacement can release this owner.
          dispatchStarted = true;
          return true;
        },
      }),
    );
  } finally {
    cancelSessionWorkAdmissionHandoff(handoffId);
  }
}
