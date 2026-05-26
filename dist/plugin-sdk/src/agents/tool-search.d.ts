import type { AgentMessage, AgentToolResult, AgentToolUpdateCallback } from "@earendil-works/pi-agent-core";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { type HookContext } from "./pi-tools.before-tool-call.js";
import type { AnyAgentTool } from "./tools/common.js";
export declare const TOOL_SEARCH_CODE_MODE_TOOL_NAME = "tool_search_code";
export declare const TOOL_SEARCH_RAW_TOOL_NAME = "tool_search";
export declare const TOOL_DESCRIBE_RAW_TOOL_NAME = "tool_describe";
export declare const TOOL_CALL_RAW_TOOL_NAME = "tool_call";
type ToolSearchMode = "code" | "tools";
type CatalogSource = "openclaw" | "mcp" | "client";
type CatalogTool = AnyAgentTool | ToolDefinition;
export type ToolSearchCatalogToolExecutor = (params: {
    tool: CatalogTool;
    toolName: string;
    toolCallId: string;
    parentToolCallId?: string;
    input: unknown;
    signal?: AbortSignal;
    onUpdate?: AgentToolUpdateCallback<unknown>;
}) => Promise<AgentToolResult<unknown>>;
export type ToolSearchTargetTranscriptProjection = {
    parentToolCallId?: string;
    toolCallId: string;
    toolName: string;
    input: unknown;
    result?: unknown;
    isError?: boolean;
    timestamp?: number;
};
export type ToolSearchConfig = {
    enabled: boolean;
    mode: ToolSearchMode;
    codeTimeoutMs: number;
    searchDefaultLimit: number;
    maxSearchLimit: number;
};
export type ToolSearchToolContext = {
    config?: OpenClawConfig;
    runtimeConfig?: OpenClawConfig;
    agentId?: string;
    sessionKey?: string;
    sessionId?: string;
    runId?: string;
    catalogRef?: ToolSearchCatalogRef;
    abortSignal?: AbortSignal;
    executeTool?: ToolSearchCatalogToolExecutor;
};
export type ToolSearchCatalogEntry = {
    id: string;
    source: CatalogSource;
    sourceName?: string;
    name: string;
    label?: string;
    description: string;
    parameters?: unknown;
    tool: CatalogTool;
};
export type ToolSearchCatalogSession = {
    entries: ToolSearchCatalogEntry[];
    searchCount: number;
    describeCount: number;
    callCount: number;
};
export type ToolSearchCatalogRef = {
    current?: ToolSearchCatalogSession;
};
declare function isToolSearchCodeModeSupported(): boolean;
export declare function resolveToolSearchConfig(config?: OpenClawConfig): ToolSearchConfig;
export declare function projectToolSearchTargetTranscriptMessages(messages: AgentMessage[], projections: readonly ToolSearchTargetTranscriptProjection[]): AgentMessage[];
export declare function createToolSearchCatalogRef(): ToolSearchCatalogRef;
export declare function applyToolSearchCatalog(params: {
    tools: AnyAgentTool[];
    config?: OpenClawConfig;
    sessionId?: string;
    sessionKey?: string;
    agentId?: string;
    runId?: string;
    catalogRef?: ToolSearchCatalogRef;
    toolHookContext?: HookContext;
}): {
    tools: AnyAgentTool[];
    compacted: boolean;
    catalogToolCount: number;
    catalogRegistered: boolean;
};
export declare function addClientToolsToToolSearchCatalog(params: {
    tools: ToolDefinition[];
    config?: OpenClawConfig;
    sessionId?: string;
    sessionKey?: string;
    agentId?: string;
    runId?: string;
    catalogRef?: ToolSearchCatalogRef;
}): {
    tools: ToolDefinition[];
    compacted: boolean;
    catalogToolCount: number;
};
export declare function registerToolSearchCatalog(params: {
    sessionId?: string;
    sessionKey?: string;
    agentId?: string;
    runId?: string;
    catalogRef?: ToolSearchCatalogRef;
    entries: ToolSearchCatalogEntry[];
    append?: boolean;
}): ToolSearchCatalogSession | undefined;
export declare function clearToolSearchCatalog(params: {
    sessionId?: string;
    sessionKey?: string;
    agentId?: string;
    runId?: string;
    catalogRef?: ToolSearchCatalogRef;
}): void;
export declare class ToolSearchRuntime {
    private readonly ctx;
    private readonly config;
    private callSequence;
    constructor(ctx: ToolSearchToolContext, config: ToolSearchConfig);
    search: (query: string, options?: {
        limit?: number;
    }) => Promise<{
        id: string;
        source: CatalogSource;
        sourceName: string | undefined;
        name: string;
        label: string | undefined;
        description: string;
    }[]>;
    all: () => {
        id: string;
        source: CatalogSource;
        sourceName: string | undefined;
        name: string;
        label: string | undefined;
        description: string;
    }[];
    describe: (id: string) => Promise<{
        id: string;
        source: CatalogSource;
        sourceName: string | undefined;
        name: string;
        label: string | undefined;
        description: string;
        parameters: {};
    }>;
    call: (id: string, input?: unknown, options?: {
        parentToolCallId?: string;
        signal?: AbortSignal;
        onUpdate?: AgentToolUpdateCallback<unknown>;
    }) => Promise<{
        tool: {
            id: string;
            source: CatalogSource;
            sourceName: string | undefined;
            name: string;
            label: string | undefined;
            description: string;
        };
        result: AgentToolResult<unknown>;
    }>;
    telemetry(): {
        catalogSize: number;
        sources: Record<CatalogSource, number>;
        searchCount: number;
        describeCount: number;
        callCount: number;
    };
}
export declare function applyToolCatalogCompaction(params: {
    tools: AnyAgentTool[];
    enabled: boolean;
    sessionId?: string;
    sessionKey?: string;
    agentId?: string;
    runId?: string;
    catalogRef?: ToolSearchCatalogRef;
    toolHookContext?: HookContext;
    isVisibleControlTool: (tool: AnyAgentTool) => boolean;
    shouldCatalogTool?: (tool: AnyAgentTool) => boolean;
}): {
    tools: AnyAgentTool[];
    compacted: boolean;
    catalogToolCount: number;
    catalogRegistered: boolean;
};
export declare function addClientToolsToToolCatalog(params: {
    tools: ToolDefinition[];
    enabled: boolean;
    sessionId?: string;
    sessionKey?: string;
    agentId?: string;
    runId?: string;
    catalogRef?: ToolSearchCatalogRef;
}): {
    tools: ToolDefinition[];
    compacted: boolean;
    catalogToolCount: number;
};
export declare function createToolSearchTools(ctx: ToolSearchToolContext): AnyAgentTool[];
export declare const testing: {
    sessionCatalogs: Map<string, ToolSearchCatalogSession>;
    resolveToolSearchConfig: typeof resolveToolSearchConfig;
    isToolSearchCodeModeSupported: typeof isToolSearchCodeModeSupported;
    setToolSearchCodeModeSupportedForTest: (value: boolean | undefined) => void;
    applyToolSearchCatalog: typeof applyToolSearchCatalog;
    addClientToolsToToolSearchCatalog: typeof addClientToolsToToolSearchCatalog;
};
export { testing as __testing };
