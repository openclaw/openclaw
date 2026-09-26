/**
 * Operator grant for subagent peer session messaging.
 *
 * The grant is the only supported way to re-enable `sessions_send` for spawned
 * subagents. It stays operator-owned so a prompt-injected model cannot widen its
 * own session-messaging authority.
 */
import type { OpenClawConfig } from "../config/types.openclaw.js";

/** Resolved operator grant for subagent peer session messaging. */
export type SubagentSessionMessagingScope = "off" | "peers";

/**
 * Resolve the configured subagent session-messaging grant.
 *
 * Unset or unknown values resolve to "off", which keeps direct session
 * messaging denied for every subagent role.
 */
export function resolveSubagentSessionMessagingScope(
  cfg: OpenClawConfig | undefined,
): SubagentSessionMessagingScope {
  return cfg?.tools?.subagents?.messaging === "peers" ? "peers" : "off";
}
