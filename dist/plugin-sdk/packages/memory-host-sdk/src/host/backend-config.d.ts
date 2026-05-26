import { type MemoryBackend, type MemoryCitationsMode, type MemoryQmdSearchMode, type MemoryQmdStartupMode, type OpenClawConfig, type SessionSendPolicyConfig } from "./config-utils.js";
export type ResolvedMemoryBackendConfig = {
    backend: MemoryBackend;
    citations: MemoryCitationsMode;
    qmd?: ResolvedQmdConfig;
};
export type ResolvedQmdCollection = {
    name: string;
    path: string;
    pattern: string;
    kind: "memory" | "custom" | "sessions";
};
export type ResolvedQmdUpdateConfig = {
    intervalMs: number;
    debounceMs: number;
    onBoot: boolean;
    startup: MemoryQmdStartupMode;
    startupDelayMs: number;
    waitForBootSync: boolean;
    embedIntervalMs: number;
    commandTimeoutMs: number;
    updateTimeoutMs: number;
    embedTimeoutMs: number;
};
export type ResolvedQmdLimitsConfig = {
    maxResults: number;
    maxSnippetChars: number;
    maxInjectedChars: number;
    timeoutMs: number;
};
export type ResolvedQmdSessionConfig = {
    enabled: boolean;
    exportDir?: string;
    retentionDays?: number;
};
export type ResolvedQmdMcporterConfig = {
    enabled: boolean;
    serverName: string;
    startDaemon: boolean;
};
export type ResolvedQmdConfig = {
    command: string;
    mcporter: ResolvedQmdMcporterConfig;
    searchMode: MemoryQmdSearchMode;
    searchTool?: string;
    collections: ResolvedQmdCollection[];
    sessions: ResolvedQmdSessionConfig;
    update: ResolvedQmdUpdateConfig;
    limits: ResolvedQmdLimitsConfig;
    includeDefaultMemory: boolean;
    scope?: SessionSendPolicyConfig;
};
export declare function resolveMemoryBackendConfig(params: {
    cfg: OpenClawConfig;
    agentId: string;
}): ResolvedMemoryBackendConfig;
