type ToolAggregateOptions = {
    markdown?: boolean;
};
export declare function shortenPath(p: string): string;
export declare function shortenMeta(meta: string): string;
export declare function formatToolAggregate(toolName?: string, metas?: string[], options?: ToolAggregateOptions): string;
export declare function formatToolPrefix(toolName?: string, meta?: string): string;
export {};
