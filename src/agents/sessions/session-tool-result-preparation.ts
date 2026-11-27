import { copyInternalToolResultState } from "../../../packages/agent-core/src/internal-hooks.js";
import { freezeJsonSnapshot } from "../../shared/immutable-data.js";
import { createSessionManagerRuntimeRegistry } from "../agent-hooks/session-manager-runtime-registry.js";
import type { AgentEvent, AgentMessage, AgentToolResult } from "../runtime/index.js";
import type { SessionManager } from "./session-manager.js";
import type { PrivateTempFileOptions } from "./tools/private-temp-file.js";

type ToolResultPreparation = {
  cap: (
    message: Extract<AgentMessage, { role: "toolResult" }>,
  ) => Extract<AgentMessage, { role: "toolResult" }>;
  /** Same budget as `cap`, so a bounded result is a fixed point of the cap. */
  bound: (
    result: AgentToolResult<unknown>,
    spill?: PrivateTempFileOptions,
  ) => Promise<AgentToolResult<unknown>>;
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

/** Bounds an executed result with the guard's budget; unguarded managers keep it as is. */
export function boundSessionToolResult(
  sessionManager: SessionManager,
  result: AgentToolResult<unknown>,
  spill?: PrivateTempFileOptions,
): Promise<AgentToolResult<unknown>> {
  return preparers.get(sessionManager)?.bound(result, spill) ?? Promise.resolve(result);
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
