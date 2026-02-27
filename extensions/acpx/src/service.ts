import type {
  AcpRuntime,
  OpenClawPluginService,
  OpenClawPluginServiceContext,
  PluginLogger,
} from "openclaw/plugin-sdk";
import { registerAcpRuntimeBackend, unregisterAcpRuntimeBackend } from "openclaw/plugin-sdk";
import {
  ACPX_PINNED_VERSION,
  resolveAcpxPluginConfig,
  type ResolvedAcpxPluginConfig,
} from "./config.js";
import { ensurePinnedAcpx } from "./ensure.js";
import { ACPX_BACKEND_ID, AcpxRuntime } from "./runtime.js";

type AcpxRuntimeLike = AcpRuntime & {
  probeAvailability(): Promise<void>;
  isHealthy(): boolean;
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

      registerAcpRuntimeBackend({
        id: ACPX_BACKEND_ID,
        runtime,
        healthy: () => runtime?.isHealthy() ?? false,
      });
      ctx.logger.info(
        `acpx runtime backend registered (command: ${pluginConfig.command}, pinned: ${ACPX_PINNED_VERSION})`,
      );

      lifecycleRevision += 1;
      const currentRevision = lifecycleRevision;
      void (async () => {
        try {
          await ensurePinnedAcpx({
            command: pluginConfig.command,
            logger: ctx.logger,
            expectedVersion: ACPX_PINNED_VERSION,
          });
          if (currentRevision !== lifecycleRevision) {
            return;
          }
          await runtime?.probeAvailability();
          if (runtime?.isHealthy()) {
            ctx.logger.info("acpx runtime backend ready");
          } else {
            ctx.logger.warn("acpx runtime backend probe failed after local install");
          }
        } catch (err) {
          if (currentRevision !== lifecycleRevision) {
            return;
          }
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
