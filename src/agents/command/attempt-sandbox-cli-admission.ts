import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { isSubagentSessionKey } from "../../routing/session-key.js";
import { AgentHarnessPreflightError } from "../harness/errors.js";
import { resolveSandboxRuntimeStatus } from "../sandbox/runtime-status.js";

/**
 * Sandboxed delegated children never dispatch to host-executed CLI backends.
 *
 * A CLI backend spawns a local AI CLI on the gateway host; its native tools run
 * with the gateway OS user outside any configured sandbox. Spawn admission
 * fails closed once the resolved child model is known, but fallback candidates
 * and post-spawn runtime overrides can still land on a CLI backend when the
 * run starts, so the run seam owns the invariant: refuse the CLI candidate for
 * any session with spawn provenance and whose sandbox classification (the
 * configured sandbox mode covering this session key, or a creation-stamped
 * `sandbox: "required"`) claims containment. Recovery is configuration: pick an
 * API-backed child model, or change the agent's sandbox policy explicitly.
 * Direct operator-chosen CLI runs on a non-delegated, unsandboxed session stay
 * permitted, mirroring the cron seam guard
 * (`assertCronCandidateSandboxPlacement`).
 */
export function assertSandboxedDelegatedChildNotCli(params: {
  useCliExecution: boolean;
  cliExecutionProvider: string;
  cfg: OpenClawConfig;
  sessionKey: string | undefined;
  sessionAgentId: string;
  sessionEntry: SessionEntry | undefined;
}): void {
  if (!params.useCliExecution) {
    return;
  }
  // Spawn provenance only: hidden children carry a subagent key and spawnedBy;
  // visible spawns receive spawnedBy from the trusted spawn policy. A bare
  // parentSessionKey is general topology (dashboard chats parent to main), not
  // delegation, so operator-created sessions keep their CLI runtime.
  const delegatedChild =
    isSubagentSessionKey(params.sessionKey) || Boolean(params.sessionEntry?.spawnedBy?.trim());
  if (!delegatedChild) {
    return;
  }
  const placement = resolveSandboxRuntimeStatus({
    cfg: params.cfg,
    sessionKey: params.sessionKey,
    agentId: params.sessionAgentId,
    preparedSessionEntry: params.sessionEntry ?? null,
  });
  if (!placement.sandboxed && !placement.sandboxRequired) {
    return;
  }
  throw new AgentHarnessPreflightError(
    `This delegated run belongs to a sandboxed session, but resolved execution provider ${params.cliExecutionProvider} runs on the host and cannot honor the sandbox. Override agents.entries.<id>.subagents.model, agents.defaults.subagents.model, or the spawn model with an API-backed provider (and clear any pinned CLI runtime override), or change the agent's sandbox policy explicitly.`,
  );
}
