import type { PreparedModelRuntimeSnapshot } from "../../prepared-model-runtime.js";
import {
  resolveRootedRunRuntimeWorkspace,
  resolveRunWorkspaceDir,
  type ResolveRunWorkspaceResult,
} from "../../workspace-run.js";
import type { RunEmbeddedAgentParamsWithSessionFile } from "./internal-params.js";

/** Selects plugin-generation facts independently from a rooted run's execution boundary. */
export function resolvePreparedRuntimeWorkspaces(params: RunEmbeddedAgentParamsWithSessionFile) {
  const requestedWorkspaceResolution = resolveRunWorkspaceDir(params);
  const rootedRuntimeWorkspace = resolveRootedRunRuntimeWorkspace({
    ...params,
    workspaceDir: requestedWorkspaceResolution.workspaceDir,
  });
  return {
    requestedWorkspaceResolution,
    runtimeWorkspaceResolution: rootedRuntimeWorkspace ?? requestedWorkspaceResolution,
    preserveExecutionWorkspace: rootedRuntimeWorkspace !== undefined,
  };
}

/** Rebinds every config-derived run projection to one committed prepared generation. */
export function bindRunToPreparedModelRuntime(params: {
  runParams: RunEmbeddedAgentParamsWithSessionFile;
  requestedWorkspaceResolution: ResolveRunWorkspaceResult;
  preserveExecutionWorkspace?: boolean;
  preparedModelRuntime: PreparedModelRuntimeSnapshot;
}): {
  runParams: RunEmbeddedAgentParamsWithSessionFile;
  workspaceResolution: ResolveRunWorkspaceResult;
} {
  const preparedAgentId =
    params.preparedModelRuntime.agentId ?? params.requestedWorkspaceResolution.agentId;
  const workspaceResolution = {
    ...params.requestedWorkspaceResolution,
    agentId: preparedAgentId,
    workspaceDir: params.preserveExecutionWorkspace
      ? params.requestedWorkspaceResolution.workspaceDir
      : (params.preparedModelRuntime.workspaceDir ??
        params.requestedWorkspaceResolution.workspaceDir),
  };
  return {
    runParams: {
      ...params.runParams,
      agentId: preparedAgentId,
      agentDir: params.preparedModelRuntime.agentDir,
      config: params.preparedModelRuntime.config,
      workspaceDir: workspaceResolution.workspaceDir,
    },
    workspaceResolution,
  };
}
