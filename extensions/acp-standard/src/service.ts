import type {
  AcpRuntime,
  OpenClawPluginService,
  OpenClawPluginServiceContext,
} from "openclaw/plugin-sdk";
import { registerAcpRuntimeBackend, unregisterAcpRuntimeBackend } from "openclaw/plugin-sdk";
import { resolveStandardAcpConfig } from "./config.js";
import { STANDARD_ACP_BACKEND_ID, StandardAcpRuntime } from "./runtime.js";

type StandardAcpRuntimeLike = AcpRuntime & {
  probeAvailability(): Promise<void>;
  isHealthy(): boolean;
  closeAll(): void;
};

export function createStandardAcpService(params: {
  pluginConfig?: unknown;
}): OpenClawPluginService {
  let runtime: StandardAcpRuntimeLike | null = null;

  return {
    id: "acp-standard-runtime",
    async start(ctx: OpenClawPluginServiceContext): Promise<void> {
      const config = resolveStandardAcpConfig({
        rawConfig: params.pluginConfig,
        workspaceDir: ctx.workspaceDir,
      });
      runtime = new StandardAcpRuntime(config, ctx.logger);

      registerAcpRuntimeBackend({
        id: STANDARD_ACP_BACKEND_ID,
        runtime,
        healthy: () => runtime?.isHealthy() ?? false,
      });
      ctx.logger.info(
        `acp-standard backend registered (${config.command} ${config.args.join(" ")})`,
      );

      void (async () => {
        try {
          await runtime?.probeAvailability();
          if (runtime?.isHealthy()) {
            ctx.logger.info("acp-standard backend ready");
          } else {
            ctx.logger.warn("acp-standard backend probe failed");
          }
        } catch (err) {
          ctx.logger.warn(
            `acp-standard setup failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      })();
    },
    async stop(): Promise<void> {
      runtime?.closeAll();
      unregisterAcpRuntimeBackend(STANDARD_ACP_BACKEND_ID);
      runtime = null;
    },
  };
}
