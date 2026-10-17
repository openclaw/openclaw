import { readRunOperatorAuthority } from "../admitted-run-context.js";
import { resolveSessionAgentIds } from "../agent-scope.js";
import { resolveContextInjectionMode, resolveWorkspaceContextRefresh } from "../bootstrap-files.js";
import type { EmbeddedRunAttemptParams } from "../embedded-agent-runner/run/types.js";
import { isBuiltInOpenClawAgentHarness } from "./builtin-openclaw.js";
import { AgentHarnessPreflightError } from "./errors.js";
import type { AgentHarness } from "./types.js";

export function assertHarnessModelPolicySupport(
  harness: AgentHarness,
  params: EmbeddedRunAttemptParams,
) {
  const authority = readRunOperatorAuthority(params);
  authority?.assertCurrent();
  if (
    !isBuiltInOpenClawAgentHarness(harness) &&
    authority?.modelPolicy &&
    harness.nativeModelPolicySupport !== "exact"
  ) {
    throw new AgentHarnessPreflightError(
      `Agent harness ${harness.id} cannot enforce your operator role's model policy. Choose a compatible runtime or ask a gateway administrator to update the harness.`,
    );
  }
  return authority;
}

export function assertPluginHarnessWorkspaceContextSupport(params: EmbeddedRunAttemptParams): void {
  const { sessionAgentId } = resolveSessionAgentIds(params);
  if (
    params.modelRun !== true &&
    params.promptMode !== "none" &&
    params.operation !== "settled-tool-finalization" &&
    params.sessionPersistence !== "detached" &&
    resolveContextInjectionMode(params.config, sessionAgentId) !== "never" &&
    resolveWorkspaceContextRefresh(params.config, sessionAgentId) === "compaction"
  ) {
    throw new AgentHarnessPreflightError(
      "workspaceContextRefresh=compaction requires a supported lifecycle harness (managed local Claude CLI or built-in local embedded compaction).",
    );
  }
}
