import type {
  AcpRuntime,
  OpenClawPluginService,
  OpenClawPluginServiceContext,
  PluginLogger,
} from "openclaw/plugin-sdk/acpx";
import { registerAcpRuntimeBackend, unregisterAcpRuntimeBackend } from "openclaw/plugin-sdk/acpx";
import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import { clearActiveCodexController, setActiveCodexController } from "./active.js";
import { CODEX_SDK_BACKEND_ID, resolveCodexSdkPluginConfig } from "./config.js";
import { createCodexNativeController, type CodexNativeController } from "./controller.js";

type CodexSdkRuntimeLike = AcpRuntime & {
  probeAvailability(): Promise<void>;
  isHealthy(): boolean;
};

type CodexSdkRuntimeFactoryParams = {
  pluginConfig: ReturnType<typeof resolveCodexSdkPluginConfig>;
  logger?: PluginLogger;
};

type CreateCodexSdkRuntimeServiceParams = {
  pluginConfig?: unknown;
  runtimeFactory?: (params: CodexSdkRuntimeFactoryParams) => CodexSdkRuntimeLike;
};

export function createCodexSdkRuntimeService(
  params: CreateCodexSdkRuntimeServiceParams = {},
): OpenClawPluginService {
  let runtime: CodexSdkRuntimeLike | null = null;
  let controller: CodexNativeController | null = null;
  let lifecycleRevision = 0;

  return {
    id: "codex-sdk-runtime",
    async start(ctx: OpenClawPluginServiceContext): Promise<void> {
      const pluginConfig = resolveCodexSdkPluginConfig({
        rawConfig: params.pluginConfig,
        workspaceDir: ctx.workspaceDir,
      });
      if (params.runtimeFactory) {
        runtime = params.runtimeFactory({
          pluginConfig,
          logger: ctx.logger,
        });
      } else {
        controller = createCodexNativeController({
          config: pluginConfig,
          stateDir: ctx.stateDir,
          logger: ctx.logger,
          gatewayUrl: pluginConfig.backchannel.gatewayUrl ?? resolveLocalGatewayUrl(ctx.config),
        });
        setActiveCodexController(controller);
        runtime = controller.runtime;
      }
      registerAcpRuntimeBackend({
        id: CODEX_SDK_BACKEND_ID,
        runtime,
        healthy: () => runtime?.isHealthy() ?? false,
      });
      ctx.logger.info(
        `codex-sdk runtime backend registered (sandbox: ${pluginConfig.sandboxMode}, agents: ${pluginConfig.allowedAgents.join(",")})`,
      );

      lifecycleRevision += 1;
      const currentRevision = lifecycleRevision;
      void (async () => {
        try {
          await runtime?.probeAvailability();
          if (currentRevision !== lifecycleRevision) {
            return;
          }
          ctx.logger.info("codex-sdk runtime backend ready");
        } catch (err) {
          if (currentRevision !== lifecycleRevision) {
            return;
          }
          ctx.logger.warn(
            `codex-sdk runtime setup failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      })();
    },
    async stop(_ctx: OpenClawPluginServiceContext): Promise<void> {
      lifecycleRevision += 1;
      unregisterAcpRuntimeBackend(CODEX_SDK_BACKEND_ID);
      clearActiveCodexController(controller ?? undefined);
      runtime = null;
      controller = null;
    },
  };
}

function resolveLocalGatewayUrl(config: OpenClawConfig): string {
  const port =
    typeof config.gateway?.port === "number" && Number.isFinite(config.gateway.port)
      ? config.gateway.port
      : 18789;
  const scheme = config.gateway?.tls?.enabled === true ? "wss" : "ws";
  return `${scheme}://127.0.0.1:${port}`;
}
