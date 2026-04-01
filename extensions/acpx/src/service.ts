import fs from "node:fs/promises";
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
  doctor?(): Promise<{
    ok: boolean;
    message: string;
    details?: string[];
  }>;
};

type AcpxRuntimeFactoryParams = {
  pluginConfig: ResolvedAcpxPluginConfig;
  queueOwnerTtlSeconds: number;
  logger?: PluginLogger;
};

type CreateAcpxRuntimeServiceParams = {
  pluginConfig?: unknown;
  runtimeFactory?: (params: AcpxRuntimeFactoryParams) => AcpxRuntimeLike;
  healthProbeRetryDelaysMs?: number[];
};

const DEFAULT_HEALTH_PROBE_RETRY_DELAYS_MS = [250, 1_000, 2_500];

function delay(ms: number): Promise<void> {
  if (ms <= 0) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function formatDoctorFailureMessage(report: { message: string; details?: string[] }): string {
  const detailText = report.details?.filter(Boolean).join("; ").trim();
  return detailText ? `${report.message} (${detailText})` : report.message;
}

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
      if (ctx.workspaceDir?.trim()) {
        await fs.mkdir(ctx.workspaceDir, { recursive: true });
      }
      const healthProbeRetryDelaysMs =
        params.healthProbeRetryDelaysMs ?? DEFAULT_HEALTH_PROBE_RETRY_DELAYS_MS;
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
          let lastFailureMessage: string | undefined;
          for (let attempt = 0; attempt <= healthProbeRetryDelaysMs.length; attempt += 1) {
            startupRuntime.setSetupError();
            await startupRuntime.probeAvailability();
            if (currentRevision !== lifecycleRevision) {
              return;
            }
            if (startupRuntime.isHealthy()) {
              startupRuntime.setSetupError();
              ctx.logger.info(
                attempt === 0
                  ? "acpx runtime backend ready"
                  : `acpx runtime backend ready after ${attempt + 1} probe attempts`,
              );
              return;
            }

            lastFailureMessage = startupRuntime.getUnhealthyReason();
            if (!lastFailureMessage) {
              const doctorReport = await startupRuntime.doctor?.();
              if (currentRevision !== lifecycleRevision) {
                return;
              }
              lastFailureMessage = doctorReport
                ? formatDoctorFailureMessage(doctorReport)
                : "acpx runtime probe failed after local install";
              startupRuntime.setSetupError(lastFailureMessage);
            }

            const retryDelayMs = healthProbeRetryDelaysMs[attempt];
            if (retryDelayMs == null) {
              break;
            }
            ctx.logger.warn(
              `acpx runtime backend probe attempt ${attempt + 1} failed: ${lastFailureMessage}; retrying in ${retryDelayMs}ms`,
            );
            await delay(retryDelayMs);
            if (currentRevision !== lifecycleRevision) {
              return;
            }
          }
          ctx.logger.warn(
            `acpx runtime backend probe failed: ${
              lastFailureMessage ??
              startupRuntime.getUnhealthyReason() ??
              "backend remained unhealthy after setup"
            }`,
          );
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
