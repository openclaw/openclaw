import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { HookContext } from "./pi-tools.before-tool-call.js";
import { ToolSearchRuntime, type ToolSearchCatalogRef, type ToolSearchToolContext } from "./tool-search.js";
import { type AnyAgentTool } from "./tools/common.js";
export declare const CODE_MODE_EXEC_TOOL_NAME = "exec";
export declare const CODE_MODE_WAIT_TOOL_NAME = "wait";
type CodeModeLanguage = "javascript" | "typescript";
export type CodeModeConfig = {
    enabled: boolean;
    runtime: "quickjs-wasi";
    mode: "only";
    languages: CodeModeLanguage[];
    timeoutMs: number;
    memoryLimitBytes: number;
    maxOutputBytes: number;
    maxSnapshotBytes: number;
    maxPendingToolCalls: number;
    snapshotTtlSeconds: number;
    searchDefaultLimit: number;
    maxSearchLimit: number;
};
type CodeModeBridgeMethod = "search" | "describe" | "call" | "yield";
type PendingBridgeRequest = {
    id: string;
    method: CodeModeBridgeMethod;
    args: unknown[];
};
type SettledBridgeRequest = {
    id: string;
    ok: boolean;
    value?: unknown;
    error?: string;
};
type PendingBridgeState = PendingBridgeRequest & {
    promise: Promise<SettledBridgeRequest>;
    settled?: SettledBridgeRequest;
};
type CodeModeRunState = {
    runId: string;
    parentToolCallId: string;
    ctx: ToolSearchToolContext;
    config: CodeModeConfig;
    snapshotBytes: Uint8Array;
    pending: PendingBridgeState[];
    output: unknown[];
    createdAt: number;
    expiresAt: number;
    runtime: ToolSearchRuntime;
};
type CodeModeToolContext = ToolSearchToolContext;
export declare function resolveCodeModeConfig(config?: OpenClawConfig): CodeModeConfig;
export declare function isCodeModeControlTool(tool: AnyAgentTool): boolean;
declare function resolveCodeModeWorkerUrl(currentModuleUrl: string): URL;
declare function codeModeWorkerUrl(): URL;
export declare function createCodeModeTools(ctx: CodeModeToolContext): AnyAgentTool[];
export declare function applyCodeModeCatalog(params: {
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
export declare function addClientToolsToCodeModeCatalog(params: {
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
export declare const __testing: {
    activeRuns: Map<string, CodeModeRunState>;
    resumingRunIds: Set<string>;
    codeModeWorkerUrl: typeof codeModeWorkerUrl;
    resolveCodeModeWorkerUrl: typeof resolveCodeModeWorkerUrl;
    resolveCodeModeConfig: typeof resolveCodeModeConfig;
    getTypescriptRuntimePromise: () => Promise<typeof import("typescript")> | null;
};
export {};
