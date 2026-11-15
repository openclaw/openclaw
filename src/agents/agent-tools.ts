import { warnPluginSdkDeprecation } from "../plugins/sdk-deprecation.js";
import { assembleOpenClawCodingTools } from "./agent-tools.assembly.js";
import type { PluginCodingToolsOptions } from "./agent-tools.options.js";
import { prepareCodingToolAssembly } from "./agent-tools.preparation-sync.js";
import type { AnyAgentTool } from "./agent-tools.types.js";
import { withLegacySessionCapabilityRead } from "./subagents/spawn/subagent-session-store-legacy.js";

export {
  createOpenClawCodingToolsAsync,
  createOpenClawCodingToolsInternalAsync,
} from "./agent-tools.async.js";
export { resolveToolLoopDetectionConfig } from "./tool-loop-detection-config.js";

/** @deprecated Use createOpenClawCodingToolsInternalAsync for runtime construction. */
export function createOpenClawCodingToolsInternal(
  ...args: Parameters<typeof assembleOpenClawCodingTools>
): AnyAgentTool[] {
  return withLegacySessionCapabilityRead(() =>
    prepareCodingToolAssembly(assembleOpenClawCodingTools(...args)),
  );
}

/** @deprecated Use createOpenClawCodingToolsAsync to prepare policy through the worker. Supported through 2026-12-31. Removal in the first January 2027 stable release. */
export function createOpenClawCodingTools(options?: PluginCodingToolsOptions): AnyAgentTool[] {
  warnPluginSdkDeprecation({
    family: "tool-surface",
    method: "createOpenClawCodingTools",
    replacement: "await createOpenClawCodingToolsAsync()",
  });
  return createOpenClawCodingToolsInternal({ ...options, unverifiedExecutionPolicy: true });
}
