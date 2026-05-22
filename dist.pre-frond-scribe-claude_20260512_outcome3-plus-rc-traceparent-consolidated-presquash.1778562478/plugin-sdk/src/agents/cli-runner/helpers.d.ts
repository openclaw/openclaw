import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { ImageContent } from "@mariozechner/pi-ai";
import type { SourceReplyDeliveryMode } from "../../auto-reply/get-reply-options.types.js";
import type { ThinkLevel } from "../../auto-reply/thinking.js";
import type { CliBackendConfig } from "../../config/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { EmbeddedContextFile } from "../pi-embedded-helpers.js";
import type { SandboxFsBridge } from "../sandbox/fs-bridge.js";
import type { SilentReplyPromptMode } from "../system-prompt.types.js";
export { buildCliSupervisorScopeKey, resolveCliNoOutputTimeoutMs } from "./reliability.js";
export declare function enqueueCliRun<T>(key: string, task: () => Promise<T>): Promise<T>;
export declare function resolveCliRunQueueKey(params: {
    backendId: string;
    serialize?: boolean;
    runId: string;
    workspaceDir: string;
    cliSessionId?: string;
}): string;
export declare function buildSystemPrompt(params: {
    workspaceDir: string;
    config?: OpenClawConfig;
    defaultThinkLevel?: ThinkLevel;
    extraSystemPrompt?: string;
    sourceReplyDeliveryMode?: SourceReplyDeliveryMode;
    silentReplyPromptMode?: SilentReplyPromptMode;
    ownerNumbers?: string[];
    heartbeatPrompt?: string;
    docsPath?: string;
    sourcePath?: string;
    tools: AgentTool[];
    contextFiles?: EmbeddedContextFile[];
    skillsPrompt?: string;
    modelDisplay: string;
    agentId?: string;
}): string;
export declare function normalizeCliModel(modelId: string, backend: CliBackendConfig): string;
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
export declare function loadPromptRefImages(params: {
    prompt: string;
    workspaceDir: string;
    maxBytes?: number;
    workspaceOnly?: boolean;
    sandbox?: {
        root: string;
        bridge: SandboxFsBridge;
    };
}): Promise<ImageContent[]>;
export declare function writeCliImages(params: {
    backend: CliBackendConfig;
    workspaceDir: string;
    images: ImageContent[];
}): Promise<{
    paths: string[];
    cleanup: () => Promise<void>;
}>;
export declare function writeCliSystemPromptFile(params: {
    backend: CliBackendConfig;
    systemPrompt: string;
}): Promise<{
    filePath?: string;
    cleanup: () => Promise<void>;
}>;
export declare function prepareCliPromptImagePayload(params: {
    backend: CliBackendConfig;
    prompt: string;
    workspaceDir: string;
    images?: ImageContent[];
}): Promise<{
    prompt: string;
    imagePaths?: string[];
    cleanupImages?: () => Promise<void>;
}>;
export declare function buildCliArgs(params: {
    backend: CliBackendConfig;
    baseArgs: string[];
    modelId: string;
    sessionId?: string;
    systemPrompt?: string | null;
    systemPromptFilePath?: string;
    imagePaths?: string[];
    promptArg?: string;
    useResume: boolean;
}): string[];
