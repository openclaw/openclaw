import { resolveConfigPath } from "../config/paths.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveAgentDir, resolveAgentWorkspaceDir } from "./agent-scope.js";
import { isWorkspaceBootstrapPending } from "./workspace.js";

/** Describe an existing agent only after the creation owner admits its reuse. */
export async function createExistingAgentResult(
  config: OpenClawConfig,
  entry: { id: string; name?: string },
  fallbackName: string,
) {
  const workspace = resolveAgentWorkspaceDir(config, entry.id);
  return {
    status: "existing" as const,
    agentId: entry.id,
    name: entry.name ?? fallbackName,
    workspace,
    agentDir: resolveAgentDir(config, entry.id),
    bootstrapPending: await isWorkspaceBootstrapPending(workspace),
    config,
    configPath: resolveConfigPath(),
  };
}
