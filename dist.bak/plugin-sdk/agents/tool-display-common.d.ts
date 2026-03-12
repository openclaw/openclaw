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
