import { getGatewayContextResolver } from "../../../plugins/runtime/gateway-request-scope.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

/**
 * The run-scoped facts that make detached lifecycle typing the owner of a
 * run's activity signal. `startSubagentTyping` starts from exactly this, and
 * other typing surfaces use it to stay out of runs it owns.
 */
export function resolveSubagentLifecycleTypingOwner(entry: SubagentRunRecord) {
  const origin = entry.requesterOrigin;
  const runtime = getGatewayContextResolver(entry)?.()?.lifecycleRuntime;
  const startTyping = runtime?.startTyping;
  if (
    origin?.channel !== "telegram" ||
    !origin.to ||
    entry.expectsCompletionMessage !== true ||
    entry.collect ||
    !entry.completionRequesterSessionId ||
    !entry.requesterAgentId ||
    !entry.requesterStorePath ||
    !runtime ||
    !startTyping
  ) {
    return undefined;
  }
  return {
    origin: { ...origin, channel: "telegram" as const, to: origin.to },
    requesterAgentId: entry.requesterAgentId,
    requesterStorePath: entry.requesterStorePath,
    runtime,
    startTyping: (params: Parameters<typeof startTyping>[0]) => startTyping.call(runtime, params),
  };
}
