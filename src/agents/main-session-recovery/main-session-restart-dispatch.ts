import {
  runWithMainSessionRecoveryAdmission,
  withPreparedRestartRecoveryTarget,
} from "./main-session-recovery-admission.js";
import { resumeMainSessionWithinAdmission } from "./main-session-restart-dispatch.runtime.js";
import type {
  MainSessionResumeResult,
  ResumeMainSessionParams,
} from "./main-session-restart-dispatch.types.js";

export {
  hasRestartRecoveryMessageActionAuthority,
  requiresRestartRecoveryMessageActionAuthority,
} from "./main-session-restart-dispatch-message.js";

export async function resumeMainSession(
  params: ResumeMainSessionParams,
): Promise<MainSessionResumeResult> {
  return await withPreparedRestartRecoveryTarget(
    params,
    async (target) =>
      (await runWithMainSessionRecoveryAdmission({
        ...params,
        sessionId: params.entry.sessionId,
        admission: params.recoveryAdmission,
        isCurrent: () => target.readCurrent()?.sessionId === params.entry.sessionId,
        run: (recoveryAdmission) =>
          resumeMainSessionWithinAdmission({
            ...params,
            recoveryAdmission,
            assertSourceCurrent: target.assertSourceCurrent,
            shouldContinueDelivery: params.shouldContinueDelivery ?? params.shouldContinue,
            shouldContinue: () => {
              target.assertSourceCurrent();
              return recoveryAdmission.shouldContinue();
            },
          }),
      })) ?? "skipped",
  );
}
