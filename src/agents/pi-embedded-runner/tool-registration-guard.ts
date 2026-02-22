import type { Agent } from "@mariozechner/pi-agent-core";
import { log } from "./logger.js";

type AnyAgentLike = {
  state: { tools: unknown[] };
  setTools: (tools: unknown[]) => void;
};

/**
 * Installs a defensive guard on the agent's tool registration to prevent
 * runtime tool loss (#22426). The guard:
 *
 * 1. Takes an immutable snapshot of the tools after initial registration.
 * 2. Freezes the tools array so accidental in-place mutations throw.
 * 3. Intercepts `setTools` to reject empty arrays when tools were previously
 *    registered (protects against silent state corruption).
 * 4. Provides `validateTools()` to verify tools are still intact before a
 *    prompt — and automatically restores from snapshot if they've been lost.
 *
 * Returns a cleanup function that restores the original `setTools`.
 */
export function installToolRegistrationGuard(params: {
  agent: Agent;
  expectedToolNames: string[];
  sessionId?: string;
  sessionKey?: string;
}): {
  validateBeforePrompt: () => void;
  dispose: () => void;
} {
  const agentLike = params.agent as unknown as AnyAgentLike;
  const expectedNames = new Set(params.expectedToolNames);
  const label = params.sessionKey ?? params.sessionId ?? "unknown";

  // Snapshot the current tools for recovery.
  const toolsSnapshot: unknown[] = [...agentLike.state.tools];

  // Freeze the live array so in-place mutations (splice / length=0 / etc.)
  // are caught immediately in strict mode.
  try {
    Object.freeze(agentLike.state.tools);
  } catch {
    // Non-extensible arrays are already effectively frozen.
  }

  // Wrap setTools to guard against accidental empty-array replacement.
  const originalSetTools = agentLike.setTools.bind(agentLike);
  agentLike.setTools = (tools: unknown[]) => {
    if (tools.length === 0 && toolsSnapshot.length > 0) {
      log.warn(
        `tool registration guard: rejecting setTools([]) — snapshot has ${toolsSnapshot.length} tools ` +
          `(session=${label})`,
      );
      return;
    }
    originalSetTools(tools);
    // Re-freeze the new array.
    try {
      Object.freeze(agentLike.state.tools);
    } catch {
      /* already frozen */
    }
  };

  function validateBeforePrompt(): void {
    const current = agentLike.state.tools;
    if (!current || current.length === 0) {
      log.warn(
        `tool registration guard: tools array empty before prompt — restoring ${toolsSnapshot.length} tools ` +
          `(session=${label})`,
      );
      originalSetTools(toolsSnapshot);
      try {
        Object.freeze(agentLike.state.tools);
      } catch {
        /* already frozen */
      }
      return;
    }

    const currentNames = new Set(
      (current as Array<{ name?: string }>).map((t) => t.name).filter(Boolean),
    );
    const missing = [...expectedNames].filter((name) => !currentNames.has(name));
    if (missing.length > 0) {
      log.warn(
        `tool registration guard: ${missing.length} expected tool(s) missing before prompt — ` +
          `missing=[${missing.join(", ")}] current=${currentNames.size} snapshot=${toolsSnapshot.length} ` +
          `(session=${label})`,
      );
      // Restore from snapshot when core tools are missing.
      originalSetTools(toolsSnapshot);
      try {
        Object.freeze(agentLike.state.tools);
      } catch {
        /* already frozen */
      }
    }
  }

  function dispose(): void {
    agentLike.setTools = originalSetTools;
  }

  return { validateBeforePrompt, dispose };
}
