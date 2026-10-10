import { prepareModelVisibleToolTextBlock } from "../../logging/redact.js";
import { freezeJsonSnapshot } from "../../shared/immutable-data.js";
import { createSessionManagerRuntimeRegistry } from "../agent-hooks/session-manager-runtime-registry.js";
import type { AgentEvent, AgentMessage } from "../runtime/index.js";
import { copyInternalToolResultState } from "../runtime/internal-hooks.js";
import type { SessionManager } from "./session-manager.js";

type ToolResultPreparation = {
  prepareText: typeof prepareModelVisibleToolTextBlock;
  cap: (
    message: Extract<AgentMessage, { role: "toolResult" }>,
  ) => Extract<AgentMessage, { role: "toolResult" }>;
};
const preparers = createSessionManagerRuntimeRegistry<ToolResultPreparation>();

/** Bind the guard's policy without extending the public SessionManager contract. */
export function setSessionToolResultPreparer(
  sessionManager: SessionManager,
  preparation: ToolResultPreparation,
): void {
  preparers.set(sessionManager, preparation);
}

export function prepareSessionToolResult(
  sessionManager: SessionManager,
  event: AgentEvent,
): boolean {
  if (event.type !== "message_end" || event.message.role !== "toolResult") {
    return false;
  }
  const preparation = preparers.get(sessionManager);
  const prepare = preparation?.prepareText ?? prepareModelVisibleToolTextBlock;
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
  // Publish the same cap that persistence applies, before context guards can
  // produce a second truncation notice and invalidate the frozen source hash.
  if (preparation) {
    const message = content ? { ...event.message, content } : event.message;
    const capped = preparation.cap(message);
    if (capped !== message) {
      changed = true;
      content = capped.content;
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
