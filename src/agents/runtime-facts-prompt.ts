/** Compact current-turn snapshots; instructions belong in the stable system prompt. */
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { buildTemporalContextText } from "./date-time.js";
import type { RuntimeContextFragment } from "./internal-runtime-context.js";
import { buildInterruptedInputContext } from "./interrupted-input-context.js";
import { buildMediaTaskRuntimeContext } from "./media-generation-task-status.js";
import type { AgentRunSessionTarget } from "./run-session-target.types.js";
import {
  buildExecutionHostRuntimeFacts,
  type ExecutionHostRuntimeFactsParams,
} from "./runtime-execution-facts.js";
import { buildActiveSubagentRuntimeContext } from "./subagents/registry/subagent-active-context.js";

export async function buildRuntimeFactsContext(
  params: ExecutionHostRuntimeFactsParams & {
    cfg: OpenClawConfig;
    executionHost?: boolean;
    sessionTarget?: AgentRunSessionTarget;
  },
): Promise<RuntimeContextFragment[]> {
  const includeEmptySnapshots = params.includeEmptySnapshots === true;
  const facts = params.executionHost === false ? [] : await buildExecutionHostRuntimeFacts(params);
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
  const interrupted = await buildInterruptedInputContext(params);
  if (interrupted) {
    facts.push(interrupted);
  }
  facts.push({
    kind: "conversation-data",
    text: buildTemporalContextText({
      configuredTimezone: params.cfg.agents?.defaults?.userTimezone,
      sessionStatusAvailable: params.capabilityToolNames.has("session_status"),
    }),
  });
  return facts;
}
