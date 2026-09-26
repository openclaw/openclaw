import { assertRequiredWorkerSelection } from "../../config/required-worker-profile.js";
import type { PreparedAgentRunAdmission } from "../admitted-run-context.js";
import { resolveAgentRunSessionTarget } from "../run-session-target.js";
import { prepareRequiredSessionPlacement } from "../session-placement-admission.js";

/** Canonicalize existing identity before mandatory placement; do not manufacture helper sessions. */
export async function prepareRequiredRunSessionTarget(
  params: Omit<Parameters<typeof resolveAgentRunSessionTarget>[0], "missingSessionKey"> & {
    agentHarnessId?: string;
    agentHarnessRuntimeOverride?: string;
    preparedRunAdmission?: PreparedAgentRunAdmission;
    abortSignal?: AbortSignal;
  },
) {
  assertRequiredWorkerSelection(params.config ?? {}, {
    agentRuntime: params.agentHarnessId ?? params.agentHarnessRuntimeOverride,
  });
  const target = await resolveAgentRunSessionTarget({ ...params, missingSessionKey: "create" });
  await prepareRequiredSessionPlacement(target, {
    config: params.config,
    assertCurrent: () => params.preparedRunAdmission?.assertSourceCurrent(),
    signal: params.abortSignal,
  });
  return target;
}
