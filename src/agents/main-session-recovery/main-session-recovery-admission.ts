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
          // Interrupted capacity waits may stop, but an in-flight RPC must
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
