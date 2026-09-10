import { copyConfigResolutionFacts } from "../../config/resolution-facts.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";

/** A per-run narrowing overlay; no mutable global snapshot or permission widening. */
export function constrainAgentCommandWorkspaceTools(config: OpenClawConfig): OpenClawConfig {
  const tools = (source: OpenClawConfig["tools"]) => ({
    ...source,
    fs: { ...source?.fs, workspaceOnly: true },
    exec: { ...source?.exec, applyPatch: { ...source?.exec?.applyPatch, workspaceOnly: true } },
  });
  const narrowed: OpenClawConfig = {
    ...config,
    tools: tools(config.tools),
    agents: {
      ...config.agents,
      entries: Object.fromEntries(
        Object.entries(config.agents?.entries ?? {}).map(([key, entry]) => [
          key,
          { ...entry, tools: tools(entry.tools) },
        ]),
      ),
    },
  };
  copyConfigResolutionFacts(config, narrowed);
  return narrowed;
}
