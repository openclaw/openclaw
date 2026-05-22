import type { FileTarget } from "./tool-mutation.js";
export type ToolErrorSummary = {
    toolName: string;
    meta?: string;
    errorCode?: string;
    error?: string;
    timedOut?: boolean;
    middlewareError?: boolean;
    mutatingAction?: boolean;
    actionFingerprint?: string;
    fileTarget?: FileTarget;
};
export declare function isExecLikeToolName(toolName: string): boolean;
