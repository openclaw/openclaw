export type ToolDetailMode = "explain" | "raw";
export declare function resolveExecDetail(args: unknown, options?: {
    detailMode?: ToolDetailMode;
}): string | undefined;
