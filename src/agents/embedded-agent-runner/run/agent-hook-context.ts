import {
  buildAgentHookContextChannelFields,
  buildAgentHookContextIdentityFields,
} from "../../../plugins/hook-agent-context.js";
import type { PluginHookAgentContext } from "../../../plugins/hook-types.js";
import {
  assertMemoryAudienceCurrent,
  assertMemoryAudienceSession,
} from "../../../plugins/memory-audience.js";
import type { EmbeddedRunAttemptParams } from "./types.js";

type EmbeddedAgentHookRun = Pick<
  EmbeddedRunAttemptParams,
  "runId" | "sessionId" | "sessionKey" | "workspaceDir" | "trigger" | "memoryAudience" | "sandbox"
> &
  Parameters<typeof buildAgentHookContextChannelFields>[0] &
  Parameters<typeof buildAgentHookContextIdentityFields>[0];

export function buildEmbeddedAgentHookContext(
  run: EmbeddedAgentHookRun,
  agentId: string,
  trace: PluginHookAgentContext["trace"],
) {
  if (run.memoryAudience) {
    assertMemoryAudienceSession(run.memoryAudience, run.sessionKey);
  }
  return {
    runId: run.runId,
    trace,
    agentId,
    sessionKey: run.sessionKey,
    sessionId: run.sessionId,
    memoryAudience: run.memoryAudience,
    assertMemoryAudienceCurrent: run.memoryAudience
      ? () => assertMemoryAudienceCurrent(run.memoryAudience!)
      : undefined,
    sandboxed: run.sandbox?.enabled === true,
    workspaceDir: run.workspaceDir,
    trigger: run.trigger,
    ...buildAgentHookContextChannelFields(run),
    ...buildAgentHookContextIdentityFields(run),
  };
}
