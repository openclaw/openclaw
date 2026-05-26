export declare const TOOL_NAME_SEPARATOR = "__";
export declare function sanitizeServerName(raw: string, usedNames: Set<string>): string;
export declare function normalizeReservedToolNames(names?: Iterable<string>): Set<string>;
export declare function buildSafeToolName(params: {
    serverName: string;
    toolName: string;
    reservedNames: Set<string>;
}): string;
