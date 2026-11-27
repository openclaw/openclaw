/** Compact current-turn snapshots; instructions belong in the stable system prompt. */
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { buildTemporalContextText, TEMPORAL_CONTEXT_HEADING } from "./date-time.js";
import {
  readRuntimeContextConversationData,
  type RuntimeContextFragment,
} from "./internal-runtime-context.js";
import {
  buildMediaTaskRuntimeContext,
  MEDIA_TASKS_HEADING,
} from "./media-generation-task-status.js";
import type { AgentRunSessionTarget } from "./run-session-target.types.js";
import {
  APPROVED_EXECUTABLES_HEADING,
  buildExecutionHostRuntimeFacts,
  EXEC_SESSIONS_HEADING,
  type ExecutionHostRuntimeFactsParams,
} from "./runtime-execution-facts.js";
import {
  buildActiveSubagentRuntimeContext,
  SUBAGENT_SNAPSHOT_HEADINGS,
} from "./subagents/registry/subagent-active-context.js";

// One entry per snapshot; a snapshot's first line is one of its entry's headings.
const SNAPSHOT_HEADINGS: readonly (readonly string[])[] = [
  [APPROVED_EXECUTABLES_HEADING],
  [EXEC_SESSIONS_HEADING],
  SUBAGENT_SNAPSHOT_HEADINGS,
  [MEDIA_TASKS_HEADING],
  [TEMPORAL_CONTEXT_HEADING],
];

function snapshotSlot(text: string): number {
  const heading = text.split("\n", 1)[0];
  return SNAPSHOT_HEADINGS.findIndex((headings) => headings.includes(heading!));
}

/**
 * Builds this turn's state snapshots, keeping only those that differ from the latest copy the
 * request already carries in `sentHistory`. A snapshot the request does not carry (new session,
 * compacted away, or cleared by the route) is sent in full, its empty form included.
 */
export async function buildRuntimeFactsContext(
  params: Omit<ExecutionHostRuntimeFactsParams, "includeEmptySnapshots"> & {
    cfg: OpenClawConfig;
    executionHost?: boolean;
    sessionTarget?: AgentRunSessionTarget;
    runId?: string;
    sentHistory: readonly unknown[];
  },
): Promise<RuntimeContextFragment[]> {
  const facts =
    params.executionHost === false
      ? []
      : await buildExecutionHostRuntimeFacts({ ...params, includeEmptySnapshots: true });
  const canSpawn = params.capabilityToolNames.has("sessions_spawn");
  const subagentContext = await buildActiveSubagentRuntimeContext({
    cfg: params.cfg,
    controllerSessionKey: params.sessionKey,
    controllerAgentId: params.agentId,
    runId: params.runId,
    includeSpawnContext: canSpawn,
  });
  if (subagentContext || canSpawn) {
    facts.push({
      kind: "conversation-data",
      text: subagentContext ?? `${SUBAGENT_SNAPSHOT_HEADINGS[0]}\nnone`,
    });
  }
  const media = await buildMediaTaskRuntimeContext({ ...params, includeEmptySnapshots: true });
  if (media) {
    facts.push({ kind: "conversation-data", text: media });
  }
  facts.push({
    kind: "conversation-data",
    text: buildTemporalContextText({
      configuredTimezone: params.cfg.agents?.defaults?.userTimezone,
      sessionStatusAvailable: params.capabilityToolNames.has("session_status"),
    }),
  });
  const sent = new Map<number, string>();
  for (const message of params.sentHistory.toReversed()) {
    for (const text of readRuntimeContextConversationData(message)) {
      const slot = snapshotSlot(text);
      if (slot >= 0 && !sent.has(slot)) {
        sent.set(slot, text);
      }
    }
  }
  return facts.filter((fact) => sent.get(snapshotSlot(fact.text)) !== fact.text);
}
