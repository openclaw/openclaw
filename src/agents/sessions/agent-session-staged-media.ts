import { recordInboundMediaOwnersInValue } from "../../media/inbound-media-ownership.js";
import type { AgentMessage } from "../runtime/index.js";

/**
 * A staged media reference is readable only by the session that published its result, and a
 * persisted toolResult is where that reference lands in a session. This binds ownership at that
 * point. Best-effort: the staged object already refuses a request that names no session, so a
 * failure here narrows nothing away from the shipped private behaviour.
 */
export function bindStagedMediaOwnership(
  message: AgentMessage,
  sessionKey: string | undefined,
): void {
  if (message.role !== "toolResult" || !sessionKey) {
    return;
  }
  void recordInboundMediaOwnersInValue(message.content, { sessionKey }).catch(() => undefined);
}
