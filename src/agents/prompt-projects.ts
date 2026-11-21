import { AsyncLocalStorage } from "node:async_hooks";
import path from "node:path";
import { observeDiagnosticsTimelinePhases } from "../infra/diagnostics-timeline.js";
import { prepareEmbeddedSessionActiveProjectKeys } from "./embedded-agent-runner/session-prompt-state.js";
import { resolveProjectKey } from "./project-memory-scope.js";
import { resolveSystemPromptRepoRoot } from "./system-prompt-params.js";

const turnRepoRoots = new AsyncLocalStorage<Map<string, Promise<string | undefined>>>();

/** Hooks and fallback candidates share discovery only for their owning logical turn. */
export function withAgentPromptProjects<T>(run: () => Promise<T>): Promise<T> {
  return turnRepoRoots.run(new Map(), run);
}

export function prepareAgentPromptRepoRoot(
  params: Parameters<typeof resolveSystemPromptRepoRoot>[0] & { sessionId?: string },
) {
  const roots = turnRepoRoots.getStore();
  const key = JSON.stringify([
    params.sessionId,
    ...[params.config?.agents?.defaults?.repoRoot, params.workspaceDir, params.cwd].map((dir) =>
      dir?.trim() ? path.resolve(dir.trim()) : null,
    ),
  ]);
  const pending = roots?.get(key) ?? resolveSystemPromptRepoRoot(params);
  roots?.set(key, pending);
  return pending;
}

export async function prepareAgentPromptProjects(
  params: Parameters<typeof prepareAgentPromptRepoRoot>[0] & { sessionId: string },
) {
  using phases = observeDiagnosticsTimelinePhases("run.prepare.project_repo");
  const repoRoot = (await prepareAgentPromptRepoRoot(params)) ?? null;
  phases.mark("run.prepare.project_key");
  const projectKey = repoRoot ? await resolveProjectKey(repoRoot) : null;
  return {
    repoRoot,
    projectKey,
    activeProjectKeys: prepareEmbeddedSessionActiveProjectKeys(params.sessionId, projectKey),
  };
}
