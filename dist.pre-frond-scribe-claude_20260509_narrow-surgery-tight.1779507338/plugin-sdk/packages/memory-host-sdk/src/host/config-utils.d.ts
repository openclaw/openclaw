export { splitShellArgs } from "./openclaw-runtime-io.js";
export type ChatType = "direct" | "group" | "channel";
export type MemoryBackend = "builtin" | "qmd";
export type MemoryCitationsMode = "auto" | "on" | "off";
export type MemoryQmdSearchMode = "query" | "search" | "vsearch";
export type MemoryQmdStartupMode = "off" | "idle" | "immediate";
export type SessionSendPolicyAction = "allow" | "deny";
export type SessionSendPolicyMatch = {
    channel?: string;
    chatType?: ChatType;
    keyPrefix?: string;
    rawKeyPrefix?: string;
};
export type SessionSendPolicyRule = {
    action: SessionSendPolicyAction;
    match?: SessionSendPolicyMatch;
};
export type SessionSendPolicyConfig = {
    default?: SessionSendPolicyAction;
    rules?: SessionSendPolicyRule[];
};
export type MemoryQmdIndexPath = {
    path: string;
    name?: string;
    pattern?: string;
};
export type MemoryQmdMcporterConfig = {
    enabled?: boolean;
    serverName?: string;
    startDaemon?: boolean;
};
export type MemoryQmdSessionConfig = {
    enabled?: boolean;
    exportDir?: string;
    retentionDays?: number;
};
export type MemoryQmdUpdateConfig = {
    interval?: string;
    debounceMs?: number;
    onBoot?: boolean;
    startup?: MemoryQmdStartupMode;
    startupDelayMs?: number;
    waitForBootSync?: boolean;
    embedInterval?: string;
    commandTimeoutMs?: number;
    updateTimeoutMs?: number;
    embedTimeoutMs?: number;
};
export type MemoryQmdLimitsConfig = {
    maxResults?: number;
    maxSnippetChars?: number;
    maxInjectedChars?: number;
    timeoutMs?: number;
};
export type MemoryQmdConfig = {
    command?: string;
    mcporter?: MemoryQmdMcporterConfig;
    searchMode?: MemoryQmdSearchMode;
    searchTool?: string;
    includeDefaultMemory?: boolean;
    paths?: MemoryQmdIndexPath[];
    sessions?: MemoryQmdSessionConfig;
    update?: MemoryQmdUpdateConfig;
    limits?: MemoryQmdLimitsConfig;
    scope?: SessionSendPolicyConfig;
};
export type MemoryConfig = {
    backend?: MemoryBackend;
    citations?: MemoryCitationsMode;
    qmd?: MemoryQmdConfig;
};
export type MemorySearchConfig = {
    enabled?: boolean;
    extraPaths?: string[];
    qmd?: {
        extraCollections?: MemoryQmdIndexPath[];
    };
};
export type AgentContextLimitsConfig = {
    memoryGetMaxChars?: number;
    memoryGetDefaultLines?: number;
};
export type SecretInput = string | {
    source: string;
    provider: string;
    id: string;
};
type AgentConfig = {
    id?: string;
    default?: boolean;
    workspace?: string;
    memorySearch?: MemorySearchConfig;
    contextLimits?: AgentContextLimitsConfig;
};
export type OpenClawConfig = {
    agents?: {
        defaults?: {
            workspace?: string;
            memorySearch?: MemorySearchConfig;
            contextLimits?: AgentContextLimitsConfig;
        };
        list?: AgentConfig[];
    };
    memory?: MemoryConfig;
    models?: {
        providers?: Record<string, {
            api?: string;
            baseUrl?: string;
            headers?: Record<string, SecretInput>;
        }>;
    };
};
export declare const CANONICAL_ROOT_MEMORY_FILENAME = "MEMORY.md";
export declare function normalizeAgentId(value: string | undefined | null): string;
export declare function resolveUserPath(input: string, env?: NodeJS.ProcessEnv, homedir?: () => string): string;
export declare function resolveStateDir(env?: NodeJS.ProcessEnv, homedir?: () => string): string;
export declare function resolveAgentWorkspaceDir(cfg: OpenClawConfig, agentId: string, env?: NodeJS.ProcessEnv): string;
export declare function resolveAgentContextLimits(cfg: OpenClawConfig | undefined, agentId?: string | null): AgentContextLimitsConfig | undefined;
export declare function resolveMemorySearchConfig(cfg: OpenClawConfig, agentId: string): {
    enabled: boolean;
    extraPaths: string[];
} | null;
export declare function parseDurationMs(raw: string, opts?: {
    defaultUnit?: "ms" | "s" | "m" | "h" | "d";
}): number;
