/**
 * Owner-only tools whose eligibility comes from a retained requester or operator.
 * A run's tools are built once, so each call rechecks that authority before
 * the tool runs. A started call finishes; Stop still cancels it.
 */
import { GATEWAY_OWNER_ONLY_CORE_TOOLS } from "../security/dangerous-tools.js";
import { wrapAgentToolExecutionContext } from "./agent-tool-metadata.js";
import { isAutomationsToolName } from "./tools/automations-tool-name.js";
import type { AnyAgentTool } from "./tools/common.js";

const OWNER_ONLY_TOOLS: ReadonlySet<string> = new Set(GATEWAY_OWNER_ONLY_CORE_TOOLS);

// The automations tool keeps its own self-scoped grant, which non-owners also hold.
function isGuardedOwnerTool(tool: AnyAgentTool): boolean {
  return OWNER_ONLY_TOOLS.has(tool.name) && !isAutomationsToolName(tool.name);
}

export function guardOwnerTool<T extends AnyAgentTool>(tool: T, assertOwnerCurrent: () => void): T {
  if (!isGuardedOwnerTool(tool)) {
    return tool;
  }
  const run = async <R>(operation: () => Promise<R>): Promise<R> => {
    assertOwnerCurrent();
    return await operation();
  };
  return wrapAgentToolExecutionContext(
    tool,
    (...args) => run(() => tool.execute(...args)),
    run,
    (source) => guardOwnerTool(source, assertOwnerCurrent),
  );
}

/** Rechecks the scheduled requester's owner status before each owner-only tool call. */
export function guardScheduledOwnerOnlyTools(
  tools: AnyAgentTool[],
  assertOwnerCurrent: (() => void) | undefined,
): AnyAgentTool[] {
  if (!assertOwnerCurrent) {
    return tools;
  }
  return tools.map((tool) => guardOwnerTool(tool, assertOwnerCurrent));
}
