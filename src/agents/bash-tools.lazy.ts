import { createLazyImportLoader } from "../shared/lazy-promise.js";
import { describeExecTool } from "./bash-tools.descriptions.js";
import type { ExecToolDefaults } from "./bash-tools.exec-types.js";
import { execSchema } from "./bash-tools.schemas.js";
import { EXEC_TOOL_DISPLAY_SUMMARY } from "./tool-description-presets.js";
import type { AnyAgentTool } from "./tools/common.js";

type BashToolsModule = typeof import("./bash-tools.js");

const bashToolsModuleLoader = createLazyImportLoader<BashToolsModule>(
  () => import("./bash-tools.js"),
);

export function loadBashToolsModule(): Promise<BashToolsModule> {
  return bashToolsModuleLoader.load();
}

/**
 * Returns a lightweight `AnyAgentTool` stub for the bash `exec` tool that
 * defers loading the heavyweight `bash-tools` runtime until `execute` is
 * actually invoked. Both the agent path (`agent-tools`) and the Gateway HTTP
 * `/tools/invoke` path (`tool-resolution`) use this so the static import
 * graph for either surface stays small.
 *
 * Builds nothing config-shaped: callers pass `defaults` already resolved
 * (the agent path threads them through `createOpenClawCodingTools`; the HTTP
 * path layers HTTP-specific overrides on top of `resolveExecConfig`).
 * Owner-only enforcement on the HTTP surface lives in
 * `GATEWAY_OWNER_ONLY_CORE_TOOLS`; this factory does not encode it.
 */
export function createLazyExecTool(opts: { defaults?: ExecToolDefaults }): AnyAgentTool {
  const { defaults } = opts;
  let loadedTool: AnyAgentTool | undefined;
  const loadTool = async () => {
    if (!loadedTool) {
      const { createExecTool } = await loadBashToolsModule();
      loadedTool = createExecTool(defaults) as unknown as AnyAgentTool;
    }
    return loadedTool;
  };

  return {
    name: "exec",
    label: "exec",
    displaySummary: EXEC_TOOL_DISPLAY_SUMMARY,
    get description() {
      return describeExecTool({
        agentId: defaults?.agentId,
        hasCronTool: defaults?.hasCronTool === true,
      });
    },
    parameters: execSchema,
    prepareBeforeToolCallParams: async (...args) =>
      (await loadTool()).prepareBeforeToolCallParams?.(...args) ?? args[0],
    finalizeBeforeToolCallParams: (params, preparedParams) =>
      loadedTool?.finalizeBeforeToolCallParams?.(params, preparedParams) ?? params,
    execute: async (...args: Parameters<NonNullable<AnyAgentTool["execute"]>>) =>
      (await loadTool()).execute(...args),
  } as AnyAgentTool;
}
