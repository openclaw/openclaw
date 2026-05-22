import { type SessionContext, type SessionEntry, type SessionHeader } from "@mariozechner/pi-coding-agent";
type BranchSummaryEntry = Extract<SessionEntry, {
    type: "branch_summary";
}>;
type CompactionEntry = Extract<SessionEntry, {
    type: "compaction";
}>;
type CustomEntry = Extract<SessionEntry, {
    type: "custom";
}>;
type CustomMessageEntry = Extract<SessionEntry, {
    type: "custom_message";
}>;
type LabelEntry = Extract<SessionEntry, {
    type: "label";
}>;
type ModelChangeEntry = Extract<SessionEntry, {
    type: "model_change";
}>;
type SessionInfoEntry = Extract<SessionEntry, {
    type: "session_info";
}>;
type SessionMessageEntry = Extract<SessionEntry, {
    type: "message";
}>;
type ThinkingLevelChangeEntry = Extract<SessionEntry, {
    type: "thinking_level_change";
}>;
export declare class TranscriptFileState {
    readonly header: SessionHeader | null;
    readonly entries: SessionEntry[];
    readonly migrated: boolean;
    private readonly byId;
    private readonly labelsById;
    private readonly labelTimestampsById;
    private leafId;
    constructor(params: {
        header: SessionHeader | null;
        entries: SessionEntry[];
        migrated?: boolean;
    });
    private rebuildIndex;
    getCwd(): string;
    getHeader(): SessionHeader | null;
    getEntries(): SessionEntry[];
    getLeafId(): string | null;
    getLeafEntry(): SessionEntry | undefined;
    getLabel(id: string): string | undefined;
    getBranch(fromId?: string): SessionEntry[];
    buildSessionContext(): SessionContext;
    branch(branchFromId: string): void;
    resetLeaf(): void;
    appendMessage(message: SessionMessageEntry["message"]): SessionMessageEntry;
    appendThinkingLevelChange(thinkingLevel: string): ThinkingLevelChangeEntry;
    appendModelChange(provider: string, modelId: string): ModelChangeEntry;
    appendCompaction(summary: string, firstKeptEntryId: string, tokensBefore: number, details?: unknown, fromHook?: boolean): CompactionEntry;
    appendCustomEntry(customType: string, data?: unknown): CustomEntry;
    appendSessionInfo(name: string): SessionInfoEntry;
    appendCustomMessageEntry(customType: string, content: CustomMessageEntry["content"], display: boolean, details?: unknown): CustomMessageEntry;
    appendLabelChange(targetId: string, label: string | undefined): LabelEntry;
    branchWithSummary(branchFromId: string | null, summary: string, details?: unknown, fromHook?: boolean): BranchSummaryEntry;
    private appendEntry;
}
export declare function readTranscriptFileState(sessionFile: string): Promise<TranscriptFileState>;
export declare function writeTranscriptFileAtomic(filePath: string, entries: Array<SessionHeader | SessionEntry>): Promise<void>;
export declare function persistTranscriptStateMutation(params: {
    sessionFile: string;
    state: TranscriptFileState;
    appendedEntries: SessionEntry[];
}): Promise<void>;
export {};
