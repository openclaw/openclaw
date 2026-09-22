import type { CliDeps } from "../../cli/deps.types.js";
import { createLazyPromise } from "../../shared/lazy-promise.js";

type AttemptExecutionRuntime = typeof import("./attempt-execution.runtime.js");
export type AgentAttemptResult = Awaited<ReturnType<AttemptExecutionRuntime["runAgentAttempt"]>>;

export const loadAttemptExecutionRuntime = createLazyPromise(async () => {
  // Both embedded and ACP attempts must retain result delivery before inference
  // can outlive an installation replacement.
  const [attempt] = await Promise.all([
    import("./attempt-execution.runtime.js"),
    loadDeliveryRuntime(),
  ]);
  return attempt;
});
export const loadAcpManagerRuntime = createLazyPromise(
  () => import("../../acp/control-plane/manager.js"),
);
export const loadAcpPolicyRuntime = createLazyPromise(() => import("../../acp/policy.js"));
export const loadAcpRuntimeErrorsRuntime = createLazyPromise(
  () => import("../../acp/runtime/errors.js"),
);
export const loadAcpSessionIdentifiersRuntime = createLazyPromise(
  () => import("@openclaw/acp-core/runtime/session-identifiers"),
);
export const loadDeliveryRuntime = createLazyPromise(() => import("./delivery.runtime.js"));
export const loadSessionStoreRuntime = createLazyPromise(
  () => import("./session-store.runtime.js"),
);
export const loadCliCompactionRuntime = createLazyPromise(() => import("./cli-compaction.js"));
export const loadAgentRunnerMemoryRuntime = createLazyPromise(
  () => import("../../auto-reply/reply/agent-runner-memory.js"),
);
export const loadTranscriptResolveRuntime = createLazyPromise(
  () => import("../../config/sessions/transcript-resolve.runtime.js"),
);
export const loadTranscriptAppendRuntime = createLazyPromise(
  () => import("../../config/sessions/transcript.runtime.js"),
);
const loadCliDepsRuntime = createLazyPromise(() => import("../../cli/deps.js"));
export const loadExecDefaultsRuntime = createLazyPromise(() => import("../exec-defaults.js"));
export const loadSkillsRuntime = createLazyPromise(async () => {
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
