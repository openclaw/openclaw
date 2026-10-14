import { isCurrentPluginMetadataSnapshotRuntimeGeneration } from "../../../plugins/current-plugin-metadata-snapshot.js";
import { loadPluginMetadataSnapshot } from "../../../plugins/plugin-metadata-snapshot.js";
import type { PluginMetadataSnapshot } from "../../../plugins/plugin-metadata-snapshot.types.js";
import type { PreparedModelRuntimeSnapshot } from "../../prepared-model-runtime.js";
import {
  resolveCanonicalRunRuntimeWorkspace,
  resolveRootedRunRuntimeWorkspace,
  resolveRunWorkspaceDir,
  type ResolveRunWorkspaceResult,
} from "../../workspace-run.js";
import type { RunEmbeddedAgentParamsWithSessionFile } from "./internal-params.js";

type PreparedRuntimeWorkspaceParams = Parameters<typeof resolveRootedRunRuntimeWorkspace>[0] & {
  isCanonicalWorkspace: boolean;
};

/**
 * Selects the plugin-generation workspace for a run that executes outside it. Rooted runs borrow
 * their canonical bootstrap workspace. A Gateway projects one immutable boot inventory for every
 * run workspace, so its configured agent generation already owns the same plugins; building a
 * replacement would only cold-load that inventory again on the main thread.
 */
export function resolveSharedPluginRuntimeWorkspace(
  params: PreparedRuntimeWorkspaceParams,
  pluginMetadataSnapshot: () => PluginMetadataSnapshot,
): ResolveRunWorkspaceResult | undefined {
  const rooted = resolveRootedRunRuntimeWorkspace(params);
  if (rooted || params.isCanonicalWorkspace) {
    return rooted;
  }
  return isCurrentPluginMetadataSnapshotRuntimeGeneration(pluginMetadataSnapshot())
    ? resolveCanonicalRunRuntimeWorkspace(params)
    : undefined;
}

/** Selects plugin-generation facts independently from a run's execution boundary. */
export function resolvePreparedRuntimeWorkspaces(params: RunEmbeddedAgentParamsWithSessionFile) {
  const requestedWorkspaceResolution = resolveRunWorkspaceDir(params);
  const workspaceParams = {
    ...params,
    workspaceDir: requestedWorkspaceResolution.workspaceDir,
    isCanonicalWorkspace: requestedWorkspaceResolution.isCanonicalWorkspace,
  };
  // An admitted generation keeps its own workspace identity; only rooted selection applies.
  const sharedRuntimeWorkspace = params.pluginGeneration
    ? resolveRootedRunRuntimeWorkspace(workspaceParams)
    : resolveSharedPluginRuntimeWorkspace(workspaceParams, () =>
        loadPluginMetadataSnapshot({
          config: params.config ?? {},
          workspaceDir: requestedWorkspaceResolution.workspaceDir,
          env: process.env,
        }),
      );
  return {
    requestedWorkspaceResolution,
    runtimeWorkspaceResolution: sharedRuntimeWorkspace ?? requestedWorkspaceResolution,
    preserveExecutionWorkspace: sharedRuntimeWorkspace !== undefined,
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
