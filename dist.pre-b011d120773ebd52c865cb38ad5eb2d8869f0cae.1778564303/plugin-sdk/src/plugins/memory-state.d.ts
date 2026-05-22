import type { MemoryCitationsMode } from "../config/types.memory.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { MemorySearchManager } from "../memory-host-sdk/host/types.js";
export type MemoryPromptSectionBuilder = (params: {
    availableTools: Set<string>;
    citationsMode?: MemoryCitationsMode;
}) => string[];
export type MemoryCorpusSearchResult = {
    corpus: string;
    path: string;
    title?: string;
    kind?: string;
    score: number;
    snippet: string;
    id?: string;
    startLine?: number;
    endLine?: number;
    citation?: string;
    source?: string;
    provenanceLabel?: string;
    sourceType?: string;
    sourcePath?: string;
    updatedAt?: string;
};
export type MemoryCorpusGetResult = {
    corpus: string;
    path: string;
    title?: string;
    kind?: string;
    content: string;
    fromLine: number;
    lineCount: number;
    id?: string;
    provenanceLabel?: string;
    sourceType?: string;
    sourcePath?: string;
    updatedAt?: string;
};
export type MemoryCorpusSupplement = {
    search(params: {
        query: string;
        maxResults?: number;
        agentSessionKey?: string;
    }): Promise<MemoryCorpusSearchResult[]>;
    get(params: {
        lookup: string;
        fromLine?: number;
        lineCount?: number;
        agentSessionKey?: string;
    }): Promise<MemoryCorpusGetResult | null>;
};
export type MemoryCorpusSupplementRegistration = {
    pluginId: string;
    supplement: MemoryCorpusSupplement;
};
export type MemoryPromptSupplementRegistration = {
    pluginId: string;
    builder: MemoryPromptSectionBuilder;
};
export type MemoryFlushPlan = {
    softThresholdTokens: number;
    forceFlushTranscriptBytes: number;
    reserveTokensFloor: number;
    model?: string;
    prompt: string;
    systemPrompt: string;
    relativePath: string;
};
export type MemoryFlushPlanResolver = (params: {
    cfg?: OpenClawConfig;
    nowMs?: number;
}) => MemoryFlushPlan | null;
export type RegisteredMemorySearchManager = MemorySearchManager;
export type MemoryRuntimeQmdConfig = {
    command?: string;
};
export type MemoryRuntimeBackendConfig = {
    backend: "builtin";
} | {
    backend: "qmd";
    qmd?: MemoryRuntimeQmdConfig;
};
export type MemoryPluginRuntime = {
    getMemorySearchManager(params: {
        cfg: OpenClawConfig;
        agentId: string;
        purpose?: "default" | "status" | "cli";
    }): Promise<{
        manager: RegisteredMemorySearchManager | null;
        error?: string;
    }>;
    resolveMemoryBackendConfig(params: {
        cfg: OpenClawConfig;
        agentId: string;
    }): MemoryRuntimeBackendConfig;
    closeAllMemorySearchManagers?(): Promise<void>;
};
export type MemoryPluginPublicArtifactContentType = "markdown" | "json" | "text";
export type MemoryPluginPublicArtifact = {
    kind: string;
    workspaceDir: string;
    relativePath: string;
    absolutePath: string;
    agentIds: string[];
    contentType: MemoryPluginPublicArtifactContentType;
};
export type MemoryPluginPublicArtifactsProvider = {
    listArtifacts(params: {
        cfg: OpenClawConfig;
    }): Promise<MemoryPluginPublicArtifact[]>;
};
export type MemoryPluginCapability = {
    promptBuilder?: MemoryPromptSectionBuilder;
    flushPlanResolver?: MemoryFlushPlanResolver;
    runtime?: MemoryPluginRuntime;
    publicArtifacts?: MemoryPluginPublicArtifactsProvider;
};
export type MemoryPluginCapabilityRegistration = {
    pluginId: string;
    capability: MemoryPluginCapability;
};
type MemoryPluginState = {
    capability?: MemoryPluginCapabilityRegistration;
    corpusSupplements: MemoryCorpusSupplementRegistration[];
    promptSupplements: MemoryPromptSupplementRegistration[];
};
export declare function registerMemoryCorpusSupplement(pluginId: string, supplement: MemoryCorpusSupplement): void;
export declare function registerMemoryCapability(pluginId: string, capability: MemoryPluginCapability): void;
export declare function getMemoryCapabilityRegistration(): MemoryPluginCapabilityRegistration | undefined;
export declare function listMemoryCorpusSupplements(): MemoryCorpusSupplementRegistration[];
/** @deprecated Use registerMemoryCapability(pluginId, { promptBuilder }) instead. */
export declare function registerMemoryPromptSection(builder: MemoryPromptSectionBuilder): void;
export declare function registerMemoryPromptSectionForPlugin(pluginId: string, builder: MemoryPromptSectionBuilder): void;
export declare function registerMemoryPromptSupplement(pluginId: string, builder: MemoryPromptSectionBuilder): void;
export declare function buildMemoryPromptSection(params: {
    availableTools: Set<string>;
    citationsMode?: MemoryCitationsMode;
}): string[];
export declare function getMemoryPromptSectionBuilder(): MemoryPromptSectionBuilder | undefined;
export declare function listMemoryPromptSupplements(): MemoryPromptSupplementRegistration[];
/** @deprecated Use registerMemoryCapability(pluginId, { flushPlanResolver }) instead. */
export declare function registerMemoryFlushPlanResolver(resolver: MemoryFlushPlanResolver): void;
export declare function registerMemoryFlushPlanResolverForPlugin(pluginId: string, resolver: MemoryFlushPlanResolver): void;
export declare function resolveMemoryFlushPlan(params: {
    cfg?: OpenClawConfig;
    nowMs?: number;
}): MemoryFlushPlan | null;
export declare function getMemoryFlushPlanResolver(): MemoryFlushPlanResolver | undefined;
/** @deprecated Use registerMemoryCapability(pluginId, { runtime }) instead. */
export declare function registerMemoryRuntime(runtime: MemoryPluginRuntime): void;
export declare function registerMemoryRuntimeForPlugin(pluginId: string, runtime: MemoryPluginRuntime): void;
export declare function getMemoryRuntime(): MemoryPluginRuntime | undefined;
export declare function hasMemoryRuntime(): boolean;
export declare function listActiveMemoryPublicArtifacts(params: {
    cfg: OpenClawConfig;
}): Promise<MemoryPluginPublicArtifact[]>;
export declare function restoreMemoryPluginState(state: MemoryPluginState): void;
export declare function clearMemoryPluginState(): void;
export declare const _resetMemoryPluginState: typeof clearMemoryPluginState;
export {};
