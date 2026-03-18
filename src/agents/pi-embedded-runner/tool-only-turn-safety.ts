/**
 * Safety valve for consecutive tool-only assistant turns.
 *
 * When the agent produces N consecutive assistant messages that contain only
 * tool calls (no user-visible text), this module injects a system-level nudge
 * via `session.steer()` asking the agent to summarise progress and reply to
 * the user.
 *
 * This catches the scenario where loop detection does not fire (each tool call
 * is different) but the user never receives any response.
 *
 * @see https://github.com/openclaw/openclaw/issues/38792
 */

import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { resolveAgentConfig, resolveSessionAgentIds } from "../agent-scope.js";

const log = createSubsystemLogger("agents/tool-only-turn-safety");

/** Resolved runtime config for the safety valve. */
export type ToolOnlyTurnSafetyConfig = {
  /** Maximum consecutive tool-only turns before injecting a nudge (0 = disabled). */
  maxConsecutiveToolOnlyTurns: number;
  /** Notify the user when an API error occurs and no text reply has been sent yet. */
  notifyUserOnApiError: boolean;
};

export const DEFAULT_MAX_CONSECUTIVE_TOOL_ONLY_TURNS = 15;
export const DEFAULT_NOTIFY_USER_ON_API_ERROR = true;

export function resolveToolOnlyTurnSafetyConfig(cfg?: {
  maxConsecutiveToolOnlyTurns?: number;
  notifyUserOnApiError?: boolean;
}): ToolOnlyTurnSafetyConfig {
  const maxTurns = cfg?.maxConsecutiveToolOnlyTurns;
  const notify = cfg?.notifyUserOnApiError;
  return {
    maxConsecutiveToolOnlyTurns:
      typeof maxTurns === "number" && Number.isInteger(maxTurns) && maxTurns >= 0
        ? maxTurns
        : DEFAULT_MAX_CONSECUTIVE_TOOL_ONLY_TURNS,
    notifyUserOnApiError: typeof notify === "boolean" ? notify : DEFAULT_NOTIFY_USER_ON_API_ERROR,
  };
}

/**
 * Resolve the effective runtime safety config from root/default/agent tool scopes.
 *
 * Precedence is:
 * 1. `agents.<id>.tools`
 * 2. root `tools`
 */
export function resolveEffectiveToolOnlyTurnSafetyConfig(params: {
  config?: OpenClawConfig;
  sessionKey?: string;
  agentId?: string;
}): ToolOnlyTurnSafetyConfig {
  const cfg = params.config;
  if (!cfg) {
    return resolveToolOnlyTurnSafetyConfig();
  }

  const { sessionAgentId } = resolveSessionAgentIds({
    config: cfg,
    sessionKey: params.sessionKey,
    agentId: params.agentId,
  });
  const agentTools = resolveAgentConfig(cfg, sessionAgentId)?.tools;
  const rootTools = cfg.tools;

  return resolveToolOnlyTurnSafetyConfig({
    maxConsecutiveToolOnlyTurns:
      agentTools?.maxConsecutiveToolOnlyTurns ?? rootTools?.maxConsecutiveToolOnlyTurns,
    notifyUserOnApiError: agentTools?.notifyUserOnApiError ?? rootTools?.notifyUserOnApiError,
  });
}

/**
 * Build a nudge message for tool-only turn safety valve.
 *
 * Used by the inline implementation in pi-embedded-subscribe.handlers.messages.ts
 * when the consecutive tool-only turn threshold is reached.
 */
export function buildToolOnlyTurnNudgeMessage(consecutiveToolOnlyTurns: number): string {
  log.warn(
    `tool-only turn safety valve triggered: ${consecutiveToolOnlyTurns} consecutive tool-only turns`,
  );
  return (
    `You have completed ${consecutiveToolOnlyTurns} consecutive tool calls without ` +
    `sending any text reply to the user. Please pause, summarise your progress so far, ` +
    `and reply to the user before continuing with more tool calls.`
  );
}

/**
 * Build an API-error notification message for the user.
 *
 * Used by the inline implementation in run.ts when an API error occurs and
 * no text reply has been sent yet.
 */
export function buildApiErrorNotice(
  errorSummary: string,
  config: ToolOnlyTurnSafetyConfig,
): string | null {
  if (!config.notifyUserOnApiError) {
    return null;
  }
  return (
    `Warning: The AI service encountered a temporary error (${errorSummary}). ` +
    `I'm retrying automatically; please hold on.`
  );
}
