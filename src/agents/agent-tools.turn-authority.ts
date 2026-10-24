import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  gateAgentToolExecution,
  markAgentToolExecutionUnavailable,
} from "./agent-tool-availability.js";
import { copyAgentToolMetadata } from "./agent-tool-metadata.js";
import { CRON_SCOPED_READ_ACTIONS, isAutomationsToolName } from "./tools/automations-tool-name.js";
import { readToolStringParam, type AnyAgentTool } from "./tools/common.js";

/**
 * A scheduler notice or wake (for example "automation was auto-disabled"). The
 * session-event executor derives the `event` trigger; clients cannot set it.
 * Scheduled runs (`cron` trigger) are excluded: hook-mapped jobs carry external
 * content, and webhook wakes use the `hook` source.
 */
export function isSchedulerSystemTurn(params: {
  trigger?: string;
  inputProvenance?: { kind?: string; sourceTool?: string };
}): boolean {
  return (
    params.trigger === "event" &&
    params.inputProvenance?.kind === "internal_system" &&
    params.inputProvenance.sourceTool === "cron"
  );
}

/**
 * Offers the session's tool surface on every turn, so the provider prompt prefix
 * stays cacheable, and gates the calls this turn's authority does not cover.
 * Owner-only tools and a completion handoff's replayed requester policy are
 * per-turn authority; they never hide a tool definition.
 */
export function resolveTurnToolSurface(params: {
  /** Tools the full per-turn policy admits. */
  turnTools: AnyAgentTool[];
  /** The session surface, when per-turn policy narrows it; defaults to `turnTools`. */
  sessionTools?: AnyAgentTool[];
  ownerOnlyDenied: ReadonlySet<string>;
  /**
   * The scheduler started this turn (see `isSchedulerSystemTurn`), not a sender.
   * Its owner-only gate still serves the caller-scoped automation reads the
   * scheduler authorizes without an owner grant.
   */
  schedulerSystemTurn?: boolean;
}) {
  const turnAuthorizedNames = new Set(
    params.turnTools
      .filter((tool) => !params.ownerOnlyDenied.has(tool.name))
      .map((tool) => tool.name),
  );
  const turnAuthorized = (tool: { name: string }) => turnAuthorizedNames.has(tool.name);
  const turnPolicyTools = new Map(params.turnTools.map((tool) => [tool.name, tool]));
  const offered = params.sessionTools ?? params.turnTools;
  const tools = offered.map((tool) => {
    if (turnAuthorized(tool)) {
      return tool;
    }
    const ownerOnly = params.ownerOnlyDenied.has(tool.name);
    // A completion handoff's requester policy may omit the tool; that denial wins.
    const turnTool = turnPolicyTools.get(tool.name);
    const scopedReads =
      ownerOnly &&
      params.schedulerSystemTurn === true &&
      turnTool !== undefined &&
      isAutomationsToolName(tool.name) &&
      // Preparation can perform work; only a plain executor can be split by action.
      !turnTool.prepareArguments &&
      !turnTool.prepareBeforeToolCallParams &&
      !turnTool.finalizeBeforeToolCallParams;
    const gated = gateAgentToolExecution(
      tool,
      scopedReads
        ? `On this automation-started turn, ${tool.name} runs only the ${CRON_SCOPED_READ_ACTIONS.join(", ")} actions. Other actions need the owner's authority, and this turn was not started by the owner. Do not retry them.`
        : ownerOnly
          ? `${tool.name} needs the owner's authority, and this turn was not started by the owner. Do not retry ${tool.name}.`
          : `${tool.name} is outside the authority this completion turn carries from its requester. Do not retry ${tool.name}.`,
    );
    // Copying hook metadata also copies the availability binding; re-mark the denial
    // so dependent affordances (for example collector spawns) never treat it as callable.
    // A split executor stays marked: only this turn's own reads pass, never descendants.
    return markAgentToolExecutionUnavailable(
      copyAgentToolMetadata(
        tool,
        scopedReads && turnTool
          ? { ...gated, execute: splitScopedReadExecutor(turnTool, gated) }
          : gated,
      ),
    );
  });
  return {
    tools,
    turnAuthorized,
    /** Policy-approved tools for descendant snapshots. */
    exportedTools: params.turnTools.filter(turnAuthorized),
    /** Tools this turn may call. */
    callableTools: offered.filter(turnAuthorized),
  };
}

/**
 * Without an owner grant the scheduler serves only caller-visible records;
 * management and every write keep their owner gate.
 */
function splitScopedReadExecutor(tool: AnyAgentTool, gated: AnyAgentTool): AnyAgentTool["execute"] {
  return async (toolCallId, args, ...rest) => {
    // Read the action exactly as the automations executor does.
    const action = isRecord(args) ? readToolStringParam(args, "action") : undefined;
    return action !== undefined && CRON_SCOPED_READ_ACTIONS.includes(action)
      ? await tool.execute(toolCallId, args, ...rest)
      : await gated.execute(toolCallId, args, ...rest);
  };
}
