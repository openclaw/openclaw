import type { VoiceCallConfig } from "../config.js";
import type { CallRecord } from "../types.js";

/**
 * Single resolution point for which agent answers a voice call.
 *
 * Precedence:
 *   1. call.agentId (frozen at call creation from per-call ctx.agentId)
 *   2. effectiveConfig.agentId (number-route or plugin default — legacy / inbound bootstrap)
 *   3. "main" (last-resort literal)
 *
 * Every consumer (webhook, realtime consult, response-generator) MUST go through
 * this helper. Direct reads of effectiveConfig.agentId in downstream code are bugs.
 */
export function resolveCallAgentId(
  call: Pick<CallRecord, "agentId">,
  effectiveConfig: Pick<VoiceCallConfig, "agentId">,
): string {
  return call.agentId || effectiveConfig.agentId || "main";
}
