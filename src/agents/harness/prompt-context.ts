import path from "node:path";
import type { OpenClawConfig } from "../../config/types.js";
import { resolveAgentWorkspaceDir } from "../agent-scope-config.js";
import type { AgentHarnessAttemptParamsV2 } from "./types.js";

export function shouldIncludeAgentHarnessRuntimeContext(
  params: Pick<AgentHarnessAttemptParamsV2, "bootstrapContextMode" | "bootstrapContextRunKind">,
): boolean {
  // Lightweight cron runs can be exact commands; preserve their user input byte-for-byte.
  return !(
    params.bootstrapContextMode === "lightweight" && params.bootstrapContextRunKind === "cron"
  );
}

/** The backend selects the prompt workspace and supplies its admitted tool names. */
export function resolveAgentWorkspaceMemoryRouting(params: {
  config: OpenClawConfig | undefined;
  agentId: string | undefined;
  workspaceDir: string;
  toolNames: ReadonlySet<string>;
}): { memoryToolNames: string[]; memoryToolRouted: boolean } {
  const memoryToolNames = ["memory_search", "memory_get"].filter((name) =>
    params.toolNames.has(name),
  );
  return {
    memoryToolNames,
    memoryToolRouted:
      memoryToolNames.length > 0 &&
      params.config !== undefined &&
      params.agentId !== undefined &&
      path.resolve(resolveAgentWorkspaceDir(params.config, params.agentId)) ===
        path.resolve(params.workspaceDir),
  };
}
