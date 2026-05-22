/** Placeholder for blank user messages — preserves the user turn so strict
 * providers that require at least one user message don't reject the transcript. */
export declare const BLANK_USER_FALLBACK_TEXT = "(continue)";
type RepairReport = {
    repaired: boolean;
    droppedLines: number;
    rewrittenAssistantMessages?: number;
    droppedBlankUserMessages?: number;
    rewrittenUserMessages?: number;
    backupPath?: string;
    reason?: string;
};
export declare function repairSessionFileIfNeeded(params: {
    sessionFile: string;
    debug?: (message: string) => void;
    warn?: (message: string) => void;
}): Promise<RepairReport>;
export {};
