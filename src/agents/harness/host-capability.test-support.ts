import { createAgentHarnessTaskRuntimeScope } from "../../tasks/agent-harness-task-runtime-scope.js";
import {
  createOperationalRunInstanceRef,
  prepareAgentRunAdmission,
  type AdmittedRunContext,
} from "../admitted-run-context.js";
import {
  bindCodeModeTranscriptAuthority,
  CodeModeTranscriptAuthority,
} from "../code-mode-transcript-authority.js";
import { createAgentHarnessHostCapabilities } from "./host-capability.js";

type HostAttempt = Parameters<typeof createAgentHarnessHostCapabilities>[0]["attempt"];
type TranscriptTarget = ConstructorParameters<typeof CodeModeTranscriptAuthority>[0];

type AdmittedHostCapabilityTestFixture = Readonly<{
  admittedRunContext: AdmittedRunContext;
  hostCapabilities: ReturnType<typeof createAgentHarnessHostCapabilities>["capabilities"];
  agentHarnessTaskRuntimeScope?: ReturnType<typeof createAgentHarnessTaskRuntimeScope>;
  runWithHostScope: ReturnType<typeof createAgentHarnessHostCapabilities>["runWithScope"];
  closeHost: () => void;
  closeAdmission: () => void;
}>;

/** Creates the same admitted authority and closure-bound host used by a real harness attempt. */
export async function createAdmittedHostCapabilityTestFixture(
  attempt: Omit<HostAttempt, "admittedRunContext">,
  options: Readonly<{ transcriptTarget?: TranscriptTarget }> = {},
): Promise<AdmittedHostCapabilityTestFixture> {
  const admission = prepareAgentRunAdmission({
    cfg: attempt.config ?? {},
    facts: {
      runId: attempt.runId,
      agentId: attempt.agentId ?? "main",
      ingress: { kind: "system", boundary: "host-capability-test", state: "present" },
    },
    operationalRunInstance: createOperationalRunInstanceRef(attempt.runId),
  });
  const admittedRunContext = await admission.admit("plugin-harness", `harness-${attempt.runId}`);
  const admittedAttempt = { ...attempt, admittedRunContext };
  if (options.transcriptTarget) {
    bindCodeModeTranscriptAuthority(
      admittedAttempt,
      new CodeModeTranscriptAuthority(options.transcriptTarget),
    );
  }
  const host = createAgentHarnessHostCapabilities({
    attempt: admittedAttempt,
    pluginId: "codex",
  });
  return {
    admittedRunContext,
    hostCapabilities: host.capabilities,
    runWithHostScope: host.runWithScope,
    ...(attempt.sessionKey
      ? {
          agentHarnessTaskRuntimeScope: createAgentHarnessTaskRuntimeScope({
            requesterSessionKey: attempt.sessionKey,
          }),
        }
      : {}),
    closeHost: host.close,
    closeAdmission: admission.close,
  };
}
