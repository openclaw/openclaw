import { copyPreparedModelVisibleToolText } from "../../logging/redact-internal.js";
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
type ToolTextBlock = Extract<
  Extract<AgentMessage, { role: "toolResult" }>["content"][number],
  { type: "text" }
>;
type ToolTextSource = { source: ToolTextBlock; text: string };
const unchangedToolResult = () => false;

/** Bind the guard's policy without extending the public SessionManager contract. */
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
  // Retain already-redacted, uncapped text only until this event finishes settling.
  let sources: Map<object, ToolTextSource> | undefined;
  return () => {
    if (event.message.role !== "toolResult") {
      return false;
    }
    const message = event.message;
    const preparation = preparers.get(sessionManager);
    const prepare = preparation?.prepareText ?? prepareModelVisibleToolTextBlock;
    const fullContent = message.content.map((block) => {
      if (block.type !== "text") {
        return block;
      }
      const previous = sources?.get(block);
      if (!previous || previous.text !== block.text) {
        return prepare(block);
      }
      const source = { ...block, text: previous.source.text };
      copyPreparedModelVisibleToolText(previous.source, source);
      return prepare(source);
    });
    const full = { ...message, content: fullContent };
    const capped = preparation?.cap(full) ?? full;
    let nextSources: Map<object, ToolTextSource> | undefined;
    const content =
      capped === full
        ? fullContent
        : capped.content.map((block, index) => {
            if (block.type !== "text") {
              return block;
            }
            const prepared = prepare(block);
            const source = fullContent[index];
            if (source?.type === "text" && source.text !== prepared.text) {
              (nextSources ??= new Map()).set(prepared, { source, text: prepared.text });
            }
            return prepared;
          });
    sources = nextSources;
    const changed = content.some((block, index) => {
      const previous = message.content[index];
      return block.type === "text" && previous?.type === "text" && block.text !== previous.text;
    });
    if (content.some((block, index) => block !== message.content[index])) {
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
  };
}
