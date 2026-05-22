import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { ThinkLevel, VerboseLevel } from "../../auto-reply/thinking.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveMessageChannel } from "../../utils/message-channel.js";
import { type EmbeddedPiRunResult } from "../pi-embedded.js";
import { buildWorkspaceSkillSnapshot } from "../skills.js";
import { resolveAgentRunContext } from "./run-context.js";
import type { AgentCommandOpts } from "./types.js";
export { createAcpVisibleTextAccumulator, sessionFileHasContent, } from "./attempt-execution.helpers.js";
export declare function persistAcpTurnTranscript(params: {
    body: string;
    transcriptBody?: string;
    finalText: string;
    sessionId: string;
    sessionKey: string;
    sessionEntry: SessionEntry | undefined;
    sessionStore?: Record<string, SessionEntry>;
    storePath?: string;
    sessionAgentId: string;
    threadId?: string | number;
    sessionCwd: string;
    config: OpenClawConfig;
}): Promise<SessionEntry | undefined>;
export declare function persistCliTurnTranscript(params: {
    body: string;
    transcriptBody?: string;
    result: EmbeddedPiRunResult;
    sessionId: string;
    sessionKey: string;
    sessionEntry: SessionEntry | undefined;
    sessionStore?: Record<string, SessionEntry>;
    storePath?: string;
    sessionAgentId: string;
    threadId?: string | number;
    sessionCwd: string;
    config: OpenClawConfig;
}): Promise<SessionEntry | undefined>;
export declare function runAgentAttempt(params: {
    providerOverride: string;
    modelOverride: string;
    originalProvider: string;
    cfg: OpenClawConfig;
    sessionEntry: SessionEntry | undefined;
    sessionId: string;
    sessionKey: string | undefined;
    sessionAgentId: string;
    sessionFile: string;
    workspaceDir: string;
    body: string;
    isFallbackRetry: boolean;
    resolvedThinkLevel: ThinkLevel;
    fastMode?: boolean;
    timeoutMs: number;
    runId: string;
    opts: AgentCommandOpts & {
        senderIsOwner: boolean;
    };
    runContext: ReturnType<typeof resolveAgentRunContext>;
    spawnedBy: string | undefined;
    messageChannel: ReturnType<typeof resolveMessageChannel>;
    skillsSnapshot: ReturnType<typeof buildWorkspaceSkillSnapshot> | undefined;
    resolvedVerboseLevel: VerboseLevel | undefined;
    agentDir: string;
    onAgentEvent: (evt: {
        stream: string;
        data?: Record<string, unknown>;
        sessionKey?: string;
    }) => void;
    authProfileProvider: string;
    sessionStore?: Record<string, SessionEntry>;
    storePath?: string;
    allowTransientCooldownProbe?: boolean;
    modelFallbacksOverride?: string[];
    sessionHasHistory?: boolean;
    suppressPromptPersistenceOnRetry?: boolean;
    onUserMessagePersisted?: (message: Extract<AgentMessage, {
        role: "user";
    }>) => void;
}): Promise<EmbeddedPiRunResult>;
export declare function buildAcpResult(params: {
    payloadText: string;
    startedAt: number;
    stopReason?: string;
    abortSignal?: AbortSignal;
}): {
    payloads: import("../../auto-reply/reply-payload.ts").ReplyPayload[];
    meta: {
        durationMs: number;
        aborted: boolean;
        stopReason: string | undefined;
    };
};
export declare function emitAcpLifecycleStart(params: {
    runId: string;
    startedAt: number;
}): void;
export declare function emitAcpLifecycleEnd(params: {
    runId: string;
}): void;
export declare function emitAcpLifecycleError(params: {
    runId: string;
    message: string;
}): void;
export declare function emitAcpAssistantDelta(params: {
    runId: string;
    text: string;
    delta: string;
}): void;
