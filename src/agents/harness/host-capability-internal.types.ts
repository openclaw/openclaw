import type { EmbeddedRunAttemptInternalParams } from "../embedded-agent-runner/run/internal-params.js";

export type AgentHarnessHostAttempt = Partial<EmbeddedRunAttemptInternalParams> &
  Pick<EmbeddedRunAttemptInternalParams, "admittedRunContext" | "runId">;

export type AgentHarnessHostCapabilityParams = {
  attempt: AgentHarnessHostAttempt;
  pluginId: string;
  requiredNodeCommands?: readonly string[];
  nativeModelPolicySupport?: "exact";
  toolCalls?: "deny";
  /** Build generation tools without a chat task or delivery destination. */
  mediaResultOnly?: true;
};
