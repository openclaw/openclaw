import { createWorkspaceMemoryFileClient } from "openclaw/plugin-sdk/agent-workspace-runtime";
import { runNodeWorkspaceWorker, type NodeWorkspaceWorkerOptions } from "./workspace-worker.js";

/** Only transport changes: the shared client and native worker own Memory semantics. */
export function createNodeWorkspaceMemory(options: NodeWorkspaceWorkerOptions) {
  return createWorkspaceMemoryFileClient({
    workspaceDir: options.workspaceDir,
    remoteWorkspaceDir: options.remoteRoot,
    signal: options.signal,
    request: (request, signal) =>
      runNodeWorkspaceWorker(options, "workspace.memory", { request, watch: false }, signal),
    subscribe: async (request, onLine, signal) => {
      await runNodeWorkspaceWorker(
        options,
        "workspace.memory",
        { request, watch: true },
        signal,
        onLine,
      );
    },
  });
}
