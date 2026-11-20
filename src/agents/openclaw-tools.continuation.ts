import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { isCronRunSessionKey } from "../sessions/session-key-utils.js";
import { gateAgentToolExecution } from "./agent-tool-availability.js";
import type { OpenClawToolsOptions } from "./openclaw-tools.types.js";
import type { AnyAgentTool } from "./tools/common.js";
import { buildInventoryContinuationToolOpts } from "./tools/continuation-inventory-opts.js";
import { createContinueDelegateTool } from "./tools/continue-delegate-tool.js";
import { createContinueWorkTool } from "./tools/continue-work-tool.js";
import { createRequestCompactionTool } from "./tools/request-compaction-tool.js";

const log = createSubsystemLogger("agents/openclaw-tools");

type OpenClawContinuationToolOptions = Pick<
  OpenClawToolsOptions,
  | "drainsContinuationDelegateQueue"
  | "disableContinuationTools"
  | "fixedToolListing"
  | "continueWorkOpts"
  | "requestCompactionOpts"
>;

export function createOpenClawContinuationTools(
  options: OpenClawContinuationToolOptions & {
    config?: OpenClawConfig;
    agentSessionKey?: string;
    runSessionKey?: string;
    sessionId?: string;
    runId?: string;
  },
): AnyAgentTool[] {
  if (options.config?.agents?.defaults?.continuation?.enabled !== true) {
    return [];
  }
  if (options.disableContinuationTools === true) {
    // A fixed listing sends one tool list per prompt series, pinned at its first request
    // (#201710). A turn that may not continue lists the same tools, built with the inventory
    // callbacks, and refuses their calls.
    return options.fixedToolListing
      ? createOpenClawContinuationTools({
          ...options,
          ...buildInventoryContinuationToolOpts(options.config),
          disableContinuationTools: false,
        }).map((tool) =>
          gateAgentToolExecution(
            tool,
            `${tool.name} is not available in this turn. Do not retry ${tool.name}.`,
          ),
        )
      : [];
  }

  const liveSessionKey = options.runSessionKey ?? options.agentSessionKey;
  const tools: AnyAgentTool[] = [];
  if (options.continueWorkOpts) {
    tools.push(
      createContinueWorkTool({
        agentSessionKey: options.agentSessionKey,
        ...options.continueWorkOpts,
      }),
    );
  }
  // Nothing drains a cron run's delegate queue (#1469). Embedded cron runs
  // already disable continuation tools; a CLI-backend cron run reaches this
  // through the MCP loopback catalog, which keeps continue_delegate, and ends
  // without an announce. Accepted cost: a chat.send turn on a restored cron
  // run session, which would drain, is not offered continue_delegate either.
  const registersDelegateTool =
    options.drainsContinuationDelegateQueue !== false && !isCronRunSessionKey(liveSessionKey);
  if (registersDelegateTool) {
    tools.push(
      createContinueDelegateTool({ agentSessionKey: liveSessionKey, runId: options.runId }),
    );
  }
  if (options.requestCompactionOpts) {
    tools.push(
      createRequestCompactionTool({
        agentSessionKey: liveSessionKey,
        sessionId: options.sessionId,
        runId: options.runId,
        ...options.requestCompactionOpts,
      }),
    );
  }

  if (registersDelegateTool && !options.continueWorkOpts && !options.requestCompactionOpts) {
    log.warn(
      "continuation.enabled=true but neither continueWorkOpts nor requestCompactionOpts " +
        "were supplied — only continue_delegate will register. If this is a live runner, it " +
        "must supply both callbacks for the full continuation tool set (likely a config/wiring " +
        "gap). If this is an inventory/catalog/dispatch build, register the tools via stub " +
        "callbacks (buildInventoryContinuationToolOpts) so the catalog reflects the full surface " +
        "and this warning is satisfied honestly rather than suppressed.",
      {
        agentSessionKey: options.agentSessionKey,
        runSessionKey: options.runSessionKey,
        drainsContinuationDelegateQueue: options.drainsContinuationDelegateQueue,
      },
    );
  }
  return tools;
}
