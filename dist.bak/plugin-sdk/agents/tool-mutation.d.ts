export type ToolMutationState = {
    mutatingAction: boolean;
    actionFingerprint?: string;
};
export type ToolActionRef = {
    toolName: string;
    meta?: string;
    actionFingerprint?: string;
};
export declare function isLikelyMutatingToolName(toolName: string): boolean;
export declare function isMutatingToolCall(toolName: string, args: unknown): boolean;
export declare function buildToolActionFingerprint(toolName: string, args: unknown, meta?: string): string | undefined;
export declare function buildToolMutationState(toolName: string, args: unknown, meta?: string): ToolMutationState;
export declare function isSameToolMutationAction(existing: ToolActionRef, next: ToolActionRef): boolean;
