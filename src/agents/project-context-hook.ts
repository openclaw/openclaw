import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentBootstrapHookContext } from "../hooks/internal-hooks.js";
import { registerInternalHook } from "../hooks/internal-hooks.js";
import type { WorkspaceBootstrapFileName } from "./workspace.js";

/**
 * Bootstrap hook that injects PROJECT.md for project-scoped channels.
 *
 * Reads the `project` field from the agent's config entry. If set,
 * loads the corresponding PROJECT.md from ~/.openclaw/projects/<name>/PROJECT.md.
 *
 * Deduplication: if PROJECT.md was already injected by cwd walk-up (D-06),
 * this hook skips injection to avoid duplicates. CWD version takes priority.
 */
function projectContextBootstrapHandler(context: AgentBootstrapHookContext): void {
  // Skip if PROJECT.md already injected by cwd walk-up (D-06)
  if (context.bootstrapFiles.some((f) => f.name === "PROJECT.md")) {
    return;
  }

  const projectName = resolveProjectFromConfig(context);
  if (!projectName) {
    return;
  }

  const projectMdPath = path.join(os.homedir(), ".openclaw", "projects", projectName, "PROJECT.md");

  try {
    const content = fs.readFileSync(projectMdPath, "utf-8");
    context.bootstrapFiles.push({
      name: "PROJECT.md" as WorkspaceBootstrapFileName,
      path: projectMdPath,
      content,
      missing: false,
    });
  } catch {
    // Project configured but PROJECT.md missing -- silently skip
  }
}

/**
 * Resolve the project name from agent config.
 * Looks up the agent by agentId in cfg.agents.list, then reads the `project` field.
 */
function resolveProjectFromConfig(context: AgentBootstrapHookContext): string | undefined {
  const cfg = context.cfg;
  if (!cfg) {
    return undefined;
  }

  // Access agents.list to find the agent's config entry
  const agentsList = (cfg as Record<string, unknown>).agents as
    | { list?: Array<Record<string, unknown>> }
    | undefined;
  if (!agentsList?.list) {
    return undefined;
  }

  const agentId = context.agentId;
  if (!agentId) {
    return undefined;
  }

  const agentEntry = agentsList.list.find((a) => a.id === agentId);
  if (agentEntry?.project && typeof agentEntry.project === "string") {
    return agentEntry.project;
  }

  return undefined;
}

export function registerProjectContextHook(): void {
  registerInternalHook("agent:bootstrap", (event) => {
    const context = event.context as AgentBootstrapHookContext;
    projectContextBootstrapHandler(context);
  });
}
