import { getAgentToolExecutionContext } from "../../../../packages/agent-core/src/tool-execution-context.js";
import { toToolDefinitions } from "../../agent-tool-definition-adapter.js";
import type { CreateAgentSessionOptions } from "../../sessions/sdk.js";
import { wrapToolDefinition } from "../../sessions/tools/tool-definition-wrapper.js";
import { isOnDemandCatalogTool } from "../../tool-search-catalog.js";
import { resolveToolSearchCatalogTool, TOOL_CALL_RAW_TOOL_NAME } from "../../tool-search.js";
import { log } from "../logger.js";
import type { prepareEmbeddedAttemptClientTools } from "./attempt-client-tools.js";
import { withEmbeddedAttemptToolActivity } from "./tool-activity-heartbeat.js";
import type { EmbeddedRunAttemptParams } from "./types.js";

type AttemptDeferredToolInput = {
  attempt: Pick<EmbeddedRunAttemptParams, "config" | "sessionId" | "runId">;
  clientTools: Pick<
    Parameters<typeof prepareEmbeddedAttemptClientTools>[0],
    | "codeModeControlsEnabledForRun"
    | "deferredDirectoryToolsCallable"
    | "getToolAbortSignal"
    | "onPromoteTool"
    | "sandboxSessionKey"
    | "toolSearchCatalogRef"
    | "catalogToolHookContext"
  >;
  customTools: readonly { name: string }[];
  runAbortSignal: AbortSignal;
  sessionAgentId: string;
};

function resolveAttemptCatalogTool(input: AttemptDeferredToolInput, name: string) {
  const { attempt, clientTools } = input;
  return resolveToolSearchCatalogTool(
    {
      config: attempt.config,
      runtimeConfig: attempt.config,
      agentId: input.sessionAgentId,
      sessionKey: clientTools.sandboxSessionKey,
      sessionId: attempt.sessionId,
      runId: attempt.runId,
      catalogRef: clientTools.toolSearchCatalogRef,
      abortSignal: clientTools.getToolAbortSignal?.() ?? input.runAbortSignal,
    },
    name,
  );
}

function hydrateAttemptCatalogTool(
  input: AttemptDeferredToolInput,
  tool: NonNullable<ReturnType<typeof resolveAttemptCatalogTool>>,
) {
  const { attempt, clientTools } = input;
  const toolAbortSignal = clientTools.getToolAbortSignal?.() ?? input.runAbortSignal;
  // Catalog entries own hooks; the adapter must carry the captured
  // generation into them so approvals cannot outlive a permission change.
  const definition = toToolDefinitions(
    [tool],
    clientTools.catalogToolHookContext,
    toolAbortSignal,
  )[0];
  const hydratedTool = definition ? wrapToolDefinition(definition) : undefined;
  if (hydratedTool) {
    const originalExecute = hydratedTool.execute;
    hydratedTool.execute = (...args: Parameters<typeof originalExecute>) =>
      withEmbeddedAttemptToolActivity(attempt.runId, () => originalExecute(...args));
  }
  return hydratedTool;
}

/**
 * Looking up an on-demand tool loads it: later requests in this run send its definition,
 * so the model can call it by name, and the session pin keeps it on later turns.
 */
export function installAttemptOnDemandToolLoader(input: AttemptDeferredToolInput): void {
  const catalogRef = input.clientTools.toolSearchCatalogRef;
  if (!catalogRef) {
    return;
  }
  catalogRef.loadOnDemandTool = (name) => {
    const tool = resolveAttemptCatalogTool(input, name);
    if (!tool || !isOnDemandCatalogTool(tool)) {
      return;
    }
    const hydratedTool = hydrateAttemptCatalogTool(input, tool);
    if (!hydratedTool) {
      return;
    }
    getAgentToolExecutionContext()?.loadTool?.(hydratedTool);
    input.clientTools.onPromoteTool?.(hydratedTool);
    log.info(`tool-search: loaded on-demand tool ${name} after lookup`);
  };
}

export function createAttemptDeferredToolResolver(
  input: AttemptDeferredToolInput,
): CreateAgentSessionOptions["resolveDeferredTool"] {
  const { clientTools } = input;
  const codeMode = clientTools.codeModeControlsEnabledForRun;
  if (
    !codeMode &&
    !clientTools.deferredDirectoryToolsCallable &&
    !input.customTools.some((tool) => tool.name === TOOL_CALL_RAW_TOOL_NAME)
  ) {
    return undefined;
  }
  return ({ toolCall }) => {
    const tool = resolveAttemptCatalogTool(input, toolCall.name);
    // An on-demand tool also loads on a direct call by name, in every catalog mode.
    const onDemand = tool !== undefined && isOnDemandCatalogTool(tool);
    if (codeMode && !onDemand) {
      const entries = clientTools.toolSearchCatalogRef?.current?.entries;
      if (entries?.some((entry) => entry.name === toolCall.name)) {
        throw new Error(
          "This tool is available through Code Mode, not as a top-level tool. This call did not execute it. Use exec with JavaScript: find its callable handle with catalog.search(...), use handle.describe() for the input schema, then await the handle with the tool arguments.",
        );
      }
      return undefined;
    }
    if (tool && !onDemand && !clientTools.deferredDirectoryToolsCallable) {
      throw new Error(
        `Tool ${toolCall.name} is deferred and not directly callable. Call ${TOOL_CALL_RAW_TOOL_NAME} with id ${JSON.stringify(tool.name)} and its parameters in args.`,
      );
    }
    const hydratedTool = tool ? hydrateAttemptCatalogTool(input, tool) : undefined;
    if (hydratedTool) {
      log.info(`tool-search: hydrated deferred directory tool ${toolCall.name}`);
      if (onDemand) {
        // The agent loop keeps the hydrated definition for this run; the session pin keeps it after.
        clientTools.onPromoteTool?.(hydratedTool);
      }
    }
    return hydratedTool;
  };
}
