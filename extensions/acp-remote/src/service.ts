import type {
  AcpRuntime,
  OpenClawPluginService,
  OpenClawPluginServiceContext,
  PluginLogger,
} from "openclaw/plugin-sdk/acp";
import { registerAcpRuntimeBackend, unregisterAcpRuntimeBackend } from "openclaw/plugin-sdk/acp";
import { resolveAcpRemotePluginConfig, type ResolvedAcpRemotePluginConfig } from "./config.js";
import { ACP_REMOTE_BACKEND_ID, AcpRemoteRuntime } from "./runtime.js";

type AcpRemoteRuntimeLike = AcpRuntime & {
  probeAvailability(): Promise<void>;
  isHealthy(): boolean;
};

type AcpRemoteRuntimeFactoryParams = {
  pluginConfig: ResolvedAcpRemotePluginConfig;
  logger?: PluginLogger;
};

type CreateAcpRemoteRuntimeServiceParams = {
  pluginConfig?: unknown;
  runtimeFactory?: (params: AcpRemoteRuntimeFactoryParams) => AcpRemoteRuntimeLike;
};

function createDefaultRuntime(params: AcpRemoteRuntimeFactoryParams): AcpRemoteRuntimeLike {
  return new AcpRemoteRuntime(params.pluginConfig, {
    logger: params.logger,
  });
}

export function createAcpRemoteRuntimeService(
  params: CreateAcpRemoteRuntimeServiceParams = {},
): OpenClawPluginService {
  let runtime: AcpRemoteRuntimeLike | null = null;
  let lifecycleRevision = 0;

  return {
    id: "acp-remote-runtime",
    async start(ctx: OpenClawPluginServiceContext): Promise<void> {
      const pluginConfig = resolveAcpRemotePluginConfig({
        rawConfig: params.pluginConfig,
      });
      const runtimeFactory = params.runtimeFactory ?? createDefaultRuntime;
      runtime = runtimeFactory({
        pluginConfig,
        logger: ctx.logger,
      });

      registerAcpRuntimeBackend({
        id: ACP_REMOTE_BACKEND_ID,
        runtime,
        healthy: () => runtime?.isHealthy() ?? false,
      });
      ctx.logger.info(`acp-remote runtime backend registered (url: ${pluginConfig.url})`);

      lifecycleRevision += 1;
      const currentRevision = lifecycleRevision;
      void (async () => {
        try {
          await runtime?.probeAvailability();
          if (currentRevision !== lifecycleRevision) {
            return;
          }
          if (runtime?.isHealthy()) {
            ctx.logger.info("acp-remote runtime backend ready");
          } else {
            ctx.logger.warn("acp-remote runtime backend probe failed");
          }
        } catch (error) {
          if (currentRevision !== lifecycleRevision) {
            return;
          }
          ctx.logger.warn(
            `acp-remote runtime setup failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      })();
    },
    async stop(_ctx: OpenClawPluginServiceContext): Promise<void> {
      lifecycleRevision += 1;
      unregisterAcpRuntimeBackend(ACP_REMOTE_BACKEND_ID);
      runtime = null;
    },
  };
}
