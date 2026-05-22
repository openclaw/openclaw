export declare function isRelayableExecCompletionEvent(evt: string): boolean;
export declare function buildCronEventPrompt(pendingEvents: string[], opts?: {
    deliverToUser?: boolean;
}): string;
export declare function buildExecEventPrompt(pendingEvents: string[], opts?: {
    deliverToUser?: boolean;
}): string;
export declare function isExecCompletionEvent(evt: string): boolean;
export declare function isCronSystemEvent(evt: string): boolean;
