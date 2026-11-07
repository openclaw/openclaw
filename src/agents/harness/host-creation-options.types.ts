import type { EmbeddedRunAttemptInternalParams } from "../embedded-agent-runner/run/internal-params.js";

/** Host construction inputs never become public harness capabilities. */
export type AgentHarnessHostCreationOptions = {
  attempt: Partial<EmbeddedRunAttemptInternalParams> &
    Pick<EmbeddedRunAttemptInternalParams, "admittedRunContext" | "runId">;
  pluginId: string;
  requiredNodeCommands?: readonly string[];
  nativeModelPolicySupport?: "exact";
  toolCalls?: "deny";
  readToolPolicyScope?: () => "conversation" | "turn" | undefined;
};
