import path from "node:path";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

/**
 * ## inference-guard — Collision Prevention for Single-Slot Inference
 *
 * On single-GPU workstations with `--parallel 1`, only one inference request can
 * run at a time. Multiple OpenClaw consumers (user messages, heartbeats, cron jobs)
 * compete for the single slot. Without management, a heartbeat generating 2000
 * tokens blocks user messages for ~100 seconds.
 *
 * This plugin provides:
 * - Heartbeat rate limiting (timestamp-based, immune to drift on aborted runs)
 * - Model-switch coordination (defers to model-switch gate during switches)
 *
 * ## Security
 *
 * - No shell commands or external access — purely in-process scheduling
 * - Does not modify message content or tool calls
 * - Transparent to the agent — deferral is invisible
 */

type InferenceGuardConfig = {
  /** Minimum interval between heartbeat runs in ms. Default: 30000. */
  heartbeatMinIntervalMs: number;
};

function resolveConfig(input: unknown): InferenceGuardConfig {
  const raw = (input ?? {}) as Partial<InferenceGuardConfig>;
  return {
    heartbeatMinIntervalMs: raw.heartbeatMinIntervalMs ?? 30_000,
  };
}

export default definePluginEntry({
  id: "inference-guard",
  name: "Inference Guard",
  description:
    "Collision prevention for single-slot local inference. " +
    "Rate-limits heartbeats and coordinates with model-switch.",
  register(api) {
    const config = resolveConfig(api.pluginConfig);

    // Track heartbeat timing — timestamps are immune to drift on aborted/crashed runs.
    let lastHeartbeatStartedAt = 0;

    // Track if model-switch is in progress
    let modelSwitchActive = false;

    // --- Hook: before_agent_reply — heartbeat rate limiting ---
    api.on(
      "before_agent_reply",
      async (_event, ctx) => {
        // If model-switch is active, its gate (priority -100) handles holding.
        if (modelSwitchActive) {
          return undefined;
        }

        // Use ctx.trigger to detect request type (not isHeartbeat/isCron which don't exist)
        const trigger = ctx?.trigger;

        if (trigger === "heartbeat") {
          const now = Date.now();
          if (now - lastHeartbeatStartedAt < config.heartbeatMinIntervalMs) {
            api.logger.debug?.(
              `[inference-guard] Dropping heartbeat — too soon (${now - lastHeartbeatStartedAt}ms < ${config.heartbeatMinIntervalMs}ms)`,
            );
            return { handled: true, reason: "inference-guard: heartbeat rate limit" };
          }
          lastHeartbeatStartedAt = now;
          api.logger.debug?.("[inference-guard] Heartbeat proceeding");
        }

        return undefined;
      },
      { priority: 0 }, // After model-switch gate (-100)
    );

    // --- Service: monitor model-switch state ---
    let monitorInterval: ReturnType<typeof setInterval> | undefined;

    api.registerService({
      id: "inference-guard-monitor",
      async start(ctx) {
        const stateDir = api.runtime.state.resolveStateDir();
        const markerPath = path.join(
          path.dirname(stateDir),
          "model-switch",
          "model-switch-pending.json",
        );
        const { existsSync } = await import("node:fs");

        monitorInterval = setInterval(() => {
          try {
            modelSwitchActive = existsSync(markerPath);
          } catch {
            // Ignore errors
          }
        }, 2000);

        ctx.logger.info(
          `[inference-guard] Started (heartbeat min interval: ${config.heartbeatMinIntervalMs}ms)`,
        );
      },
      stop() {
        if (monitorInterval) {
          clearInterval(monitorInterval);
          monitorInterval = undefined;
        }
      },
    });
  },
});
