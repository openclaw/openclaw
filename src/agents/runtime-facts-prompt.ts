/** Compact current-turn snapshots; instructions belong in the stable system prompt. */
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { RuntimeContextFragment } from "./internal-runtime-context.js";
import { buildMediaTaskRuntimeContext } from "./media-generation-task-status.js";
import {
  buildExecutionHostRuntimeFacts,
  type ExecutionHostRuntimeFactsParams,
} from "./runtime-execution-facts.js";
import { buildActiveSubagentRuntimeContext } from "./subagents/registry/subagent-active-context.js";

export async function buildRuntimeFactsContext(
  params: ExecutionHostRuntimeFactsParams & {
    cfg: OpenClawConfig;
    executionHost?: boolean;
  },
): Promise<RuntimeContextFragment[]> {
  const includeEmptySnapshots = params.includeEmptySnapshots === true;
  const facts = params.executionHost === false ? [] : buildExecutionHostRuntimeFacts(params);
  const canSpawn = params.capabilityToolNames.has("sessions_spawn");
  const subagentContext = await buildActiveSubagentRuntimeContext({
    cfg: params.cfg,
    controllerSessionKey: params.sessionKey,
    controllerAgentId: params.agentId,
    includeSpawnContext: canSpawn,
  });
  if (subagentContext || (canSpawn && includeEmptySnapshots)) {
    facts.push({ kind: "conversation-data", text: subagentContext ?? "## Active Subagents\nnone" });
  }
  const media = await buildMediaTaskRuntimeContext({ ...params, includeEmptySnapshots });
  if (media) {
    facts.push({ kind: "conversation-data", text: media });
  }
  return facts;
}
