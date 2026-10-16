import { getAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import { enqueueCommandInLane } from "../../process/command-queue.js";
import { getGatewayRestartDrainSignal } from "../../process/gateway-work-admission.js";
import { CommandLane } from "../../process/lanes.js";
import { parseAgentSessionKey } from "../../routing/session-key.js";
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
  lane: CommandLane.Main | CommandLane.Background;
  shouldContinue: () => boolean;
  beginDispatch: () => boolean;
};

/** Keeps pending dispatch visible to foreground admission until the Gateway adopts it. */
export async function runWithMainSessionRecoveryAdmission<T>(params: {
  agentId?: string;
  storePath: string;
  sessionKey: string;
  canonicalSessionKey?: string;
  sessionId: string;
  admission?: MainSessionRecoveryAdmission;
  lane?: MainSessionRecoveryAdmission["lane"];
  lifecycleGeneration?: string;
  shouldContinue?: () => boolean;
  signal?: AbortSignal;
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

  const lane = params.lane ?? CommandLane.Background;
  // Demand-triggered recovery uses interactive capacity; unattended recovery stays
  // in Background. Both the backlog barrier and execution must use the same lane.
  // Backlog waits precede session ownership, retry charges and Gateway queue deadlines.
  // Exact retries must remain interruptible by reset without holding a session admission.
  await enqueueCommandInLane(lane, async () => {}, {
    abortSignal: params.signal
      ? AbortSignal.any([params.signal, getGatewayRestartDrainSignal()])
      : getGatewayRestartDrainSignal(),
  });
  if (!shouldContinue() || !params.isCurrent()) {
    return undefined;
  }

  const ownershipChanged = new Error("restart recovery session ownership changed before dispatch");
  let admission: Awaited<ReturnType<typeof beginSessionWorkAdmission>>;
  try {
    admission = await beginSessionWorkAdmission({
      agentId:
        params.agentId ??
        parseAgentSessionKey(params.canonicalSessionKey ?? params.sessionKey)?.agentId,
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
        lane,
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
