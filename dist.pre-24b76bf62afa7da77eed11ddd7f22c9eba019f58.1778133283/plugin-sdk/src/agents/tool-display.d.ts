import type { ToolDetailMode } from "./tool-display-exec.js";
type ToolDisplay = {
    name: string;
    emoji: string;
    title: string;
    label: string;
    verb?: string;
    detail?: string;
};
export declare function resolveToolDisplay(params: {
    name?: string;
    args?: unknown;
    meta?: string;
    detailMode?: ToolDetailMode;
}): ToolDisplay;
export declare function formatToolDetail(display: ToolDisplay): string | undefined;
export declare function formatToolSummary(display: ToolDisplay): string;
export {};
