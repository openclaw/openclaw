import type {
  AcpRuntime,
  OpenClawPluginService,
  OpenClawPluginServiceContext,
} from "openclaw/plugin-sdk/acpx";
import { registerAcpRuntimeBackend, unregisterAcpRuntimeBackend } from "openclaw/plugin-sdk/acpx";
import { loadAgentCoreConfig, type AgentCoreConfigSource } from "./config.js";
import { AGENTCORE_BACKEND_ID, AgentCoreRuntime } from "./runtime.js";
import type { AgentCoreRuntimeConfig } from "./types.js";

type AgentCoreRuntimeLike = AcpRuntime & {
  isHealthy(): boolean;
  setHealthy(value: boolean): void;
  doctor(): Promise<{ ok: boolean; message: string }>;
};

// Singleton: the loaded config is stored here so the memory plugin can access it.
let _loadedConfig: AgentCoreRuntimeConfig | null = null;

/** Returns the AgentCore config loaded at startup, or null if not yet started. */
export function getAgentCoreConfig(): AgentCoreRuntimeConfig | null {
  return _loadedConfig;
}

export type CreateAgentCoreServiceParams = {
  configSource: AgentCoreConfigSource;
};

/**
 * OpenClaw plugin service that registers the AgentCore ACP backend.
 *
 * Usage in gateway startup:
 *   const service = createAgentCoreRuntimeService({
 *     configSource: {
 *       ssmPrefix: `/hyperion/${stage}/agentcore`,
 *       region: "us-west-2",
 *     },
 *   });
 *   await service.start(ctx);
 *
 * This registers "agentcore" as an ACP runtime backend. When OC dispatches
 * a message via ACP (e.g. from external channel webhooks), it flows through
 * AgentCoreRuntime.runTurn() which invokes Bedrock AgentCore.
 */
export function createAgentCoreRuntimeService(
  params: CreateAgentCoreServiceParams,
): OpenClawPluginService {
  let runtime: AgentCoreRuntimeLike | null = null;

  return {
    id: "agentcore-runtime",

    async start(ctx: OpenClawPluginServiceContext): Promise<void> {
      const config = await loadAgentCoreConfig(params.configSource);

      if (config.runtimeArns.length === 0) {
        ctx.logger.warn(
          "AgentCore runtime backend has no runtime ARNs configured. " +
            "Backend will be registered but unhealthy until SSM parameter is populated.",
        );
      }

      runtime = new AgentCoreRuntime(config);
      _loadedConfig = config;

      registerAcpRuntimeBackend({
        id: AGENTCORE_BACKEND_ID,
        runtime,
        healthy: () => runtime?.isHealthy() ?? false,
      });

      ctx.logger.info(
        `AgentCore runtime backend registered (region: ${config.region}, ` +
          `runtimes: ${config.runtimeArns.length}, model: ${config.defaultModel})`,
      );

      // Probe health in background
      void (async () => {
        try {
          const report = await runtime?.doctor();
          if (report?.ok) {
            runtime?.setHealthy(true);
            ctx.logger.info("AgentCore runtime backend ready");
          } else {
            ctx.logger.warn(`AgentCore runtime backend probe failed: ${report?.message}`);
          }
        } catch (err) {
          ctx.logger.warn(
            `AgentCore runtime health check failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      })();
    },

    async stop(_ctx: OpenClawPluginServiceContext): Promise<void> {
      unregisterAcpRuntimeBackend(AGENTCORE_BACKEND_ID);
      runtime = null;
      _loadedConfig = null;
    },
  };
}
