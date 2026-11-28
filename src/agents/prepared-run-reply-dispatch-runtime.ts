import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveAgentDir, resolveAgentWorkspaceDir } from "./agent-scope-config.js";
import { readCapturedPreparedModelRuntimeCatalog } from "./prepared-model-runtime.capture.js";
import { acquireAgentRunPreparedModelRuntime } from "./prepared-model-runtime.js";
import type {
  PreparedModelRuntimeLease,
  PreparedReplyDispatchRuntime,
} from "./prepared-model-runtime.types.js";
import { projectReplyDispatchRuntime } from "./prepared-reply-dispatch-runtime.js";

/**
 * Dispatch facts for a process that hosts agent turns without a Gateway publication, such as
 * one-shot `agent --local`: the requested agent's run generation, under the same lease contract
 * as `loadPublishedGatewayReplyDispatchRuntime`.
 */
export async function loadRunReplyDispatchRuntime(params: {
  config: OpenClawConfig;
  agentId: string;
  abortSignal?: AbortSignal;
  onRuntimeLease: (lease: PreparedModelRuntimeLease) => void;
}): Promise<PreparedReplyDispatchRuntime> {
  const { config, agentId } = params;
  const lease = await acquireAgentRunPreparedModelRuntime(
    {
      config,
      agentId,
      agentDir: resolveAgentDir(config, agentId),
      workspaceDir: resolveAgentWorkspaceDir(config, agentId),
    },
    { abortSignal: params.abortSignal },
  );
  let runtime: PreparedReplyDispatchRuntime;
  try {
    const catalog = readCapturedPreparedModelRuntimeCatalog(lease.snapshot);
    runtime = Object.freeze({
      ...projectReplyDispatchRuntime(lease.snapshot, lease.pluginGeneration, "run"),
      readFullModelCatalog: () => catalog,
    });
  } catch (error) {
    await lease[Symbol.asyncDispose]();
    throw error;
  }
  params.onRuntimeLease(lease);
  return runtime;
}
