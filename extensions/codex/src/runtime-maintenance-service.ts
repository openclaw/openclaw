import { coerceErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import type { HealthRepairContext } from "openclaw/plugin-sdk/health";
import type {
  OpenClawPluginServiceV2,
  OpenClawPluginServiceContextV2,
  PluginServiceSchedulerV1,
} from "openclaw/plugin-sdk/plugin-entry";

const MAINTENANCE_INTERVAL_MS = 24 * 60 * 60_000;

/** The plugin service lifetime owns automatic invocation of the manual maintenance path. */
export function createCodexRuntimeMaintenanceService(params: {
  pluginRoot?: string;
  getConfig: () => OpenClawPluginServiceContextV2["config"];
}): OpenClawPluginServiceV2 & { getScheduler: () => PluginServiceSchedulerV1 | undefined } {
  let context: OpenClawPluginServiceContextV2 | undefined;
  return {
    apiVersion: 2,
    id: "codex-runtime-maintenance",
    getScheduler: () => context?.scheduler,
    start(ctx) {
      context = ctx;
      let failures = 0;
      const schedule = (delayMs: number) =>
        ctx.scheduler.schedule({
          id: "stable-runtime-update",
          delayMs,
          run: async () => {
            const cfg = params.getConfig();
            const assertCurrent = () => {
              ctx.scheduler.signal.throwIfAborted();
              if (context !== ctx || params.getConfig() !== cfg) {
                throw new Error("Codex maintenance service retired.");
              }
            };
            try {
              assertCurrent();
              // The env facade also exports networking runtime; keep it out of registration.
              const { isTruthyEnvValue } = await import("openclaw/plugin-sdk/runtime-env");
              assertCurrent();
              // Match the host's explicit non-updating/rehearsal environments.
              if (
                isTruthyEnvValue(process.env.OPENCLAW_NO_AUTO_UPDATE) ||
                process.env.OPENCLAW_NIX_MODE === "1"
              ) {
                return;
              }
              if (!params.pluginRoot) {
                throw new Error(
                  "Codex maintenance needs the installed plugin root; reload the Codex plugin.",
                );
              }
              const { createCodexRuntimeMaintenanceChecks } =
                await import("./runtime-maintenance.js");
              assertCurrent();
              const checks = createCodexRuntimeMaintenanceChecks({
                operation: "update",
                pluginRoot: params.pluginRoot,
                signal: ctx.scheduler.signal,
                assertCurrent,
              });
              const healthContext: HealthRepairContext = {
                mode: "fix",
                cfg,
                env: process.env,
                runtime: {
                  log: (...args) => ctx.logger.info(args.map(String).join(" ")),
                  error: (...args) => ctx.logger.error(args.map(String).join(" ")),
                  exit: (code) => {
                    throw new Error(`Unexpected maintenance exit ${code}`);
                  },
                },
              };
              for (const check of checks) {
                const findings = await check.detect(healthContext);
                assertCurrent();
                if (findings.length && check.repair) {
                  const result = await check.repair(healthContext, findings);
                  assertCurrent();
                  // Selection may have committed before a cleanup warning. Report
                  // those facts even when maintenance still needs a retry.
                  for (const change of result.changes) {
                    ctx.logger.info(change);
                  }
                  if (result.status === "failed") {
                    throw new Error(result.warnings?.join("; ") || "Codex maintenance failed.");
                  }
                }
              }
              failures = 0;
              ctx.serviceHealth?.clearFailure();
            } catch (error) {
              if (ctx.scheduler.signal.aborted || context !== ctx) {
                return;
              }
              failures++;
              ctx.serviceHealth?.reportFailure(error);
              ctx.logger.warn(
                `Automatic Codex runtime maintenance needs attention: ${coerceErrorMessage(error)}`,
              );
            }
            if (context === ctx && !ctx.scheduler.signal.aborted) {
              schedule(
                failures
                  ? Math.min(MAINTENANCE_INTERVAL_MS, 30 * 60_000 * 2 ** Math.min(failures - 1, 6))
                  : MAINTENANCE_INTERVAL_MS,
              );
            }
          },
        });
      schedule(60_000);
    },
    async stop() {
      const retiring = context;
      context = undefined;
      retiring?.scheduler.beginClose();
      await retiring?.scheduler.stop();
    },
  };
}
