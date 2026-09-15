import type { CliDeps } from "../../cli/deps.types.js";
import { createLazyPromise } from "../../shared/lazy-promise.js";
import type { getRemoteSkillEligibility } from "../../skills/runtime/remote.js";
import type { resolveReusableWorkspaceSkillSnapshot } from "../../skills/runtime/session-snapshot.js";

type AttemptExecutionRuntime = typeof import("./attempt-execution.runtime.js");
export type AgentAttemptResult = Awaited<ReturnType<AttemptExecutionRuntime["runAgentAttempt"]>>;
type AcpManagerRuntime = typeof import("../../acp/control-plane/manager.js");
type AcpPolicyRuntime = typeof import("../../acp/policy.js");
type AcpRuntimeErrorsRuntime = typeof import("../../acp/runtime/errors.js");
type AcpSessionIdentifiersRuntime = typeof import("@openclaw/acp-core/runtime/session-identifiers");
type DeliveryRuntime = typeof import("./delivery.runtime.js");
type SessionStoreRuntime = typeof import("./session-store.runtime.js");
type CliCompactionRuntime = typeof import("./cli-compaction.js");
type AgentRunnerMemoryRuntime = typeof import("../../auto-reply/reply/agent-runner-memory.js");
type TranscriptResolveRuntime =
  typeof import("../../config/sessions/transcript-resolve.runtime.js");
type TranscriptAppendRuntime = typeof import("../../config/sessions/transcript.runtime.js");
type CliDepsRuntime = typeof import("../../cli/deps.js");
type ExecDefaultsRuntime = typeof import("../exec-defaults.js");
type SkillsRuntime = {
  getRemoteSkillEligibility: typeof getRemoteSkillEligibility;
  resolveReusableWorkspaceSkillSnapshot: typeof resolveReusableWorkspaceSkillSnapshot;
};

export const loadAttemptExecutionRuntime = createLazyPromise<AttemptExecutionRuntime>(
  () => import("./attempt-execution.runtime.js"),
);
export const loadAcpManagerRuntime = createLazyPromise<AcpManagerRuntime>(
  () => import("../../acp/control-plane/manager.js"),
);
export const loadAcpPolicyRuntime = createLazyPromise<AcpPolicyRuntime>(
  () => import("../../acp/policy.js"),
);
export const loadAcpRuntimeErrorsRuntime = createLazyPromise<AcpRuntimeErrorsRuntime>(
  () => import("../../acp/runtime/errors.js"),
);
export const loadAcpSessionIdentifiersRuntime = createLazyPromise<AcpSessionIdentifiersRuntime>(
  () => import("@openclaw/acp-core/runtime/session-identifiers"),
);
export const loadDeliveryRuntime = createLazyPromise<DeliveryRuntime>(
  () => import("./delivery.runtime.js"),
);
export const loadSessionStoreRuntime = createLazyPromise<SessionStoreRuntime>(
  () => import("./session-store.runtime.js"),
);
export const loadCliCompactionRuntime = createLazyPromise<CliCompactionRuntime>(
  () => import("./cli-compaction.js"),
);
export const loadAgentRunnerMemoryRuntime = createLazyPromise<AgentRunnerMemoryRuntime>(
  () => import("../../auto-reply/reply/agent-runner-memory.js"),
);
export const loadTranscriptResolveRuntime = createLazyPromise<TranscriptResolveRuntime>(
  () => import("../../config/sessions/transcript-resolve.runtime.js"),
);
export const loadTranscriptAppendRuntime = createLazyPromise<TranscriptAppendRuntime>(
  () => import("../../config/sessions/transcript.runtime.js"),
);
const loadCliDepsRuntime = createLazyPromise<CliDepsRuntime>(() => import("../../cli/deps.js"));
export const loadExecDefaultsRuntime = createLazyPromise<ExecDefaultsRuntime>(
  () => import("../exec-defaults.js"),
);
export const loadSkillsRuntime = createLazyPromise<SkillsRuntime>(async () => {
  const [remote, sessionSnapshot] = await Promise.all([
    import("../../skills/runtime/remote.js"),
    import("../../skills/runtime/session-snapshot.js"),
  ]);
  return {
    getRemoteSkillEligibility: remote.getRemoteSkillEligibility,
    resolveReusableWorkspaceSkillSnapshot: sessionSnapshot.resolveReusableWorkspaceSkillSnapshot,
  };
});

export async function resolveAgentCommandDeps(deps: CliDeps | undefined): Promise<CliDeps> {
  if (deps) {
    return deps;
  }
  const { createDefaultDeps } = await loadCliDepsRuntime();
  return createDefaultDeps();
}
