type PendingToolCall = {
    id: string;
    name?: string;
};
type PendingToolCallState = {
    size: () => number;
    entries: () => IterableIterator<[string, string | undefined]>;
    getToolName: (id: string) => string | undefined;
    delete: (id: string) => void;
    clear: () => void;
    trackToolCalls: (calls: PendingToolCall[]) => void;
    getPendingIds: () => string[];
    shouldFlushForSanitizedDrop: () => boolean;
    shouldFlushBeforeNonToolResult: (nextRole: unknown, toolCallCount: number) => boolean;
    shouldFlushBeforeNewToolCalls: (toolCallCount: number) => boolean;
};
export declare function createPendingToolCallState(): PendingToolCallState;
export {};
