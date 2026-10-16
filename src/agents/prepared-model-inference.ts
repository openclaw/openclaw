import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolvePluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
import { withPluginRuntimeGenerationScope } from "../plugins/runtime/generation-scope.js";
import { runWithAsyncWorkResources } from "../shared/async-work-resources.js";
import { AsyncWorkScope } from "../shared/async-work-scope.js";
import { resolveAgentDir, resolveAgentWorkspaceDir, resolveDefaultAgentId } from "./agent-scope.js";
import {
  createAgentRuntimeMetadataPluginIdScope,
  type AgentHarnessPluginSelection,
} from "./harness/runtime-plugin-load-plan.js";
import {
  acquireAgentRunPreparedModelRuntime,
  type PreparedModelRuntimeSnapshot,
} from "./prepared-model-runtime.js";
type PreparedModelInferenceContext = {
  preparedModelRuntime: PreparedModelRuntimeSnapshot;
  workspaceDir: string;
};

/** Execute a typed task inside the same prepared generation and physical cleanup owner as chat. */
export async function withPreparedModelInference<Result>(
  params: { cfg: OpenClawConfig; agentId?: string; signal: AbortSignal },
  selection: AgentHarnessPluginSelection,
  execute: (context: PreparedModelInferenceContext) => Promise<Result>,
): Promise<Result> {
  const failures = new Set<unknown>();
  const work = new AsyncWorkScope(failures);
  const abort = () => work.run(() => work.beginClose(params.signal?.reason));
  params.signal?.addEventListener("abort", abort, { once: true });
  if (params.signal?.aborted) {
    abort();
  }
  await using cleanup = new AsyncDisposableStack();
  cleanup.defer(() => params.signal?.removeEventListener("abort", abort));
  cleanup.defer(async () => {
    await work.drain();
    const failure = failures.values().next();
    if (!failure.done) {
      throw failure.value;
    }
  });
  return await work.run(() =>
    runWithAsyncWorkResources(async (onAcquired, captureWorkContext) => {
      const agentId = params.agentId ?? resolveDefaultAgentId(params.cfg);
      const workspaceDir = resolveAgentWorkspaceDir(params.cfg, agentId);
      const metadataSnapshot = resolvePluginMetadataSnapshot({
        config: params.cfg,
        env: process.env,
        workspaceDir,
        pluginIdScope: createAgentRuntimeMetadataPluginIdScope({
          config: params.cfg,
          workspaceDir,
          selections: [{ ...selection, agentId }],
        }),
        allowWorkspaceScopedCurrent: true,
      });
      const lease = await acquireAgentRunPreparedModelRuntime(
        {
          config: params.cfg,
          agentId,
          agentDir: resolveAgentDir(params.cfg, agentId),
          workspaceDir,
          loadRuntimePlugins: true,
          runtimePluginSelections: [{ ...selection, agentId }],
        },
        {
          catalogMode: "static",
          abortSignal: params.signal,
          pluginMetadataSnapshot: metadataSnapshot,
        },
      );
      onAcquired({ release: () => lease[Symbol.asyncDispose]() });
      const context: PreparedModelInferenceContext = {
        preparedModelRuntime: lease.snapshot,
        workspaceDir: lease.snapshot.workspaceDir ?? workspaceDir,
      };
      params.signal?.throwIfAborted();
      return withPluginRuntimeGenerationScope(context.preparedModelRuntime, async () => {
        captureWorkContext();
        if (!context.preparedModelRuntime.isCurrent()) {
          throw new Error("Prepared model inference generation is no longer current.");
        }
        const result = await execute(context);
        params.signal?.throwIfAborted();
        if (!context.preparedModelRuntime.isCurrent()) {
          throw new Error("Prepared model inference generation is no longer current.");
        }
        return result;
      });
    }),
  );
}
