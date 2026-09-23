import type { OpenClawConfig } from "../config/types.openclaw.js";
import { findSwarmCollectorSession } from "./subagents/registry/subagent-registry-memory.js";
import {
  getSubagentRunByRunId,
  recordSwarmStructuredOutput,
} from "./subagents/registry/subagent-registry.js";
import { resolveSwarmConfig } from "./subagents/swarm/swarm-config.js";
import { createAgentsWaitTool } from "./tools/agents-wait-tool.js";
import type { AnyAgentTool } from "./tools/common.js";
import { createStructuredOutputTool } from "./tools/structured-output-tool.js";

/** Requester-facing tools a non-interactive collector turn must never receive. */
const COLLECTOR_WITHHELD_TOOL_NAMES = new Set(["ask_user", "sessions_send", "sessions_yield"]);

export type SwarmCollectorToolContext = {
  runId: string;
  swarmOutputSchema?: Record<string, unknown>;
};

/**
 * Identity a Gateway request must present to own an admitted collector run.
 * `admittedRunId` is the host-selected run id carried by a run-bound CLI client
 * grant. Session-scoped attach grants and owner-token callers carry none, so an
 * absent value can never match a collector record.
 */
export type SwarmCollectorAdmission = {
  childSessionKey?: string;
  admittedRunId?: string;
};

/**
 * A registry record answers to both its current Gateway run id and the launch id
 * retained as `swarmRunId`, which is the same pair `getSubagentRunByRunId`
 * matches. A queued relaunch swaps the first and keeps the second.
 */
function ownsAdmittedCollectorRun(
  entry: { runId: string; swarmRunId?: string },
  admittedRunId: string,
): boolean {
  return entry.runId === admittedRunId || entry.swarmRunId === admittedRunId;
}

/**
 * Collector context for tool surfaces built outside the embedded runner. CLI
 * backends receive their OpenClaw tools from the Gateway, which never carries
 * the spawn request's collector fields, so the subagent registry is read as the
 * durable owner of collector identity for that child session.
 *
 * The contract is granted only to the admitted collector run itself: the caller
 * has to present that run's own id, which reaches the resolver exclusively
 * through a Gateway-minted, run-bound CLI grant context.
 */
export function resolveSwarmCollectorToolContext(
  admission: SwarmCollectorAdmission,
): SwarmCollectorToolContext | undefined {
  const admittedRunId = admission.admittedRunId?.trim();
  if (!admittedRunId) {
    return undefined;
  }
  const entry = findSwarmCollectorSession(admission.childSessionKey);
  if (entry?.collect !== true || !ownsAdmittedCollectorRun(entry, admittedRunId)) {
    return undefined;
  }
  // Collector identity does not depend on a schema: the embedded runner reads
  // `swarmCollector` straight from the spawn request, and a schema-less collector
  // has no requester continuation to announce into either. Only the result
  // transport is schema gated, and a captured collector rejects further results,
  // so it keeps the identity and loses the schema.
  return {
    runId: entry.runId,
    ...(entry.outputSchema && !entry.collectorCompletion
      ? { swarmOutputSchema: entry.outputSchema }
      : {}),
  };
}

/**
 * Final authority gate, re-evaluated at write time rather than at tool
 * construction. Tool lists are cached per grant and a before-tool hook may await
 * between construction and execution, so a grant revoked inside that window must
 * not reach the durable collector record. Both operands are the ones that
 * admitted the tool: the grant's own liveness check and the same admitted-run
 * ownership test the resolver applied.
 */
export function createSwarmCollectorWriteAuthority(params: {
  admission: SwarmCollectorAdmission;
  isGrantCurrent?: () => boolean;
}): () => void {
  return () => {
    if (params.isGrantCurrent && !params.isGrantCurrent()) {
      throw new Error("collector run grant is no longer active");
    }
    if (!resolveSwarmCollectorToolContext(params.admission)) {
      throw new Error("caller no longer owns the admitted collector run");
    }
  };
}

/**
 * Applies the collector run contract to an already policy-filtered surface.
 * Collector output is run transport rather than an operator-configurable
 * capability, so it survives allowlists that would otherwise drop it.
 */
export function applySwarmCollectorToolContract<T extends { name: string }>(
  tools: T[],
  params: { swarmCollector?: boolean; structuredOutputTool?: T },
): T[] {
  if (!params.swarmCollector) {
    return tools;
  }
  const collectorTools = tools.filter((tool) => !COLLECTOR_WITHHELD_TOOL_NAMES.has(tool.name));
  const { structuredOutputTool } = params;
  if (
    structuredOutputTool &&
    !collectorTools.some((tool) => tool.name === structuredOutputTool.name)
  ) {
    collectorTools.push(structuredOutputTool);
  }
  return collectorTools;
}

export function createOpenClawSwarmToolGroups(params: {
  config?: OpenClawConfig;
  effectiveRequesterAgentId: string;
  agentSessionKey?: string;
  runSessionKey?: string;
  runId?: string;
  swarmCollector?: boolean;
  swarmOutputSchema?: Record<string, unknown>;
  /** Re-checked immediately before the result reaches the registry. */
  assertCollectorWriteAuthority?: () => void;
}): { structuredOutput: AnyAgentTool[]; agentsWait: AnyAgentTool[] } {
  const childSessionKey = params.runSessionKey ?? params.agentSessionKey;
  const collectorEntry =
    params.swarmCollector && params.swarmOutputSchema
      ? ((params.runId ? getSubagentRunByRunId(params.runId) : undefined) ??
        findSwarmCollectorSession(childSessionKey))
      : undefined;
  // Key the result by the registry record's run id, which is what the collector
  // reader consumes, rather than the caller-supplied run id (absent on the http
  // surface, and possibly a stale launch id after a queued relaunch).
  const structuredOutputRunId = collectorEntry?.runId ?? params.runId;
  const structuredOutput =
    params.swarmCollector && structuredOutputRunId && params.swarmOutputSchema
      ? [
          createStructuredOutputTool({
            runId: structuredOutputRunId,
            schema: params.swarmOutputSchema,
            initialState: collectorEntry?.structuredOutput,
            onStateChange: (state) => {
              // Throwing here rolls the in-memory state back and surfaces a tool
              // error, so a revoked authority writes nothing anywhere.
              params.assertCollectorWriteAuthority?.();
              recordSwarmStructuredOutput({ runId: structuredOutputRunId, childSessionKey }, state);
            },
          }),
        ]
      : [];
  const agentsWait = resolveSwarmConfig(params.config, params.effectiveRequesterAgentId).enabled
    ? [
        createAgentsWaitTool({
          agentSessionKey: params.agentSessionKey,
          runSessionKey: params.runSessionKey,
          agentId: params.effectiveRequesterAgentId,
          config: params.config,
        }),
      ]
    : [];
  return { structuredOutput, agentsWait };
}
