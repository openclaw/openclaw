import { createSqliteRunArtifactStore } from "./filesystem/run-artifact-store.sqlite.js";
import { createSqliteToolArtifactStore } from "./filesystem/tool-artifact-store.sqlite.js";
import { createSqliteVirtualAgentFs } from "./filesystem/virtual-agent-fs.sqlite.js";
import type { AgentRuntimeContext, PreparedAgentRun } from "./runtime-backend.js";

export function createSqliteAgentRuntimeFilesystem(
  preparedRun: Pick<
    PreparedAgentRun,
    "agentId" | "filesystemMode" | "initialVfsEntries" | "runId" | "workspaceDir"
  >,
): AgentRuntimeContext["filesystem"] {
  const scratch = createSqliteVirtualAgentFs({
    agentId: preparedRun.agentId,
    namespace: `run:${preparedRun.runId}`,
  });
  const artifacts = createSqliteToolArtifactStore({
    agentId: preparedRun.agentId,
    runId: preparedRun.runId,
  });
  const runArtifacts = createSqliteRunArtifactStore({
    agentId: preparedRun.agentId,
    runId: preparedRun.runId,
  });
  for (const entry of preparedRun.initialVfsEntries ?? []) {
    scratch.writeFile(entry.path, Buffer.from(entry.contentBase64, "base64"), {
      metadata: entry.metadata,
    });
  }
  return {
    scratch,
    artifacts,
    runArtifacts,
    ...(preparedRun.filesystemMode === "vfs-only"
      ? {}
      : { workspace: { root: preparedRun.workspaceDir } }),
  };
}
