/**
 * CoreMemories v2.1 - With MEMORY.md Integration
 * Auto-proposes important memories for curated biography updates
 */
export interface MemoryMdConfig {
    enabled: boolean;
    updateTriggers: {
        emotionalThreshold: number;
        decisionTypes: string[];
        userFlagged: boolean;
        reviewInterval: number;
    };
    sections: Record<string, string>;
}
export interface EngineConfig {
    provider: string | null;
    model: string | null;
    endpoint?: string;
    available?: boolean;
    apiKey?: string | null;
    enabled?: boolean;
}
export interface CoreMemoriesConfig {
    enabled: boolean;
    compression: string;
    autoInstall: boolean;
    memoryMd: MemoryMdConfig;
    engines: {
        local: EngineConfig;
        api: EngineConfig;
    };
    fallback: {
        mode: string;
        enabled: boolean;
    };
    privacy: {
        defaultLevel: string;
        encryptSecrets: boolean;
    };
    limits: {
        maxFlashEntries: number;
        maxWarmEntriesPerWeek: number;
    };
}
export interface FlashEntry {
    id: string;
    timestamp: string;
    type: string;
    content: string;
    speaker: string;
    keywords: string[];
    emotionalSalience: number;
    userFlagged: boolean;
    linkedTo: string[];
    privacyLevel: string;
}
export interface WarmEntry {
    id: string;
    timestamp: string;
    summary?: string;
    hook?: string;
    keyPoints?: string[];
    key_quotes?: string[];
    keywords: string[];
    emotionalTone: string;
    linkedTo: string[];
    privacyLevel: string;
    compressionMethod: string;
    content?: string;
    emotionalSalience?: number;
    type?: string;
    userFlagged?: boolean;
    memoryMdProposal?: MemoryMdProposal;
}
export interface MemoryMdProposal {
    entryId: string;
    timestamp: string;
    essence: string;
    section: string;
    reason: string;
    type?: string;
    keywords: string[];
}
export interface SessionContext {
    flash: FlashEntry[];
    warm: WarmEntry[];
    totalTokens: number;
    compressionMode: string;
    pendingMemoryMdUpdates: number;
}
export interface OllamaCheckResult {
    available: boolean;
    models: Array<{
        name: string;
    }>;
}
export interface KeywordSearchResult {
    flash: FlashEntry[];
    warm: WarmEntry[];
}
type GlobalLinkRef = {
    session: string;
    id: string;
    timestamp: string;
    type: string;
    location: string;
    layer: "flash" | "warm";
};
export interface IndexData {
    keywords: Record<string, string[]>;
    timestamps: Record<string, string>;
    lastUpdated: string;
}
export declare function checkOllamaAvailable(endpoint?: string): Promise<OllamaCheckResult>;
export declare function initializeConfig(options?: {
    memoryDir?: string;
}): Promise<CoreMemoriesConfig>;
export declare class CoreMemories {
    private memoryDir;
    private compressionEngine;
    private memoryMdIntegration;
    private initialized;
    constructor(memoryDir?: string);
    initialize(): Promise<void>;
    private loadIndex;
    private saveIndex;
    private resolveGlobalLinksDir;
    private resolveSessionNameForLinks;
    private loadGlobalLinksIndex;
    private saveGlobalLinksIndex;
    private loadGlobalLinksMeta;
    private saveGlobalLinksMeta;
    private compactGlobalLinksJsonl;
    private updateGlobalLinks;
    private updateIndex;
    addFlashEntry(content: string, speaker?: string, type?: string): FlashEntry;
    getFlashEntries(): FlashEntry[];
    addWarmEntry(flashEntry: FlashEntry): Promise<WarmEntry>;
    getWarmEntries(): WarmEntry[];
    private getAllWarmEntries;
    findByKeyword(keyword: string): KeywordSearchResult;
    /**
     * Cross-session keyword search.
     * Uses the global links index to locate which per-session store(s) contain matches,
     * then loads those session entries.
     */
    findByKeywordGlobal(keyword: string): {
        refs: GlobalLinkRef[];
        flash: FlashEntry[];
        warm: WarmEntry[];
    };
    loadSessionContext(): SessionContext;
    runCompression(): Promise<void>;
    approveMemoryMdUpdate(proposalId: string): Promise<boolean>;
    getPendingMemoryMdProposals(): MemoryMdProposal[];
    private getWeekNumber;
    getConfig(): CoreMemoriesConfig | null;
}
export type CoreMemoriesInitOptions = {
    /**
     * Absolute (recommended) or relative directory to store CoreMemories data.
     * When used inside OpenClaw, pass an agent/workspace-scoped path instead of relying on cwd.
     */
    memoryDir?: string;
};
export declare function getCoreMemories(opts?: CoreMemoriesInitOptions): Promise<CoreMemories>;
export { SessionContinuation, SessionContinuationConfig, ContinuationResult, getSessionContinuationMessage, } from "./session-continuation";
export { initSessionContinuation, onSessionStart, heartbeatSessionCheck, getSmartReminderContext, } from "./session-continuation-integration";
//# sourceMappingURL=index.d.ts.map