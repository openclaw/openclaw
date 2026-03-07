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

import { createSubsystemLogger } from "../../logging/subsystem.js";

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
 * Tracks consecutive assistant turns that contain only tool calls and no
 * user-visible text content.
 */
export class ToolOnlyTurnTracker {
  private consecutiveToolOnlyTurns = 0;
  private hasEmittedTextReply = false;
  private nudgeInjected = false;
  private readonly config: ToolOnlyTurnSafetyConfig;

  constructor(config: ToolOnlyTurnSafetyConfig) {
    this.config = config;
  }

  /** Call when an assistant message ends with user-visible text. */
  recordTextReply(): void {
    this.consecutiveToolOnlyTurns = 0;
    this.hasEmittedTextReply = true;
    this.nudgeInjected = false;
  }

  /** Call when an assistant message ends with only tool calls (no text). */
  recordToolOnlyTurn(): void {
    this.consecutiveToolOnlyTurns++;
  }

  /** Whether the agent has ever produced a text reply in this run. */
  get hasReplied(): boolean {
    return this.hasEmittedTextReply;
  }

  /** Current consecutive tool-only turn count. */
  get count(): number {
    return this.consecutiveToolOnlyTurns;
  }

  /**
   * Check whether a nudge should be injected. Returns the nudge message text
   * if the threshold is reached, or `null` if no nudge is needed.
   *
   * Once a nudge is returned it will not be returned again until the agent
   * produces a text reply (resetting the counter).
   */
  checkNudge(): string | null {
    const threshold = this.config.maxConsecutiveToolOnlyTurns;
    if (threshold <= 0) {
      return null;
    }
    if (this.consecutiveToolOnlyTurns < threshold) {
      return null;
    }
    if (this.nudgeInjected) {
      return null;
    }
    this.nudgeInjected = true;
    const msg =
      `You have completed ${this.consecutiveToolOnlyTurns} consecutive tool calls without ` +
      `sending any text reply to the user. Please pause, summarise your progress so far, ` +
      `and reply to the user before continuing with more tool calls.`;
    log.warn(
      `tool-only turn safety valve triggered: ${this.consecutiveToolOnlyTurns} consecutive tool-only turns`,
    );
    return msg;
  }

  /**
   * Build an API-error notification message for the user when no text reply
   * has been sent yet and `notifyUserOnApiError` is enabled.
   */
  buildApiErrorNotice(errorSummary: string): string | null {
    if (!this.config.notifyUserOnApiError) {
      return null;
    }
    // If the agent already replied to the user, don't add noise.
    if (this.hasEmittedTextReply) {
      return null;
    }
    return (
      `⚠️ The AI service encountered a temporary error (${errorSummary}). ` +
      `I'm retrying automatically — please hold on.`
    );
  }
}
