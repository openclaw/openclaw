import { toToolDefinitions } from "../../agent-tool-definition-adapter.js";
import type { CreateAgentSessionOptions } from "../../sessions/index.js";
import { wrapToolDefinition } from "../../sessions/tools/tool-definition-wrapper.js";
import { TOOL_CALL_RAW_TOOL_NAME } from "../../tool-catalog.js";
import { resolveToolSearchCatalogTool } from "../../tool-search.js";
import { log } from "../logger.js";
import type { prepareEmbeddedAttemptClientTools } from "./attempt-client-tools.js";
import { withEmbeddedAttemptToolActivity } from "./tool-activity-heartbeat.js";
import type { EmbeddedRunAttemptParams } from "./types.js";

/** Resolves a model call that names a tool deferred out of the provider-visible set. */
export function createAttemptDeferredToolResolver(input: {
  attempt: Pick<EmbeddedRunAttemptParams, "config" | "sessionId" | "runId">;
  clientToolPreparation: Pick<
    Parameters<typeof prepareEmbeddedAttemptClientTools>[0],
    | "catalogToolHookContext"
    | "deferredDirectoryToolsCallable"
    | "effectiveTools"
    | "getToolAbortSignal"
    | "sandboxSessionKey"
    | "toolSearchCatalogRef"
  >;
  runAbortSignal: AbortSignal;
  sessionAgentId: string;
}): CreateAgentSessionOptions["resolveDeferredTool"] {
  const { attempt, clientToolPreparation } = input;
  if (clientToolPreparation.deferredDirectoryToolsCallable) {
    return ({ toolCall }) => {
      const toolAbortSignal = clientToolPreparation.getToolAbortSignal?.() ?? input.runAbortSignal;
      const tool = resolveToolSearchCatalogTool(
        {
          config: attempt.config,
          runtimeConfig: attempt.config,
          agentId: input.sessionAgentId,
          sessionKey: clientToolPreparation.sandboxSessionKey,
          sessionId: attempt.sessionId,
          runId: attempt.runId,
          catalogRef: clientToolPreparation.toolSearchCatalogRef,
          abortSignal: toolAbortSignal,
        },
        toolCall.name,
      );
      // Catalog entries own hooks; the adapter must carry the captured
      // generation into them so approvals cannot outlive a permission change.
      const definition = tool
        ? toToolDefinitions(
            [tool],
            clientToolPreparation.catalogToolHookContext,
            toolAbortSignal,
          )[0]
        : undefined;
      const hydratedTool = definition ? wrapToolDefinition(definition) : undefined;
      if (hydratedTool) {
        log.info(`tool-search: hydrated deferred directory tool ${toolCall.name}`);
        const originalExecute = hydratedTool.execute;
        hydratedTool.execute = (...args: Parameters<typeof originalExecute>) =>
          withEmbeddedAttemptToolActivity(attempt.runId, () => originalExecute(...args));
      }
      return hydratedTool;
    };
  }
  // Tool Search `tools` mode runs deferred tools only through its dispatcher.
  if (!clientToolPreparation.effectiveTools.some((tool) => tool.name === TOOL_CALL_RAW_TOOL_NAME)) {
    return undefined;
  }
  return ({ toolCall }) => {
    const catalogRef = clientToolPreparation.toolSearchCatalogRef;
    if (resolveToolSearchCatalogTool({ catalogRef }, toolCall.name)) {
      throw new Error(
        `Tool ${toolCall.name} is deferred and not directly callable. Call ${TOOL_CALL_RAW_TOOL_NAME} with id "${toolCall.name}" and its parameters in args.`,
      );
    }
  };
}
