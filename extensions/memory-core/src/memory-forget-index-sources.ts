import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import { resolveOpenClawAgentSqlitePath } from "openclaw/plugin-sdk/sqlite-runtime";
import { resolveStateDir } from "openclaw/plugin-sdk/state-paths";
import type { ForgetIndexPlan, ForgetIndexReadInput } from "./memory-forget-index-task.js";

const loadMemoryCpuWorkerRuntime = createLazyRuntimeModule(
  () => import("./memory/manager-cpu-worker-runtime.js"),
);

export async function planMemoryIndex(
  params: {
    agentId: string;
    changedPaths: ReadonlySet<string>;
    removedPaths: ReadonlySet<string>;
    sessionIds: ReadonlySet<string>;
    excludedSessionIds: ReadonlySet<string>;
    entryKeys: ReadonlySet<string>;
    corpusSnippets: ReadonlySet<string>;
  },
  options: Parameters<typeof resolveOpenClawAgentSqlitePath>[0],
): Promise<ForgetIndexPlan> {
  const request: ForgetIndexReadInput = {
    kind: "forget-index-plan",
    agentId: params.agentId,
    databasePath: resolveOpenClawAgentSqlitePath(options),
    stateDir: resolveStateDir(options.env),
    changedPaths: [...params.changedPaths],
    removedPaths: [...params.removedPaths],
    sessionIds: [...params.sessionIds],
    excludedSessionIds: [...params.excludedSessionIds],
    entryKeys: [...params.entryKeys],
    corpusSnippets: [...params.corpusSnippets],
  };
  const { runMemoryForgetIndexPlan } = await loadMemoryCpuWorkerRuntime();
  return runMemoryForgetIndexPlan(request);
}
