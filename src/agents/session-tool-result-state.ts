export type PendingToolCall = { id: string; name?: string };

type PendingToolCallMeta = {
  name?: string;
  createdAtMs: number;
};

export type PendingToolCallState = {
  size: () => number;
  entries: () => IterableIterator<[string, PendingToolCallMeta]>;
  getToolName: (id: string) => string | undefined;
  getCreatedAtMs: (id: string) => number | undefined;
  delete: (id: string) => void;
  clear: () => void;
  trackToolCalls: (calls: PendingToolCall[], nowMs?: number) => void;
  getPendingIds: () => string[];
  getExpiredIds: (ttlMs: number, nowMs?: number) => string[];
  shouldFlushForSanitizedDrop: () => boolean;
  shouldFlushBeforeNonToolResult: (
    nextRole: unknown,
    toolCallCount: number,
    ttlMs: number,
    nowMs?: number,
  ) => boolean;
  shouldFlushBeforeNewToolCalls: (toolCallCount: number) => boolean;
};

export function createPendingToolCallState(): PendingToolCallState {
  const pending = new Map<string, PendingToolCallMeta>();

  return {
    size: () => pending.size,
    entries: () => pending.entries(),
    getToolName: (id: string) => pending.get(id)?.name,
    getCreatedAtMs: (id: string) => pending.get(id)?.createdAtMs,
    delete: (id: string) => {
      pending.delete(id);
    },
    clear: () => {
      pending.clear();
    },
    trackToolCalls: (calls: PendingToolCall[], nowMs = Date.now()) => {
      for (const call of calls) {
        pending.set(call.id, { name: call.name, createdAtMs: nowMs });
      }
    },
    getPendingIds: () => Array.from(pending.keys()),
    getExpiredIds: (ttlMs: number, nowMs = Date.now()) => {
      const expired: string[] = [];
      for (const [id, meta] of pending.entries()) {
        if (nowMs - meta.createdAtMs >= ttlMs) {
          expired.push(id);
        }
      }
      return expired;
    },
    shouldFlushForSanitizedDrop: () => pending.size > 0,
    // Grace-window behavior: do not flush immediately on first non-tool message.
    // Only flush when at least one pending tool call has exceeded ttlMs.
    shouldFlushBeforeNonToolResult: (
      nextRole: unknown,
      toolCallCount: number,
      ttlMs: number,
      nowMs = Date.now(),
    ) => {
      if (pending.size === 0) {
        return false;
      }
      const isNonToolFlow = toolCallCount === 0 || nextRole !== "assistant";
      if (!isNonToolFlow) {
        return false;
      }
      for (const meta of pending.values()) {
        if (nowMs - meta.createdAtMs >= ttlMs) {
          return true;
        }
      }
      return false;
    },
    shouldFlushBeforeNewToolCalls: (toolCallCount: number) => pending.size > 0 && toolCallCount > 0,
  };
}
