import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import { loadExactSessionEntryReadOnly } from "../config/sessions/session-accessor.js";
import { formatErrorMessage } from "../infra/errors.js";
import type { EventSessionRoutingPolicy } from "../infra/event-session-routing.js";
import { logWarn } from "../logger.js";
import { resolveAgentIdFromSessionKey } from "../routing/session-key.js";

export function isExecCompletionRouteCurrent(params: {
  sessionKey: string;
  agentId?: string;
  eventRouting?: EventSessionRoutingPolicy;
}): boolean {
  const expected = params.eventRouting?.expectedSessionGeneration;
  if (!expected) {
    return true;
  }
  try {
    const agentId = params.agentId ?? resolveAgentIdFromSessionKey(params.sessionKey);
    const storePath = resolveSessionStorePathCore(params.eventRouting?.sessionStore, { agentId });
    const current = loadExactSessionEntryReadOnly({
      agentId,
      storePath,
      sessionKey: params.sessionKey,
      clone: false,
    })?.entry;
    if (
      current?.sessionId === expected.sessionId &&
      current.lifecycleRevision === expected.lifecycleRevision
    ) {
      return true;
    }
    logWarn(`exec completion route became stale for ${params.sessionKey}; suppressing delivery`);
  } catch (error) {
    logWarn(
      `exec completion route validation failed for ${params.sessionKey}; suppressing stale delivery: ${formatErrorMessage(error)}`,
    );
  }
  return false;
}
