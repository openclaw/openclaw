import type { CliDeps } from "../../cli/deps.types.js";
import { createLazyImportLoader } from "../../shared/lazy-promise.js";
import type { getRemoteSkillEligibility } from "../../skills/runtime/remote.js";
import type { resolveReusableWorkspaceSkillSnapshot } from "../../skills/runtime/session-snapshot.js";

export type AttemptExecutionRuntime = typeof import("./attempt-execution.runtime.js");
export type AgentAttemptResult = Awaited<ReturnType<AttemptExecutionRuntime["runAgentAttempt"]>>;
export type AcpManagerRuntime = typeof import("../../acp/control-plane/manager.js");
export type AcpPolicyRuntime = typeof import("../../acp/policy.js");
export type AcpRuntimeErrorsRuntime = typeof import("../../acp/runtime/errors.js");
export type AcpSessionIdentifiersRuntime =
  typeof import("@openclaw/acp-core/runtime/session-identifiers");
export type DeliveryRuntime = typeof import("./delivery.runtime.js");
export type SessionStoreRuntime = typeof import("./session-store.runtime.js");
export type CliCompactionRuntime = typeof import("./cli-compaction.js");
export type TranscriptResolveRuntime =
  typeof import("../../config/sessions/transcript-resolve.runtime.js");
export type CliDepsRuntime = typeof import("../../cli/deps.js");
export type ExecDefaultsRuntime = typeof import("../exec-defaults.js");
export type SkillsRuntime = {
  getRemoteSkillEligibility: typeof getRemoteSkillEligibility;
  resolveReusableWorkspaceSkillSnapshot: typeof resolveReusableWorkspaceSkillSnapshot;
};

const attemptExecutionRuntimeLoader = createLazyImportLoader<AttemptExecutionRuntime>(
  () => import("./attempt-execution.runtime.js"),
);
const acpManagerRuntimeLoader = createLazyImportLoader<AcpManagerRuntime>(
  () => import("../../acp/control-plane/manager.js"),
);
const acpPolicyRuntimeLoader = createLazyImportLoader<AcpPolicyRuntime>(
  () => import("../../acp/policy.js"),
);
const acpRuntimeErrorsRuntimeLoader = createLazyImportLoader<AcpRuntimeErrorsRuntime>(
  () => import("../../acp/runtime/errors.js"),
);
const acpSessionIdentifiersRuntimeLoader = createLazyImportLoader<AcpSessionIdentifiersRuntime>(
  () => import("@openclaw/acp-core/runtime/session-identifiers"),
);
const deliveryRuntimeLoader = createLazyImportLoader<DeliveryRuntime>(
  () => import("./delivery.runtime.js"),
);
const sessionStoreRuntimeLoader = createLazyImportLoader<SessionStoreRuntime>(
  () => import("./session-store.runtime.js"),
);
const cliCompactionRuntimeLoader = createLazyImportLoader<CliCompactionRuntime>(
  () => import("./cli-compaction.js"),
);
const transcriptResolveRuntimeLoader = createLazyImportLoader<TranscriptResolveRuntime>(
  () => import("../../config/sessions/transcript-resolve.runtime.js"),
);
const cliDepsRuntimeLoader = createLazyImportLoader<CliDepsRuntime>(
  () => import("../../cli/deps.js"),
);
const execDefaultsRuntimeLoader = createLazyImportLoader<ExecDefaultsRuntime>(
  () => import("../exec-defaults.js"),
);
const skillsRuntimeLoader = createLazyImportLoader<SkillsRuntime>(async () => {
  const [remote, sessionSnapshot] = await Promise.all([
    import("../../skills/runtime/remote.js"),
    import("../../skills/runtime/session-snapshot.js"),
  ]);
  return {
    getRemoteSkillEligibility: remote.getRemoteSkillEligibility,
    resolveReusableWorkspaceSkillSnapshot: sessionSnapshot.resolveReusableWorkspaceSkillSnapshot,
  };
});

export function loadAttemptExecutionRuntime(): Promise<AttemptExecutionRuntime> {
  return attemptExecutionRuntimeLoader.load();
}

export function loadAcpManagerRuntime(): Promise<AcpManagerRuntime> {
  return acpManagerRuntimeLoader.load();
}

export function loadAcpPolicyRuntime(): Promise<AcpPolicyRuntime> {
  return acpPolicyRuntimeLoader.load();
}

export function loadAcpRuntimeErrorsRuntime(): Promise<AcpRuntimeErrorsRuntime> {
  return acpRuntimeErrorsRuntimeLoader.load();
}

export function loadAcpSessionIdentifiersRuntime(): Promise<AcpSessionIdentifiersRuntime> {
  return acpSessionIdentifiersRuntimeLoader.load();
}

export function loadDeliveryRuntime(): Promise<DeliveryRuntime> {
  return deliveryRuntimeLoader.load();
}

export function loadSessionStoreRuntime(): Promise<SessionStoreRuntime> {
  return sessionStoreRuntimeLoader.load();
}

export function loadCliCompactionRuntime(): Promise<CliCompactionRuntime> {
  return cliCompactionRuntimeLoader.load();
}

export function loadTranscriptResolveRuntime(): Promise<TranscriptResolveRuntime> {
  return transcriptResolveRuntimeLoader.load();
}

export function loadExecDefaultsRuntime(): Promise<ExecDefaultsRuntime> {
  return execDefaultsRuntimeLoader.load();
}

export function loadSkillsRuntime(): Promise<SkillsRuntime> {
  return skillsRuntimeLoader.load();
}

export async function resolveAgentCommandDeps(deps: CliDeps | undefined): Promise<CliDeps> {
  if (deps) {
    return deps;
  }
  const { createDefaultDeps } = await cliDepsRuntimeLoader.load();
  return createDefaultDeps();
}
