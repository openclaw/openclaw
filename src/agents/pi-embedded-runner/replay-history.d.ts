import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { SessionManager } from "@mariozechner/pi-coding-agent";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { ProviderRuntimeModel } from "../../plugins/provider-runtime-model.types.js";
import type { TranscriptPolicy } from "../transcript-policy.js";
export declare function normalizeAssistantReplayContent(messages: AgentMessage[]): AgentMessage[];
/**
 * Applies the generic replay-history cleanup pipeline before provider-owned
 * replay hooks run.
 */
export declare function sanitizeSessionHistory(params: {
    messages: AgentMessage[];
    modelApi?: string | null;
    modelId?: string;
    provider?: string;
    allowedToolNames?: Iterable<string>;
    config?: OpenClawConfig;
    workspaceDir?: string;
    env?: NodeJS.ProcessEnv;
    model?: ProviderRuntimeModel;
    sessionManager: SessionManager;
    sessionId: string;
    policy?: TranscriptPolicy;
}): Promise<AgentMessage[]>;
/**
 * Runs provider-owned replay validation before falling back to the remaining
 * generic validator pipeline.
 */
export declare function validateReplayTurns(params: {
    messages: AgentMessage[];
    modelApi?: string | null;
    modelId?: string;
    provider?: string;
    config?: OpenClawConfig;
    workspaceDir?: string;
    env?: NodeJS.ProcessEnv;
    model?: ProviderRuntimeModel;
    sessionId?: string;
    policy?: TranscriptPolicy;
}): Promise<AgentMessage[]>;
