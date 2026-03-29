import type {
  AcpRuntime,
  OpenClawPluginService,
  OpenClawPluginServiceContext,
  PluginLogger,
} from "../runtime-api.js";
import { registerAcpRuntimeBackend, unregisterAcpRuntimeBackend } from "../runtime-api.js";
import { resolveAcpxPluginConfig, type ResolvedAcpxPluginConfig } from "./config.js";
import { ensureAcpx } from "./ensure.js";
import { ACPX_BACKEND_ID, AcpxRuntime } from "./runtime.js";

type AcpxRuntimeLike = AcpRuntime & {
  probeAvailability(): Promise<void>;
  isHealthy(): boolean;
  setSetupError(message?: string): void;
  getUnhealthyReason(): string | undefined;
};

type AcpxRuntimeFactoryParams = {
  pluginConfig: ResolvedAcpxPluginConfig;
  queueOwnerTtlSeconds: number;
  logger?: PluginLogger;
};

type CreateAcpxRuntimeServiceParams = {
  pluginConfig?: unknown;
  runtimeFactory?: (params: AcpxRuntimeFactoryParams) => AcpxRuntimeLike;
};

function createDefaultRuntime(params: AcpxRuntimeFactoryParams): AcpxRuntimeLike {
  return new AcpxRuntime(params.pluginConfig, {
    logger: params.logger,
    queueOwnerTtlSeconds: params.queueOwnerTtlSeconds,
  });
}

export function createAcpxRuntimeService(
  params: CreateAcpxRuntimeServiceParams = {},
): OpenClawPluginService {
  let runtime: AcpxRuntimeLike | null = null;
  let lifecycleRevision = 0;

  return {
    id: "acpx-runtime",
    async start(ctx: OpenClawPluginServiceContext): Promise<void> {
      const pluginConfig = resolveAcpxPluginConfig({
        rawConfig: params.pluginConfig,
        workspaceDir: ctx.workspaceDir,
      });
      const runtimeFactory = params.runtimeFactory ?? createDefaultRuntime;
      runtime = runtimeFactory({
        pluginConfig,
        queueOwnerTtlSeconds: pluginConfig.queueOwnerTtlSeconds,
        logger: ctx.logger,
      });
      const startupRuntime = runtime;
      startupRuntime.setSetupError();

      registerAcpRuntimeBackend({
        id: ACPX_BACKEND_ID,
        runtime,
        healthy: () => runtime?.isHealthy() ?? false,
        unhealthyReason: () => runtime?.getUnhealthyReason(),
      });
      const expectedVersionLabel = pluginConfig.expectedVersion ?? "any";
      const installLabel = pluginConfig.allowPluginLocalInstall ? "enabled" : "disabled";
      ctx.logger.info(
        `acpx runtime backend registered (command: ${pluginConfig.command}, expectedVersion: ${expectedVersionLabel}, pluginLocalInstall: ${installLabel})`,
      );

      lifecycleRevision += 1;
      const currentRevision = lifecycleRevision;
      void (async () => {
        try {
          await ensureAcpx({
            command: pluginConfig.command,
            logger: ctx.logger,
            expectedVersion: pluginConfig.expectedVersion,
            allowInstall: pluginConfig.allowPluginLocalInstall,
            stripProviderAuthEnvVars: pluginConfig.stripProviderAuthEnvVars,
            spawnOptions: {
              strictWindowsCmdWrapper: pluginConfig.strictWindowsCmdWrapper,
            },
          });
          if (currentRevision !== lifecycleRevision) {
            return;
          }
          await startupRuntime.probeAvailability();
          if (currentRevision !== lifecycleRevision) {
            return;
          }
          if (startupRuntime.isHealthy()) {
            startupRuntime.setSetupError();
            ctx.logger.info("acpx runtime backend ready");
          } else {
            if (!startupRuntime.getUnhealthyReason()) {
              startupRuntime.setSetupError("acpx runtime probe failed after local install");
            }
            ctx.logger.warn("acpx runtime backend probe failed after local install");
          }
        } catch (err) {
          if (currentRevision !== lifecycleRevision) {
            return;
          }
          startupRuntime.setSetupError(err instanceof Error ? err.message : String(err));
          ctx.logger.warn(
            `acpx runtime setup failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      })();
    },
    async stop(_ctx: OpenClawPluginServiceContext): Promise<void> {
      lifecycleRevision += 1;
      unregisterAcpRuntimeBackend(ACPX_BACKEND_ID);
      runtime = null;
    },
  };
}
