/**
 * void-reflection · observer
 *
 * Captures lightweight metrics after every agent run via the `agent_end`
 * plugin hook. Observations are appended to the JSONL log. When the
 * in-memory counter reaches the configured threshold, the reflector
 * callback is invoked.
 */

import type { VoidStore } from "./store.js";
import type { Observation, VoidReflectionConfig } from "./types.js";

export type Observer = ReturnType<typeof createObserver>;

export function createObserver(store: VoidStore, config: VoidReflectionConfig) {
  /** Runs since the last reflection cycle (in-memory counter). */
  let runsSinceLastReflection = 0;

  /**
   * Callback set by the plugin entry point.
   * Invoked when `runsSinceLastReflection >= thresholdRuns`.
   */
  let onThresholdReached: ((workspaceDir: string) => Promise<void>) | null = null;

  /**
   * Called from the `agent_end` plugin hook.
   *
   * @param event – PluginHookAgentEndEvent
   * @param ctx   – PluginHookAgentContext
   * @param workspaceDir – resolved workspace directory
   */
  async function onAgentEnd(
    event: { messages: unknown[]; success: boolean; error?: string; durationMs?: number },
    ctx: { sessionKey?: string },
    workspaceDir: string,
  ): Promise<void> {
    try {
      // Count tool calls in the messages array
      let toolCount = 0;
      let messageCount = 0;
      if (Array.isArray(event.messages)) {
        for (const msg of event.messages) {
          const m = msg as Record<string, unknown> | null;
          if (!m) continue;
          const role = m.role as string | undefined;
          if (role === "user" || role === "assistant") {
            messageCount++;
          }
          if (role === "tool" || m.type === "tool_result" || m.tool_call_id) {
            toolCount++;
          }
        }
      }

      const observation: Observation = {
        timestamp: new Date().toISOString(),
        sessionKey: ctx.sessionKey ?? "unknown",
        success: event.success,
        error: event.error,
        durationMs: event.durationMs,
        toolCount,
        messageCount,
      };

      await store.appendObservation(workspaceDir, observation);

      // Truncate if over max
      const count = await store.countObservations(workspaceDir);
      if (count > config.maxObservations * 1.5) {
        await store.truncateObservations(workspaceDir, config.maxObservations);
      }

      // Threshold detection
      runsSinceLastReflection++;
      if (runsSinceLastReflection >= config.thresholdRuns && onThresholdReached) {
        runsSinceLastReflection = 0;
        // Fire-and-forget — do not block the agent response
        onThresholdReached(workspaceDir).catch((err) => {
          console.warn(
            "[void-reflection] Threshold reflection failed:",
            err instanceof Error ? err.message : String(err),
          );
        });
      }
    } catch (err) {
      console.warn(
        "[void-reflection] observer.onAgentEnd error:",
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  /** Reset the in-memory counter (called after a successful reflection). */
  function resetCounter(): void {
    runsSinceLastReflection = 0;
  }

  return {
    onAgentEnd,
    resetCounter,
    /** Allow the plugin entry to wire the threshold callback. */
    set onThresholdReached(fn: ((workspaceDir: string) => Promise<void>) | null) {
      onThresholdReached = fn;
    },
  };
}
