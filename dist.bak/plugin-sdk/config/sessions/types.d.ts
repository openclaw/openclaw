import type { Skill } from "@mariozechner/pi-coding-agent";
import type { ChatType } from "../../channels/chat-type.js";
import type { ChannelId } from "../../channels/plugins/types.js";
import type { DeliveryContext } from "../../utils/delivery-context.js";
import type { TtsAutoMode } from "../types.tts.js";
export type SessionScope = "per-sender" | "global";
export type SessionChannelId = ChannelId | "webchat";
export type SessionChatType = ChatType;
export type SessionOrigin = {
    label?: string;
    provider?: string;
    surface?: string;
    chatType?: SessionChatType;
    from?: string;
    to?: string;
    accountId?: string;
    threadId?: string | number;
};
export type SessionAcpIdentitySource = "ensure" | "status" | "event";
export type SessionAcpIdentityState = "pending" | "resolved";
export type SessionAcpIdentity = {
    state: SessionAcpIdentityState;
    acpxRecordId?: string;
    acpxSessionId?: string;
    agentSessionId?: string;
    source: SessionAcpIdentitySource;
    lastUpdatedAt: number;
};
export type SessionAcpMeta = {
    backend: string;
    agent: string;
    runtimeSessionName: string;
    identity?: SessionAcpIdentity;
    mode: "persistent" | "oneshot";
    runtimeOptions?: AcpSessionRuntimeOptions;
    cwd?: string;
    state: "idle" | "running" | "error";
    lastActivityAt: number;
    lastError?: string;
};
export type AcpSessionRuntimeOptions = {
    /**
     * ACP runtime mode set via session/set_mode (for example: "plan", "normal", "auto").
     */
    runtimeMode?: string;
    /** ACP runtime config option: model id. */
    model?: string;
    /** Working directory override for ACP session turns. */
    cwd?: string;
    /** ACP runtime config option: permission profile id. */
    permissionProfile?: string;
    /** ACP runtime config option: per-turn timeout in seconds. */
    timeoutSeconds?: number;
    /** Backend-specific option bag mapped through session/set_config_option. */
    backendExtras?: Record<string, string>;
};
export type SessionEntry = {
    /**
     * Last delivered heartbeat payload (used to suppress duplicate heartbeat notifications).
     * Stored on the main session entry.
     */
    lastHeartbeatText?: string;
    /** Timestamp (ms) when lastHeartbeatText was delivered. */
    lastHeartbeatSentAt?: number;
    sessionId: string;
    updatedAt: number;
    sessionFile?: string;
    /** Parent session key that spawned this session (used for sandbox session-tool scoping). */
    spawnedBy?: string;
    /** True after a thread/topic session has been forked from its parent transcript once. */
    forkedFromParent?: boolean;
    /** Subagent spawn depth (0 = main, 1 = sub-agent, 2 = sub-sub-agent). */
    spawnDepth?: number;
    systemSent?: boolean;
    abortedLastRun?: boolean;
    /**
     * Session-level stop cutoff captured when /stop is received.
     * Messages at/before this boundary are skipped to avoid replaying
     * queued pre-stop backlog.
     */
    abortCutoffMessageSid?: string;
    /** Epoch ms cutoff paired with abortCutoffMessageSid when available. */
    abortCutoffTimestamp?: number;
    chatType?: SessionChatType;
    thinkingLevel?: string;
    verboseLevel?: string;
    reasoningLevel?: string;
    elevatedLevel?: string;
    ttsAuto?: TtsAutoMode;
    execHost?: string;
    execSecurity?: string;
    execAsk?: string;
    execNode?: string;
    responseUsage?: "on" | "off" | "tokens" | "full";
    providerOverride?: string;
    modelOverride?: string;
    authProfileOverride?: string;
    authProfileOverrideSource?: "auto" | "user";
    authProfileOverrideCompactionCount?: number;
    groupActivation?: "mention" | "always";
    groupActivationNeedsSystemIntro?: boolean;
    sendPolicy?: "allow" | "deny";
    queueMode?: "steer" | "followup" | "collect" | "steer-backlog" | "steer+backlog" | "queue" | "interrupt";
    queueDebounceMs?: number;
    queueCap?: number;
    queueDrop?: "old" | "new" | "summarize";
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    /**
     * Whether totalTokens reflects a fresh context snapshot for the latest run.
     * Undefined means legacy/unknown freshness; false forces consumers to treat
     * totalTokens as stale/unknown for context-utilization displays.
     */
    totalTokensFresh?: boolean;
    cacheRead?: number;
    cacheWrite?: number;
    modelProvider?: string;
    model?: string;
    /**
     * Last selected/runtime model pair for which a fallback notice was emitted.
     * Used to avoid repeating the same fallback notice every turn.
     */
    fallbackNoticeSelectedModel?: string;
    fallbackNoticeActiveModel?: string;
    fallbackNoticeReason?: string;
    contextTokens?: number;
    compactionCount?: number;
    memoryFlushAt?: number;
    memoryFlushCompactionCount?: number;
    cliSessionIds?: Record<string, string>;
    claudeCliSessionId?: string;
    label?: string;
    displayName?: string;
    channel?: string;
    groupId?: string;
    subject?: string;
    groupChannel?: string;
    space?: string;
    origin?: SessionOrigin;
    deliveryContext?: DeliveryContext;
    lastChannel?: SessionChannelId;
    lastTo?: string;
    lastAccountId?: string;
    lastThreadId?: string | number;
    skillsSnapshot?: SessionSkillSnapshot;
    systemPromptReport?: SessionSystemPromptReport;
    acp?: SessionAcpMeta;
};
export declare function normalizeSessionRuntimeModelFields(entry: SessionEntry): SessionEntry;
export declare function setSessionRuntimeModel(entry: SessionEntry, runtime: {
    provider: string;
    model: string;
}): boolean;
export declare function mergeSessionEntry(existing: SessionEntry | undefined, patch: Partial<SessionEntry>): SessionEntry;
export declare function resolveFreshSessionTotalTokens(entry?: Pick<SessionEntry, "totalTokens" | "totalTokensFresh"> | null): number | undefined;
export declare function isSessionTotalTokensFresh(entry?: Pick<SessionEntry, "totalTokens" | "totalTokensFresh"> | null): boolean;
export type GroupKeyResolution = {
    key: string;
    channel?: string;
    id?: string;
    chatType?: SessionChatType;
};
export type SessionSkillSnapshot = {
    prompt: string;
    skills: Array<{
        name: string;
        primaryEnv?: string;
        requiredEnv?: string[];
    }>;
    /** Normalized agent-level filter used to build this snapshot; undefined means unrestricted. */
    skillFilter?: string[];
    resolvedSkills?: Skill[];
    version?: number;
};
export type SessionSystemPromptReport = {
    source: "run" | "estimate";
    generatedAt: number;
    sessionId?: string;
    sessionKey?: string;
    provider?: string;
    model?: string;
    workspaceDir?: string;
    bootstrapMaxChars?: number;
    bootstrapTotalMaxChars?: number;
    sandbox?: {
        mode?: string;
        sandboxed?: boolean;
    };
    systemPrompt: {
        chars: number;
        projectContextChars: number;
        nonProjectContextChars: number;
    };
    injectedWorkspaceFiles: Array<{
        name: string;
        path: string;
        missing: boolean;
        rawChars: number;
        injectedChars: number;
        truncated: boolean;
    }>;
    skills: {
        promptChars: number;
        entries: Array<{
            name: string;
            blockChars: number;
        }>;
    };
    tools: {
        listChars: number;
        schemaChars: number;
        entries: Array<{
            name: string;
            summaryChars: number;
            schemaChars: number;
            propertiesCount?: number | null;
        }>;
    };
};
export declare const DEFAULT_RESET_TRIGGER = "/new";
export declare const DEFAULT_RESET_TRIGGERS: string[];
export declare const DEFAULT_IDLE_MINUTES = 60;
