/**
 * Tracks pending tool-call ids while repairing sanitized transcript messages.
 * The state object decides when dropped or reordered messages need synthetic
 * tool results flushed.
 */
type PendingToolCall = { id: string; name?: string; timestamp?: number };
type PendingToolCallEntry = { name?: string; timestamp?: number };

type PendingToolCallState = {
  size: () => number;
  entries: () => IterableIterator<[string, PendingToolCallEntry]>;
  getToolName: (id: string) => string | undefined;
  delete: (id: string) => void;
  clear: () => void;
  trackToolCalls: (calls: PendingToolCall[]) => void;
  getPendingIds: () => string[];
  shouldFlushForSanitizedDrop: () => boolean;
  shouldFlushBeforeNonToolResult: (nextRole: unknown, toolCallCount: number) => boolean;
  shouldFlushBeforeNewToolCalls: (toolCallCount: number) => boolean;
};

/** Tracks pending tool calls so sanitized transcript repair can flush in order. */
export function createPendingToolCallState(): PendingToolCallState {
  const pending = new Map<string, PendingToolCallEntry>();

  return {
    size: () => pending.size,
    entries: () => pending.entries(),
    getToolName: (id: string) => pending.get(id)?.name,
    delete: (id: string) => {
      pending.delete(id);
    },
    clear: () => {
      pending.clear();
    },
    trackToolCalls: (calls: PendingToolCall[]) => {
      for (const call of calls) {
        pending.set(call.id, {
          ...(call.name !== undefined ? { name: call.name } : {}),
          ...(call.timestamp !== undefined ? { timestamp: call.timestamp } : {}),
        });
      }
    },
    getPendingIds: () => Array.from(pending.keys()),
    shouldFlushForSanitizedDrop: () => pending.size > 0,
    shouldFlushBeforeNonToolResult: (nextRole: unknown, toolCallCount: number) =>
      pending.size > 0 && (toolCallCount === 0 || nextRole !== "assistant"),
    shouldFlushBeforeNewToolCalls: (toolCallCount: number) => pending.size > 0 && toolCallCount > 0,
  };
}
