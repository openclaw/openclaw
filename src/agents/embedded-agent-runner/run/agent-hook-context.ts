import {
  buildAgentHookContextChannelFields,
  buildAgentHookContextIdentityFields,
} from "../../../plugins/hook-agent-context.js";
import type { PluginHookAgentContext } from "../../../plugins/hook-types.js";
import type { EmbeddedRunAttemptParams } from "./types.js";

type EmbeddedAgentHookRun = Pick<
  EmbeddedRunAttemptParams,
  "runId" | "sessionId" | "sessionKey" | "workspaceDir" | "trigger"
> &
  Parameters<typeof buildAgentHookContextChannelFields>[0] &
  Parameters<typeof buildAgentHookContextIdentityFields>[0];

export function buildEmbeddedAgentHookContext(
  run: EmbeddedAgentHookRun,
  agentId: string,
  trace: PluginHookAgentContext["trace"],
) {
  return {
    runId: run.runId,
    trace,
    agentId,
    sessionKey: run.sessionKey,
    sessionId: run.sessionId,
    workspaceDir: run.workspaceDir,
    trigger: run.trigger,
    ...buildAgentHookContextChannelFields(run),
    ...buildAgentHookContextIdentityFields(run),
  };
}
