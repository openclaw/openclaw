export function createPendingToolCallState() {
    const pending = new Map();
    return {
        size: () => pending.size,
        entries: () => pending.entries(),
        getToolName: (id) => pending.get(id),
        delete: (id) => {
            pending.delete(id);
        },
        clear: () => {
            pending.clear();
        },
        trackToolCalls: (calls) => {
            for (const call of calls) {
                pending.set(call.id, call.name);
            }
        },
        getPendingIds: () => Array.from(pending.keys()),
        shouldFlushForSanitizedDrop: () => pending.size > 0,
        shouldFlushBeforeNonToolResult: (nextRole, toolCallCount) => pending.size > 0 && (toolCallCount === 0 || nextRole !== "assistant"),
        shouldFlushBeforeNewToolCalls: (toolCallCount) => pending.size > 0 && toolCallCount > 0,
    };
}
