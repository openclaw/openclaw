import {
  buildAgentHookContextChannelFields,
  buildAgentHookContextIdentityFields,
} from "../../../plugins/hook-agent-context.js";
import type { PluginHookAgentContext } from "../../../plugins/hook-types.js";
import { buildAgentHookMemoryAudienceFields } from "../../harness/hook-context.js";
import type { EmbeddedRunAttemptParams } from "./types.js";

type EmbeddedAgentHookRun = Pick<
  EmbeddedRunAttemptParams,
  | "runId"
  | "jobId"
  | "sessionId"
  | "sessionKey"
  | "workspaceDir"
  | "trigger"
  | "memoryAudience"
  | "sandbox"
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
    jobId: run.jobId,
    trace,
    agentId,
    sessionKey: run.sessionKey,
    sessionId: run.sessionId,
    ...buildAgentHookMemoryAudienceFields(run.memoryAudience, run.sessionKey),
    sandboxed: run.sandbox?.enabled === true,
    workspaceDir: run.workspaceDir,
    trigger: run.trigger,
    ...buildAgentHookContextChannelFields(run),
    ...buildAgentHookContextIdentityFields(run),
  };
}
