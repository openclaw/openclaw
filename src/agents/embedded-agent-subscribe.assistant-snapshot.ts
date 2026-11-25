import type { AssistantHistoryMessage } from "../llm/types.js";

/** Detached reasoning from this exact message's synchronous model snapshot. */
export type AssistantSnapshotReasoning = {
  readonly source: AssistantHistoryMessage;
  readonly thinking: readonly (string | undefined)[];
};

/** Preserve native clone semantics and share only previously detached reasoning. */
export function snapshotAssistantMessage<T extends AssistantHistoryMessage>(
  message: T,
  prepared?: AssistantSnapshotReasoning,
): { snapshot: T; reasoning: AssistantSnapshotReasoning } {
  const snapshot = structuredClone(message);
  // Raw terminal text has a different lifetime: reusing its detached copy grows
  // long text-only replies. Keep text on the existing native-clone path.
  const thinking = Array.isArray(snapshot.content)
    ? snapshot.content.map((block, index) => {
        if (block?.type !== "thinking" || typeof block.thinking !== "string") {
          return undefined;
        }
        const previous = prepared?.source === message ? prepared.thinking[index] : undefined;
        if (previous !== undefined && previous === block.thinking) {
          block.thinking = previous;
        }
        return block.thinking;
      })
    : [];
  return { snapshot, reasoning: { source: message, thinking } };
}
