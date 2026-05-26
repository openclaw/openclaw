import type { FileTarget } from "./tool-mutation.js";
export type ToolErrorSummary = {
    toolName: string;
    meta?: string;
    error?: string;
    timedOut?: boolean;
    mutatingAction?: boolean;
    actionFingerprint?: string;
    fileTarget?: FileTarget;
};
export declare function isExecLikeToolName(toolName: string): boolean;
