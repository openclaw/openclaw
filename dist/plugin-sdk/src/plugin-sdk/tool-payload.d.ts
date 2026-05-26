export type ToolPayloadCarrier = {
    details?: unknown;
    content?: unknown;
};
/**
 * Extract the most useful payload from tool result-like objects shared across
 * outbound core flows and bundled plugin helpers.
 */
export declare function extractToolPayload(result: ToolPayloadCarrier | null | undefined): unknown;
export type PlainTextToolCallBlock = {
    arguments: Record<string, unknown>;
    end: number;
    name: string;
    raw: string;
    start: number;
};
export type PlainTextToolCallParseOptions = {
    allowedToolNames?: Iterable<string>;
    maxPayloadBytes?: number;
};
export declare function parseStandalonePlainTextToolCallBlocks(text: string, options?: PlainTextToolCallParseOptions): PlainTextToolCallBlock[] | null;
export declare function stripPlainTextToolCallBlocks(text: string): string;
