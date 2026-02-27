/**
 * Loop 1: Build It Now
 *
 * When telemetry detects 3 failures on the same tool+failure_mode pattern
 * in a single session, the agent gets a 5-minute time-box to build a
 * purpose-specific tool. No backlog. No OPPORTUNITIES.md. Build or move on.
 *
 * Trigger is DETERMINISTIC (telemetry counts), not LLM-judged.
 */
import type { BotPluginApi } from "bot/plugin-sdk";
import { recordInvocation, getAggregateStats, type ToolInvocation } from "./telemetry.js";

interface FrictionPattern {
  tool_id: string;
  failure_mode: string;
  count: number;
  examples: string[];
}

interface FrictionDetectorState {
  /** Track failure patterns: key = `${tool_id}:${failure_mode}` */
  patterns: Map<string, FrictionPattern>;
  /** How many Build It Now cycles have fired this session (max 2) */
  buildCycles: number;
  /** Currently in a build cycle? */
  building: boolean;
}

const FRICTION_THRESHOLD = 3;
const MAX_BUILD_CYCLES_PER_SESSION = 2;

export function createFrictionDetector(api: BotPluginApi) {
  const state: FrictionDetectorState = {
    patterns: new Map(),
    buildCycles: 0,
    building: false,
  };

  return {
    /**
     * Hook: after_tool_call
     * Records every tool call and checks for friction patterns.
     */
    onToolCall: async (event: any, _ctx: any) => {
      const toolName = event.toolName ?? event.name ?? "unknown";
      const success = !event.error;
      const durationMs = event.durationMs ?? 0;

      // Record to telemetry pipeline (Loop 0)
      recordInvocation({
        tool_id: toolName,
        session_id: "current",
        agent_id: "default",
        timestamp_ms: Date.now(),
        duration_ms: durationMs,
        success,
        failure_mode: event.error
          ? (categorizeFailure(event.error) as ToolInvocation["failure_mode"])
          : undefined,
        retries: 0,
        user_corrected: false,
        context: { channel: "agent" },
      });

      // Only track failures
      if (success) return;

      const failureMode = categorizeFailure(event.error);
      const key = `${toolName}:${failureMode}`;

      let pattern = state.patterns.get(key);
      if (!pattern) {
        pattern = { tool_id: toolName, failure_mode: failureMode, count: 0, examples: [] };
        state.patterns.set(key, pattern);
      }
      pattern.count++;

      // Keep last 3 error messages as examples for the builder
      if (pattern.examples.length < 3) {
        const msg =
          typeof event.error === "string"
            ? event.error.slice(0, 200)
            : JSON.stringify(event.error).slice(0, 200);
        pattern.examples.push(msg);
      }

      // Check friction threshold
      if (
        pattern.count >= FRICTION_THRESHOLD &&
        state.buildCycles < MAX_BUILD_CYCLES_PER_SESSION &&
        !state.building
      ) {
        state.building = true;
        state.buildCycles++;

        api.logger.info(
          `[Loop 1] Friction detected: ${toolName} failed ${pattern.count}x with ${failureMode}. ` +
            `Build cycle ${state.buildCycles}/${MAX_BUILD_CYCLES_PER_SESSION}.`,
        );

        // Emit a diagnostic event that the agent can see
        // The agent's system prompt includes self-improvement context,
        // so it will see the friction event and can act on it.
        // We DON'T try to build the tool ourselves -- that's the agent's job.
        // We just surface the data.

        // Reset after triggering
        pattern.count = 0;
        pattern.examples = [];

        // 5-minute cooldown before allowing another build
        setTimeout(
          () => {
            state.building = false;
          },
          5 * 60 * 1000,
        );
      }
    },

    /** Get current session stats for injection into agent context. */
    getSessionStats() {
      return {
        ...getAggregateStats(),
        frictionPatterns: Array.from(state.patterns.values()).filter((p) => p.count >= 2),
        buildCyclesUsed: state.buildCycles,
        buildCyclesRemaining: MAX_BUILD_CYCLES_PER_SESSION - state.buildCycles,
      };
    },

    /** Get friction patterns above threshold for maintenance proposals. */
    getFrictionPatterns() {
      return Array.from(state.patterns.values());
    },
  };
}

function categorizeFailure(error: unknown): string {
  const msg = typeof error === "string" ? error : String(error);
  const lower = msg.toLowerCase();

  if (lower.includes("timeout") || lower.includes("timed out")) return "timeout";
  if (lower.includes("auth") || lower.includes("unauthorized") || lower.includes("403"))
    return "auth";
  if (lower.includes("not found") || lower.includes("enoent") || lower.includes("404"))
    return "not_found";
  if (lower.includes("permission") || lower.includes("eacces")) return "permission";
  if (lower.includes("parse") || lower.includes("syntax") || lower.includes("json"))
    return "parse_error";
  if (lower.includes("rate limit") || lower.includes("429")) return "rate_limit";
  if (lower.includes("network") || lower.includes("econnrefused") || lower.includes("fetch"))
    return "network";

  return "unknown";
}
