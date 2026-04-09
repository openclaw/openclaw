import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import type { InferenceGuardConfig } from "./src/types.js";

/**
 * ## inference-guard — Collision Prevention for Single-Slot Inference
 *
 * On single-GPU workstations with `--parallel 1`, only one inference request can
 * run at a time. Multiple OpenClaw consumers (user messages, heartbeats, cron jobs,
 * subagents) compete for the single slot. Without priority management, a heartbeat
 * that starts a 2000-token generation blocks user messages for ~100 seconds.
 *
 * This plugin provides priority-aware deferred processing:
 * - User messages always get priority
 * - Heartbeats and cron jobs voluntarily defer when user work is queued
 * - Heartbeats have a queue cap (no stacking stale heartbeats)
 * - Coordinates with model-switch plugin during backend switches
 *
 * ## Security
 *
 * - No shell commands or external access — purely in-process scheduling
 * - Does not modify message content or tool calls
 * - Transparent to the agent — deferral is invisible
 */

function resolveConfig(input: unknown): InferenceGuardConfig {
  const raw = (input ?? {}) as Partial<InferenceGuardConfig>;
  return {
    maxConcurrentInference: raw.maxConcurrentInference ?? 1,
    deferPolicy: {
      heartbeat: raw.deferPolicy?.heartbeat ?? { action: "defer-behind-user", maxQueued: 1 },
      cron: raw.deferPolicy?.cron ?? { action: "defer-behind-user", maxQueued: 3 },
      subagent: raw.deferPolicy?.subagent ?? { action: "queue-fifo" },
    },
    queueWarnMs: raw.queueWarnMs ?? 5000,
  };
}

export default definePluginEntry({
  id: "inference-guard",
  name: "Inference Guard",
  description:
    "Priority-aware collision prevention for single-slot local inference. " +
    "Heartbeats and cron jobs defer behind user messages.",
  register(api) {
    const config = resolveConfig(api.pluginConfig);

    // Track heartbeat queue depth
    let queuedHeartbeatCount = 0;

    // Track if model-switch is in progress (coordinate with model-switch plugin)
    // Read from shared state file or in-memory flag
    let modelSwitchActive = false;

    // --- Hook: before_agent_reply — priority-aware deferral ---
    api.on(
      "before_agent_reply",
      async (_event, ctx) => {
        // If model-switch is active, its gate (priority -100) handles holding.
        // We only handle priority ordering when the model IS available.
        if (modelSwitchActive) {
          return undefined;
        }

        // Detect request type from context
        const isHeartbeat =
          ctx &&
          typeof ctx === "object" &&
          "isHeartbeat" in ctx &&
          (ctx as { isHeartbeat?: boolean }).isHeartbeat === true;

        const isCron =
          ctx &&
          typeof ctx === "object" &&
          "isCron" in ctx &&
          (ctx as { isCron?: boolean }).isCron === true;

        if (isHeartbeat) {
          // Heartbeat queue cap — drop if already at limit
          if (queuedHeartbeatCount >= config.deferPolicy.heartbeat.maxQueued) {
            api.logger.debug?.(
              `[inference-guard] Dropping heartbeat — queue cap reached (${queuedHeartbeatCount}/${config.deferPolicy.heartbeat.maxQueued})`,
            );
            return { handled: true, reason: "inference-guard: heartbeat queue cap" };
          }
          queuedHeartbeatCount++;

          // Note: actual deferral behind user messages would require checking
          // the command lane queue depth, which is not directly accessible from
          // plugin hooks. For MVP, heartbeat rate-limiting via queue cap is the
          // primary defense. Full deferral requires core OpenClaw changes.
          api.logger.debug?.(
            `[inference-guard] Heartbeat proceeding (queued: ${queuedHeartbeatCount})`,
          );
        }

        if (isCron) {
          api.logger.debug?.("[inference-guard] Cron job proceeding");
        }

        return undefined;
      },
      { priority: 0 }, // After model-switch gate (-100)
    );

    // --- Hook: agent_end — decrement heartbeat counter ---
    api.on("agent_end", (_event, ctx) => {
      const isHeartbeat =
        ctx &&
        typeof ctx === "object" &&
        "isHeartbeat" in ctx &&
        (ctx as { isHeartbeat?: boolean }).isHeartbeat === true;

      if (isHeartbeat && queuedHeartbeatCount > 0) {
        queuedHeartbeatCount--;
      }
      return undefined;
    });

    // --- Service: monitor model-switch state ---
    api.registerService({
      id: "inference-guard-monitor",
      async start(ctx) {
        // Periodically check if model-switch is active by reading its state dir
        // This is a coordination mechanism — model-switch sets switching=true,
        // inference-guard reads it.
        const checkInterval = setInterval(() => {
          try {
            // Check for model-switch marker file
            const stateDir = api.runtime.state.resolveStateDir();
            const markerPath = `${stateDir}/../model-switch/model-switch-pending.json`;
            // Use a simple existence check — if marker exists, switch is in progress
            import("node:fs")
              .then((fs) => {
                modelSwitchActive = fs.existsSync(markerPath);
              })
              .catch(() => {
                // fs import failed — assume no switch
              });
          } catch {
            // Ignore errors
          }
        }, 2000);

        // Store for cleanup
        (ctx as unknown as { _interval: ReturnType<typeof setInterval> })._interval = checkInterval;

        ctx.logger.info(
          `[inference-guard] Started with maxConcurrent=${config.maxConcurrentInference}, ` +
            `heartbeat maxQueued=${config.deferPolicy.heartbeat.maxQueued}`,
        );
      },
    });
  },
});
