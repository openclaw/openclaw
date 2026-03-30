export type ToolDisplay = {
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
}): ToolDisplay;
export declare function formatToolDetail(display: ToolDisplay): string | undefined;
export declare function formatToolSummary(display: ToolDisplay): string;
