import type { ToolDisplaySpec as ToolDisplaySpecBase } from "./tool-display-common.js";
type ToolDisplaySpec = ToolDisplaySpecBase & {
    emoji?: string;
};
type ToolDisplayConfig = {
    version: number;
    fallback: ToolDisplaySpec;
    tools: Record<string, ToolDisplaySpec>;
};
export declare const TOOL_DISPLAY_CONFIG: ToolDisplayConfig;
export {};
