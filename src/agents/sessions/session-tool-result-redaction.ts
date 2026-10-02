import { prepareModelVisibleToolTextBlock } from "../../logging/redact.js";
import { createSessionManagerRuntimeRegistry } from "../agent-hooks/session-manager-runtime-registry.js";
import type { AgentEvent } from "../runtime/index.js";
import type { SessionManager } from "./session-manager.js";

const preparers = createSessionManagerRuntimeRegistry<typeof prepareModelVisibleToolTextBlock>();

/** Bind the guard's policy without extending the public SessionManager contract. */
export function setSessionToolTextPreparer(
  sessionManager: SessionManager,
  prepare: typeof prepareModelVisibleToolTextBlock,
): void {
  preparers.set(sessionManager, prepare);
}

export function prepareSessionToolResult(
  sessionManager: SessionManager,
  event: AgentEvent,
): boolean {
  if (event.type !== "message_end" || event.message.role !== "toolResult") {
    return false;
  }
  const prepare = preparers.get(sessionManager) ?? prepareModelVisibleToolTextBlock;
  let changed = false;
  event.message.content = event.message.content.map((block) => {
    if (block.type !== "text") {
      return block;
    }
    const prepared = prepare(block);
    changed ||= prepared.text !== block.text;
    return prepared;
  });
  return changed;
}
