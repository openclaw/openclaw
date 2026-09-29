/** Owns local agent-command admission scopes outside a running Gateway. */
import type { CliDeps } from "../cli/deps.types.js";
import { getRuntimeConfig } from "../config/io.js";
import { withLocalGatewayRequestScope } from "../gateway/local-request-context.js";
import {
  captureAgentRunLifecycleGeneration,
  withAgentRunLifecycleGeneration,
} from "../infra/agent-events.js";
import { GatewayScheduler } from "../infra/gateway-scheduler.js";
import {
  getBoundLegacyPluginSdkResourceHost,
  LegacyPluginSdkResourceHost,
} from "../plugins/legacy-sdk-resource-host.js";
import {
  collectRegistryInvocationInstances,
  PluginInvocationScope,
} from "../plugins/plugin-invocation-scope.js";
import { withPluginRuntimeGenerationScope } from "../plugins/runtime/generation-scope.js";
import type { RuntimeEnv } from "../runtime.js";
import { runWithAgentCommandRecoveryOwner } from "./agent-command-recovery-owner.js";
import {
  prepareAgentCommandExecution,
  type PreparedAgentCommandExecution,
} from "./command/prepare.js";
import { resolveAgentCommandDeps } from "./command/runtime-loaders.js";
import type { AgentCommandOpts } from "./command/types.js";
import {
  createCronCreatorAuthorityCapability,
  runWithCronCreatorAuthorityCapability,
} from "./cron-creator-authority-context.js";
import { withPreparedModelRuntimePluginGenerationScope } from "./prepared-model-runtime-generation-scope.js";
import { acquireAgentRunPreparedModelRuntime } from "./prepared-model-runtime.js";
import { measureAgentStartup } from "./startup-timing.js";

type ResolvedAgentCommandDeps = Awaited<ReturnType<typeof resolveAgentCommandDeps>>;

/** Runs a local command under one request, recovery, and plugin-registry generation. */
export async function runLocalAgentCommand<TResult>(params: {
  opts: AgentCommandOpts;
  runtime: RuntimeEnv;
  deps?: CliDeps;
  /** Admit this exact local CLI run as an operator-owned turn. */
  operatorAuthority?: boolean;
  run: (
    prepared: PreparedAgentCommandExecution,
    resolvedDeps: ResolvedAgentCommandDeps,
  ) => Promise<TResult>;
}): Promise<TResult> {
  const existingHost = getBoundLegacyPluginSdkResourceHost();
  const scheduler = existingHost ? existingHost.scheduler : new GatewayScheduler();
  const host = existingHost ?? new LegacyPluginSdkResourceHost();
  if (!existingHost) {
    host.bindScheduler(scheduler);
  }
  const [outcome] = await Promise.allSettled([
    host.run(async () => {
      const resolvedDeps = await measureAgentStartup("command-dependencies", () =>
        resolveAgentCommandDeps(params.deps),
      );
      const lifecycleGeneration =
        params.opts.lifecycleGeneration ??
        captureAgentRunLifecycleGeneration(params.opts.runId ?? "");
      return await withAgentRunLifecycleGeneration(lifecycleGeneration, () =>
        withLocalGatewayRequestScope(
          { deps: resolvedDeps, getRuntimeConfig },
          async () =>
            await runWithAgentCommandRecoveryOwner({
              lifecycleGeneration,
              mode: "reject_uncoordinated",
              opts: {
                ...params.opts,
                lifecycleGeneration,
                senderIsOwner: params.opts.senderIsOwner ?? true,
                allowModelOverride: params.opts.allowModelOverride ?? true,
                // Standalone commands cannot retain transports after their idle scheduler closes.
                cleanupBundleMcpOnRunEnd: existingHost
                  ? params.opts.cleanupBundleMcpOnRunEnd
                  : true,
              },
              prepare: async (preparedOpts) =>
                await measureAgentStartup("command-prepare", () =>
                  prepareAgentCommandExecution(preparedOpts, params.runtime),
                ),
              run: async (prepared) => {
                const capability =
                  params.operatorAuthority && prepared.opts.senderIsOwner === true
                    ? createCronCreatorAuthorityCapability(prepared.runId, { kind: "local" })
                    : undefined;
                const admittedPrepared = capability
                  ? {
                      ...prepared,
                      opts: { ...prepared.opts, cronCreatorAuthorityCapability: capability },
                    }
                  : prepared;
                const run = async () => {
                  // Preparation owns registry selection and physical resources. Do not load
                  // an intermediate discovery registry just to select that same generation.
                  await using lease = await acquireAgentRunPreparedModelRuntime(
                    {
                      config: admittedPrepared.cfg,
                      agentId: admittedPrepared.sessionAgentId,
                      agentDir: admittedPrepared.agentDir,
                      workspaceDir: admittedPrepared.workspaceDir,
                    },
                    { abortSignal: admittedPrepared.opts.abortSignal },
                  );
                  const registry = lease.snapshot.pluginRegistry;
                  const invocations = registry
                    ? new PluginInvocationScope(
                        registry,
                        collectRegistryInvocationInstances(registry),
                      )
                    : undefined;
                  const execute = () =>
                    params.run(
                      {
                        ...admittedPrepared,
                        commandRuntimeContext: {
                          config: lease.snapshot.config,
                          pluginGeneration: lease.pluginGeneration,
                        },
                      },
                      resolvedDeps,
                    );
                  let active = true;
                  try {
                    return await withPluginRuntimeGenerationScope(lease.snapshot, () =>
                      withPreparedModelRuntimePluginGenerationScope(
                        lease.pluginGeneration,
                        () => (invocations ? invocations.run(execute) : execute()),
                        () => (active ? lease.snapshot : undefined),
                      ),
                    );
                  } finally {
                    active = false;
                    // A nested command can end while its parent or executable still holds
                    // physical custody. Its captured callbacks must end with this invocation.
                    invocations?.release();
                  }
                };
                return capability
                  ? await runWithCronCreatorAuthorityCapability(
                      capability,
                      run,
                      admittedPrepared.opts.abortSignal,
                    )
                  : await run();
              },
            }),
        ),
      );
    }),
  ]);
  try {
    if (!existingHost) {
      await scheduler.stop();
      await host.close();
    }
  } catch (error) {
    if (outcome.status === "rejected") {
      throw new AggregateError(
        [outcome.reason, error],
        "Local agent command and resource cleanup failed.",
        { cause: error },
      );
    }
    throw error;
  }
  if (outcome.status === "rejected") {
    throw outcome.reason;
  }
  return outcome.value;
}
