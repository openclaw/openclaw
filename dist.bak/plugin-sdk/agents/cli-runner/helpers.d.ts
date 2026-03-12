import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { ImageContent } from "@mariozechner/pi-ai";
import type { ThinkLevel } from "../../auto-reply/thinking.js";
import type { OpenClawConfig } from "../../config/config.js";
import type { CliBackendConfig } from "../../config/types.js";
import type { EmbeddedContextFile } from "../pi-embedded-helpers.js";
export { buildCliSupervisorScopeKey, resolveCliNoOutputTimeoutMs } from "./reliability.js";
export declare function enqueueCliRun<T>(key: string, task: () => Promise<T>): Promise<T>;
type CliUsage = {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    total?: number;
};
export type CliOutput = {
    text: string;
    sessionId?: string;
    usage?: CliUsage;
};
export declare function buildSystemPrompt(params: {
    workspaceDir: string;
    config?: OpenClawConfig;
    defaultThinkLevel?: ThinkLevel;
    extraSystemPrompt?: string;
    ownerNumbers?: string[];
    heartbeatPrompt?: string;
    docsPath?: string;
    tools: AgentTool[];
    contextFiles?: EmbeddedContextFile[];
    modelDisplay: string;
    agentId?: string;
}): string;
export declare function normalizeCliModel(modelId: string, backend: CliBackendConfig): string;
export declare function parseCliJson(raw: string, backend: CliBackendConfig): CliOutput | null;
export declare function parseCliJsonl(raw: string, backend: CliBackendConfig): CliOutput | null;
export declare function resolveSystemPromptUsage(params: {
    backend: CliBackendConfig;
    isNewSession: boolean;
    systemPrompt?: string;
}): string | null;
export declare function resolveSessionIdToSend(params: {
    backend: CliBackendConfig;
    cliSessionId?: string;
}): {
    sessionId?: string;
    isNew: boolean;
};
export declare function resolvePromptInput(params: {
    backend: CliBackendConfig;
    prompt: string;
}): {
    argsPrompt?: string;
    stdin?: string;
};
export declare function appendImagePathsToPrompt(prompt: string, paths: string[]): string;
export declare function writeCliImages(images: ImageContent[]): Promise<{
    paths: string[];
    cleanup: () => Promise<void>;
}>;
export declare function buildCliArgs(params: {
    backend: CliBackendConfig;
    baseArgs: string[];
    modelId: string;
    sessionId?: string;
    systemPrompt?: string | null;
    imagePaths?: string[];
    promptArg?: string;
    useResume: boolean;
}): string[];
