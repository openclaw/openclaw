import { freezeJsonSnapshot } from "../../shared/immutable-data.js";
import { createSessionManagerRuntimeRegistry } from "../agent-hooks/session-manager-runtime-registry.js";
import type { AgentEvent, AgentMessage } from "../runtime/index.js";
import { copyInternalToolResultState } from "../runtime/internal-hooks.js";
import type { SessionManager } from "./session-manager.js";

type ToolResultPreparation = {
  cap: (
    message: Extract<AgentMessage, { role: "toolResult" }>,
  ) => Extract<AgentMessage, { role: "toolResult" }>;
};
const preparers = createSessionManagerRuntimeRegistry<ToolResultPreparation>();
const unchangedToolResult = () => false;

/** Bind the guard's size cap without extending the public SessionManager contract. */
export function setSessionToolResultPreparer(
  sessionManager: SessionManager,
  preparation: ToolResultPreparation,
): void {
  preparers.set(sessionManager, preparation);
}

export function createSessionToolResultPreparer(
  sessionManager: SessionManager,
  event: AgentEvent,
): () => boolean {
  if (event.type !== "message_end" || event.message.role !== "toolResult") {
    return unchangedToolResult;
  }
  return () => {
    if (event.message.role !== "toolResult") {
      return false;
    }
    const message = event.message;
    const capped = preparers.get(sessionManager)?.cap(message) ?? message;
    if (capped === message) {
      return false;
    }
    if (Object.isFrozen(message)) {
      event.message = copyInternalToolResultState(message, freezeJsonSnapshot(capped));
    } else {
      message.content = capped.content;
    }
    return true;
  };
}
