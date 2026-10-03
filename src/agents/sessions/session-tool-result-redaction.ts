import { prepareModelVisibleToolTextBlock } from "../../logging/redact.js";
import { freezeJsonSnapshot } from "../../shared/immutable-data.js";
import { createSessionManagerRuntimeRegistry } from "../agent-hooks/session-manager-runtime-registry.js";
import type { AgentEvent } from "../runtime/index.js";
import { copyInternalToolResultState } from "../runtime/internal-hooks.js";
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
  let content: typeof event.message.content | undefined;
  for (const [index, block] of event.message.content.entries()) {
    if (block.type !== "text") {
      continue;
    }
    const prepared = prepare(block);
    changed ||= prepared.text !== block.text;
    if (prepared !== block) {
      content ??= [...event.message.content];
      content[index] = prepared;
    }
  }
  if (content) {
    const message = event.message;
    if (Object.isFrozen(message)) {
      event.message = copyInternalToolResultState(
        message,
        freezeJsonSnapshot({ ...message, content }),
      );
    } else {
      message.content = content;
    }
  }
  return changed;
}
