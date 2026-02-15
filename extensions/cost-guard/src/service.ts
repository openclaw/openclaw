/**
 * Cost Guard service.
 *
 * Subscribes to diagnostic events (model.usage) via onDiagnosticEvent()
 * and records cost data into the in-memory tracker.
 * Follows the same factory pattern as diagnostics-otel.
 */

import type {
  DiagnosticEventPayload,
  OpenClawPluginApi,
  OpenClawPluginService,
} from "openclaw/plugin-sdk";
import { onDiagnosticEvent } from "openclaw/plugin-sdk";
import type { CostGuardConfig } from "./config.js";
import type { CostTracker } from "./tracker.js";

// ---------------------------------------------------------------------------
// Prune interval — clean old entries every hour.
// ---------------------------------------------------------------------------

const PRUNE_INTERVAL_MS = 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createCostGuardService(
  tracker: CostTracker,
  config: CostGuardConfig,
  logger: OpenClawPluginApi["logger"],
): OpenClawPluginService {
  let unsubscribe: (() => void) | null = null;
  let pruneTimer: ReturnType<typeof setInterval> | null = null;

  return {
    id: "cost-guard",

    async start() {
      logger.info(
        `cost-guard: started — daily budget $${config.dailyBudgetUsd}, monthly $${config.monthlyBudgetUsd}, warning at ${(config.warningThreshold * 100).toFixed(0)}%, hard stop ${config.hardStop ? "ON" : "OFF"}`,
      );

      // Subscribe to all diagnostic events and filter for model.usage.
      unsubscribe = onDiagnosticEvent((evt: DiagnosticEventPayload) => {
        if (evt.type !== "model.usage") {
          return;
        }
        if (evt.costUsd === undefined || evt.costUsd <= 0) {
          return;
        }

        tracker.record({
          provider: evt.provider ?? "unknown",
          model: evt.model ?? "unknown",
          costUsd: evt.costUsd,
          ts: evt.ts,
        });

        const status = tracker.checkBudget(config);
        if (status.level === "exceeded") {
          logger.warn(
            `cost-guard: BUDGET EXCEEDED — daily $${status.dailyUsed.toFixed(2)}/$${status.dailyLimit.toFixed(2)}` +
              (status.exceededProvider ? ` (provider: ${status.exceededProvider})` : ""),
          );
        } else if (status.level === "warning") {
          logger.warn(
            `cost-guard: budget warning — ${(status.dailyPercent * 100).toFixed(0)}% of daily limit used ($${status.dailyUsed.toFixed(2)}/$${status.dailyLimit.toFixed(2)})`,
          );
        }
      });

      // Periodic pruning to prevent unbounded memory growth.
      pruneTimer = setInterval(() => {
        tracker.pruneOldEntries();
      }, PRUNE_INTERVAL_MS);
      pruneTimer.unref();
    },

    async stop() {
      unsubscribe?.();
      unsubscribe = null;
      if (pruneTimer !== null) {
        clearInterval(pruneTimer);
        pruneTimer = null;
      }
      logger.info("cost-guard: stopped");
    },
  } satisfies OpenClawPluginService;
}
