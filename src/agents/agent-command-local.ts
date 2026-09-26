/** Owns local agent-command admission scopes outside a running Gateway. */
import { normalizeChatChannelId } from "../channels/ids.js";
import type { CliDeps } from "../cli/deps.types.js";
import { getRuntimeConfig } from "../config/io.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { withLocalGatewayRequestScope } from "../gateway/local-request-context.js";
import {
  captureAgentRunLifecycleGeneration,
  withAgentRunLifecycleGeneration,
} from "../infra/agent-events.js";
import { withPluginRuntimeGenerationScope } from "../plugins/runtime/generation-scope.js";
import { normalizeAgentId } from "../routing/session-key.js";
import type { RuntimeEnv } from "../runtime.js";
import { resolveUserPath } from "../utils.js";
import { resolveMessageChannel } from "../utils/message-channel.js";
import { runWithAgentCommandRecoveryOwner } from "./agent-command-recovery-owner.js";
import { listAgentIds, resolveAgentWorkspaceDir } from "./agent-scope.js";
import {
  isAgentCommandExplicitRecipientCandidate,
  prepareAgentCommandExecution,
  resolveAgentCommandPreparationConfig,
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
import { withLocalAgentPluginRegistry } from "./runtime-plugins.js";
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
  const resolvedDeps = await measureAgentStartup("command-dependencies", () =>
    resolveAgentCommandDeps(params.deps),
  );
  const lifecycleGeneration =
    params.opts.lifecycleGeneration ?? captureAgentRunLifecycleGeneration(params.opts.runId ?? "");
  return await withAgentRunLifecycleGeneration(lifecycleGeneration, () =>
    withLocalGatewayRequestScope({ deps: resolvedDeps, getRuntimeConfig }, async () => {
      const execute = (preparedConfig?: OpenClawConfig) =>
        runWithAgentCommandRecoveryOwner({
          lifecycleGeneration,
          mode: "reject_uncoordinated",
          opts: {
            ...params.opts,
            lifecycleGeneration,
            senderIsOwner: params.opts.senderIsOwner ?? true,
            allowModelOverride: params.opts.allowModelOverride ?? true,
          },
          prepare: async (preparedOpts) =>
            await measureAgentStartup("command-prepare", () =>
              prepareAgentCommandExecution(preparedOpts, params.runtime, undefined, preparedConfig),
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
            const run = () =>
              withLocalAgentPluginRegistry({
                config: admittedPrepared.cfg,
                workspaceDir: admittedPrepared.workspaceDir,
                run: async () => {
                  await using lease = await acquireAgentRunPreparedModelRuntime(
                    {
                      config: admittedPrepared.cfg,
                      agentId: admittedPrepared.sessionAgentId,
                      agentDir: admittedPrepared.agentDir,
                      workspaceDir: admittedPrepared.workspaceDir,
                    },
                    { abortSignal: admittedPrepared.opts.abortSignal },
                  );
                  let active = true;
                  try {
                    return await withPluginRuntimeGenerationScope(lease.snapshot, () =>
                      withPreparedModelRuntimePluginGenerationScope(
                        lease.pluginGeneration,
                        () =>
                          params.run(
                            {
                              ...admittedPrepared,
                              commandRuntimeContext: {
                                config: lease.snapshot.config,
                                pluginGeneration: lease.pluginGeneration,
                              },
                            },
                            resolvedDeps,
                          ),
                        () => (active ? lease.snapshot : undefined),
                      ),
                    );
                  } finally {
                    active = false;
                  }
                },
              });
            return capability
              ? await runWithCronCreatorAuthorityCapability(
                  capability,
                  run,
                  admittedPrepared.opts.abortSignal,
                )
              : await run();
          },
        });

      if (!isAgentCommandExplicitRecipientCandidate(params.opts)) {
        return await execute();
      }
      // The recipient plugin must be in scope before prepare selects a session.
      // Resolve config and the named agent's workspace once; the same local
      // lifetime then serves route hooks, model admission, and the run.
      const cfg = await resolveAgentCommandPreparationConfig(params.opts, params.runtime, {
        beforeLocalRegistry: true,
      });
      const agentId = normalizeAgentId(params.opts.agentId!.trim());
      if (!listAgentIds(cfg).includes(agentId)) {
        return await execute(cfg); // Preserve prepare's authoritative invalid-agent error.
      }
      const workspaceDir = resolveUserPath(
        params.opts.workspaceDir?.trim() || resolveAgentWorkspaceDir(cfg, agentId),
      );
      // Only built-in ids can be known without a local runtime registry. An
      // unrelated process registry is not authority to resolve an external channel.
      const initiallyScopedChannel = normalizeChatChannelId(params.opts.channel);
      return await withLocalAgentPluginRegistry({
        config: cfg,
        workspaceDir,
        run: async (registry) => {
          const selectedChannel = resolveMessageChannel(params.opts.channel);
          // Channel aliases are owned by the runtime plugin, not its manifest.
          // Only this root's registered owner may select extra channel secrets;
          // ambient registrations cannot authorize a different local request.
          const selectedCfg =
            selectedChannel &&
            registry.channels.some(({ plugin }) => plugin.id === selectedChannel) &&
            selectedChannel !== initiallyScopedChannel &&
            cfg.channels?.[selectedChannel]
              ? await resolveAgentCommandPreparationConfig(params.opts, params.runtime)
              : cfg;
          if (selectedCfg !== cfg) {
            return await withLocalAgentPluginRegistry({
              config: selectedCfg,
              workspaceDir,
              run: async () => await execute(selectedCfg),
            });
          }
          return await execute(cfg);
        },
      });
    }),
  );
}
