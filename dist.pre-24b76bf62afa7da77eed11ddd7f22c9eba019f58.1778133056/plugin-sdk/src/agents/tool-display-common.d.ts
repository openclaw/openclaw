import { type ToolDetailMode } from "./tool-display-exec.js";
type ToolDisplayActionSpec = {
    label?: string;
    detailKeys?: string[];
};
export type ToolDisplaySpec = {
    title?: string;
    label?: string;
    detailKeys?: string[];
    actions?: Record<string, ToolDisplayActionSpec>;
};
type CoerceDisplayValueOptions = {
    includeFalse?: boolean;
    includeZero?: boolean;
    includeNonFinite?: boolean;
    maxStringChars?: number;
    maxArrayEntries?: number;
};
export declare function normalizeToolName(name?: string): string;
export declare function defaultTitle(name: string): string;
export declare function resolveToolVerbAndDetailForArgs(params: {
    toolKey: string;
    args?: unknown;
    meta?: string;
    spec?: ToolDisplaySpec;
    fallbackDetailKeys?: string[];
    detailMode: "first" | "summary";
    toolDetailMode?: ToolDetailMode;
    detailCoerce?: CoerceDisplayValueOptions;
    detailMaxEntries?: number;
    detailFormatKey?: (raw: string) => string;
}): {
    verb?: string;
    detail?: string;
};
export declare function formatDetailKey(raw: string, overrides?: Record<string, string>): string;
export declare function formatToolDetailText(detail: string | undefined, opts?: {
    prefixWithWith?: boolean;
}): string | undefined;
export {};
