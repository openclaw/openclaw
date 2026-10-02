import { normalizeInputProvenance } from "../sessions/input-provenance.js";
import { captureHarnessCompletionRecovery } from "./agent-harness-completion-recovery.js";
import {
  createAgentHarnessCompletionScope,
  withAgentHarnessCompletionAdmission,
} from "./agent-harness-completion-scope.js";

/** Admit a synthetic native source through the same host capability used by harness delivery. */
export async function captureAdmittedHarnessCompletionForTest(
  params: Parameters<typeof captureHarnessCompletionRecovery>[0],
) {
  const provenance = normalizeInputProvenance(params.inputProvenance);
  if (!provenance?.sourceSessionKey) {
    throw new Error("fixture requires a native source");
  }
  return withAgentHarnessCompletionAdmission(
    {
      scope: createAgentHarnessCompletionScope({
        requesterSessionKey: params.sessionKey,
        requesterAgentId: params.agentId,
      }),
      sourceSessionKey: provenance.sourceSessionKey,
      sourceRunId: params.runId,
      requesterSessionId: params.entry.sessionId,
      requesterLifecycleRevision: params.entry.lifecycleRevision,
      isSourceCurrent: () => true,
    },
    async () => captureHarnessCompletionRecovery(params),
  );
}
