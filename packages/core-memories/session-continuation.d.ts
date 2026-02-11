import { CoreMemories, FlashEntry } from "./index";
export interface SessionContinuationConfig {
    enabled: boolean;
    thresholds: {
        silent: number;
        hint: number;
        prompt: number;
    };
    prioritizeFlagged: boolean;
    maxMemoriesToShow: number;
}
export interface ContinuationResult {
    mode: "silent" | "hint" | "prompt";
    shouldPrompt: boolean;
    message?: string;
    context: {
        topMemories: FlashEntry[];
        lastTopic?: string;
        unfinishedTasks: FlashEntry[];
    };
}
export declare class SessionContinuation {
    private cm;
    private config;
    constructor(coreMemories: CoreMemories, config?: Partial<SessionContinuationConfig>);
    checkSession(userId: string, lastSessionTimestamp: number): Promise<ContinuationResult>;
    private buildHintMessage;
    private buildPromptMessage;
    private extractTopic;
    private summarizeEntry;
}
export declare function getSessionContinuationMessage(coreMemories: CoreMemories, lastSessionTime: number): Promise<string | undefined>;
//# sourceMappingURL=session-continuation.d.ts.map