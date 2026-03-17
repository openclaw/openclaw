import { registerAcpRuntimeBackend, unregisterAcpRuntimeBackend } from "openclaw/plugin-sdk/acpx";
import { resolveAcpxPluginConfig } from "./config.js";
import { ensureAcpx } from "./ensure.js";
import { ACPX_BACKEND_ID, AcpxRuntime } from "./runtime.js";
function createDefaultRuntime(params) {
  return new AcpxRuntime(params.pluginConfig, {
    logger: params.logger,
    queueOwnerTtlSeconds: params.queueOwnerTtlSeconds
  });
}
function createAcpxRuntimeService(params = {}) {
  let runtime = null;
  let lifecycleRevision = 0;
  return {
    id: "acpx-runtime",
    async start(ctx) {
      const pluginConfig = resolveAcpxPluginConfig({
        rawConfig: params.pluginConfig,
        workspaceDir: ctx.workspaceDir
      });
      const runtimeFactory = params.runtimeFactory ?? createDefaultRuntime;
      runtime = runtimeFactory({
        pluginConfig,
        queueOwnerTtlSeconds: pluginConfig.queueOwnerTtlSeconds,
        logger: ctx.logger
      });
      registerAcpRuntimeBackend({
        id: ACPX_BACKEND_ID,
        runtime,
        healthy: () => runtime?.isHealthy() ?? false
      });
      const expectedVersionLabel = pluginConfig.expectedVersion ?? "any";
      const installLabel = pluginConfig.allowPluginLocalInstall ? "enabled" : "disabled";
      ctx.logger.info(
        `acpx runtime backend registered (command: ${pluginConfig.command}, expectedVersion: ${expectedVersionLabel}, pluginLocalInstall: ${installLabel})`
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
              strictWindowsCmdWrapper: pluginConfig.strictWindowsCmdWrapper
            }
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
            `acpx runtime setup failed: ${err instanceof Error ? err.message : String(err)}`
          );
        }
      })();
    },
    async stop(_ctx) {
      lifecycleRevision += 1;
      unregisterAcpRuntimeBackend(ACPX_BACKEND_ID);
      runtime = null;
    }
  };
}
export {
  createAcpxRuntimeService
};
