import { agentSessionKeysMatchByRequestKey, normalizeAgentId } from "../../routing/session-key.js";
import type { ReplyOperation } from "../../sessions/session-controller.contracts.js";
import { assertSessionControllerOperation } from "../../sessions/session-controller.state.js";

/** A case-preserving thread id and its folded store key are one admitted turn. */
export function assertAdmittedEmbeddedRunTurn(
  operation: ReplyOperation,
  sessionId: string,
  sessionKey: string | undefined,
  agentId: string | undefined,
): void {
  assertSessionControllerOperation(operation);
  if (
    (sessionKey !== undefined && !agentSessionKeysMatchByRequestKey(operation.key, sessionKey)) ||
    operation.sessionId !== sessionId ||
    (operation.agentId && agentId && operation.agentId !== normalizeAgentId(agentId))
  ) {
    throw new Error("Native registration does not match the exact admitted session turn");
  }
}
