import { toToolDefinitions } from "../../agent-tool-definition-adapter.js";
import type { CreateAgentSessionOptions } from "../../sessions/sdk.js";
import { wrapToolDefinition } from "../../sessions/tools/tool-definition-wrapper.js";
import { resolveToolSearchCatalogTool, TOOL_CALL_RAW_TOOL_NAME } from "../../tool-search.js";
import { log } from "../logger.js";
import type { prepareEmbeddedAttemptClientTools } from "./attempt-client-tools.js";
import { withEmbeddedAttemptToolActivity } from "./tool-activity-heartbeat.js";
import type { EmbeddedRunAttemptParams } from "./types.js";

export function createAttemptDeferredToolResolver(input: {
  attempt: Pick<EmbeddedRunAttemptParams, "config" | "sessionId" | "runId">;
  clientTools: Pick<
    Parameters<typeof prepareEmbeddedAttemptClientTools>[0],
    | "codeModeControlsEnabledForRun"
    | "deferredDirectoryToolsCallable"
    | "getToolAbortSignal"
    | "sandboxSessionKey"
    | "toolSearchCatalogRef"
    | "catalogToolHookContext"
  >;
  customTools: readonly { name: string }[];
  runAbortSignal: AbortSignal;
  sessionAgentId: string;
}): CreateAgentSessionOptions["resolveDeferredTool"] {
  const { attempt, clientTools } = input;
  const codeMode = clientTools.codeModeControlsEnabledForRun;
  if (
    !codeMode &&
    !clientTools.deferredDirectoryToolsCallable &&
    !input.customTools.some((tool) => tool.name === TOOL_CALL_RAW_TOOL_NAME)
  ) {
    return undefined;
  }
  return ({ toolCall }) => {
    if (codeMode) {
      const entries = clientTools.toolSearchCatalogRef?.current?.entries;
      if (entries?.some((entry) => entry.name === toolCall.name)) {
        throw new Error(
          "This tool is available through Code Mode, not as a top-level tool. This call did not execute it. Use exec with JavaScript: find its callable handle with catalog.search(...), use handle.describe() for the input schema, then await the handle with the tool arguments.",
        );
      }
      return undefined;
    }
    const toolAbortSignal = clientTools.getToolAbortSignal?.() ?? input.runAbortSignal;
    const tool = resolveToolSearchCatalogTool(
      {
        config: attempt.config,
        runtimeConfig: attempt.config,
        agentId: input.sessionAgentId,
        sessionKey: clientTools.sandboxSessionKey,
        sessionId: attempt.sessionId,
        runId: attempt.runId,
        catalogRef: clientTools.toolSearchCatalogRef,
        abortSignal: toolAbortSignal,
      },
      toolCall.name,
    );
    if (tool && !clientTools.deferredDirectoryToolsCallable) {
      throw new Error(
        `Tool ${toolCall.name} is deferred and not directly callable. Call ${TOOL_CALL_RAW_TOOL_NAME} with id ${JSON.stringify(tool.name)} and its parameters in args.`,
      );
    }
    // Catalog entries own hooks; the adapter must carry the captured
    // generation into them so approvals cannot outlive a permission change.
    const definition = tool
      ? toToolDefinitions([tool], clientTools.catalogToolHookContext, toolAbortSignal)[0]
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
