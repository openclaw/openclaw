/**
 * Shared types for isolated agent turn execution.
 *
 * These types are used by both cron and spool (and potentially other future triggers)
 * to run agent turns in isolated sessions.
 */

import type { ChannelId } from "../../channels/plugins/types.js";
import type { CliDeps } from "../../cli/deps.js";
import type { OpenClawConfig } from "../../config/config.js";

/**
 * Source information for message formatting.
 * This allows the agent turn runner to format messages appropriately
 * based on the trigger source (cron or spool).
 *
 * Note: Hooks (Gmail, webhooks) flow through cron via session key detection,
 * not as a separate source type.
 */
export type IsolatedAgentTurnSource = {
  type: "cron" | "spool";
  id: string;
  name: string;
};

/**
 * Parameters for running an isolated agent turn.
 * This is the generic interface that both cron and spool wrappers convert to.
 */
export type IsolatedAgentTurnParams = {
  cfg: OpenClawConfig;
  deps: CliDeps;

  /** The message to send to the agent. */
  message: string;

  /** Session key for this turn. */
  sessionKey: string;

  /** Optional agent ID (uses default if not specified). */
  agentId?: string;

  /** Lane for routing (defaults based on source). */
  lane?: string;

  // Agent options (from payload)
  /** Model override (provider/model or alias). */
  model?: string;
  /** Thinking level (off|minimal|low|medium|high|xhigh). */
  thinking?: string;
  /** Timeout in seconds. */
  timeoutSeconds?: number;

  // Delivery options
  /** Whether to deliver the response (true=explicit, false=off, undefined=auto). */
  deliver?: boolean;
  /** Channel for delivery. */
  channel?: "last" | ChannelId;
  /** Recipient for delivery. */
  to?: string;
  /** If true, delivery failures don't cause errors. */
  bestEffortDeliver?: boolean;

  // Security
  /** If true, skip security wrapping for external hook content. DANGEROUS. */
  allowUnsafeExternalContent?: boolean;

  /** Source information for message formatting. */
  source: IsolatedAgentTurnSource;

  /** Optional label for the session entry (e.g. "Cron: daily-report"). */
  sessionLabel?: string;
};

/**
 * Result from running an isolated agent turn.
 */
export type IsolatedAgentTurnResult = {
  status: "ok" | "error" | "skipped";
  /** Summary of the agent's response (truncated if long). */
  summary?: string;
  /** Last non-empty agent text output (not truncated). */
  outputText?: string;
  /** Error message if status is "error". */
  error?: string;
  /** The session ID for this run. */
  sessionId?: string;
  /** The session key used for this run. */
  sessionKey?: string;
};
