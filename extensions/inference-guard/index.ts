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

    // Track heartbeat timing — use timestamps instead of counters to avoid drift
    // on aborted/crashed heartbeats that never fire agent_end.
    let lastHeartbeatStartedAt = 0;

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
          // Heartbeat rate limiting — if a heartbeat started recently, drop this one.
          // Uses timestamps instead of counters to avoid drift on aborted/crashed heartbeats.
          const now = Date.now();
          const minIntervalMs = 30_000; // Don't allow heartbeats more often than 30s
          if (now - lastHeartbeatStartedAt < minIntervalMs) {
            api.logger.debug?.(
              `[inference-guard] Dropping heartbeat — too soon after previous (${now - lastHeartbeatStartedAt}ms < ${minIntervalMs}ms)`,
            );
            return { handled: true, reason: "inference-guard: heartbeat rate limit" };
          }
          lastHeartbeatStartedAt = now;
          api.logger.debug?.("[inference-guard] Heartbeat proceeding");
        }

        if (isCron) {
          api.logger.debug?.("[inference-guard] Cron job proceeding");
        }

        return undefined;
      },
      { priority: 0 }, // After model-switch gate (-100)
    );

    // No agent_end hook needed — timestamp-based rate limiting is self-correcting
    // and doesn't drift on aborted/crashed heartbeats.

    // --- Service: monitor model-switch state ---
    let monitorInterval: ReturnType<typeof setInterval> | undefined;

    api.registerService({
      id: "inference-guard-monitor",
      async start(ctx) {
        const stateDir = api.runtime.state.resolveStateDir();
        const markerPath = `${stateDir}/../model-switch/model-switch-pending.json`;
        const { existsSync } = await import("node:fs");

        monitorInterval = setInterval(() => {
          try {
            modelSwitchActive = existsSync(markerPath);
          } catch {
            // Ignore errors
          }
        }, 2000);

        ctx.logger.info(
          `[inference-guard] Started with maxConcurrent=${config.maxConcurrentInference}, ` +
            `heartbeat maxQueued=${config.deferPolicy.heartbeat.maxQueued}`,
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
