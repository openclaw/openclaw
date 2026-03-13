export type ToolDisplayActionSpec = {
    label?: string;
    detailKeys?: string[];
};
export type ToolDisplaySpec = {
    title?: string;
    label?: string;
    detailKeys?: string[];
    actions?: Record<string, ToolDisplayActionSpec>;
};
export type CoerceDisplayValueOptions = {
    includeFalse?: boolean;
    includeZero?: boolean;
    includeNonFinite?: boolean;
    maxStringChars?: number;
    maxArrayEntries?: number;
};
export declare function normalizeToolName(name?: string): string;
export declare function defaultTitle(name: string): string;
export declare function normalizeVerb(value?: string): string | undefined;
export declare function resolveActionArg(args: unknown): string | undefined;
export declare function resolveToolVerbAndDetailForArgs(params: {
    toolKey: string;
    args?: unknown;
    meta?: string;
    spec?: ToolDisplaySpec;
    fallbackDetailKeys?: string[];
    detailMode: "first" | "summary";
    detailCoerce?: CoerceDisplayValueOptions;
    detailMaxEntries?: number;
    detailFormatKey?: (raw: string) => string;
}): {
    verb?: string;
    detail?: string;
};
export declare function coerceDisplayValue(value: unknown, opts?: CoerceDisplayValueOptions): string | undefined;
export declare function lookupValueByPath(args: unknown, path: string): unknown;
export declare function formatDetailKey(raw: string, overrides?: Record<string, string>): string;
export declare function resolvePathArg(args: unknown): string | undefined;
export declare function resolveReadDetail(args: unknown): string | undefined;
export declare function resolveWriteDetail(toolKey: string, args: unknown): string | undefined;
export declare function resolveWebSearchDetail(args: unknown): string | undefined;
export declare function resolveWebFetchDetail(args: unknown): string | undefined;
export declare function resolveExecDetail(args: unknown): string | undefined;
export declare function resolveActionSpec(spec: ToolDisplaySpec | undefined, action: string | undefined): ToolDisplayActionSpec | undefined;
export declare function resolveDetailFromKeys(args: unknown, keys: string[], opts: {
    mode: "first" | "summary";
    coerce?: CoerceDisplayValueOptions;
    maxEntries?: number;
    formatKey?: (raw: string) => string;
}): string | undefined;
export declare function resolveToolVerbAndDetail(params: {
    toolKey: string;
    args?: unknown;
    meta?: string;
    action?: string;
    spec?: ToolDisplaySpec;
    fallbackDetailKeys?: string[];
    detailMode: "first" | "summary";
    detailCoerce?: CoerceDisplayValueOptions;
    detailMaxEntries?: number;
    detailFormatKey?: (raw: string) => string;
}): {
    verb?: string;
    detail?: string;
};
export declare function formatToolDetailText(detail: string | undefined, opts?: {
    prefixWithWith?: boolean;
}): string | undefined;
