import type { SubagentLifecycleHookRunner } from "../plugins/hooks.js";
import type { InlineAttachment } from "../shared/inline-attachments.js";
import { decodeStrictBase64 } from "./subagent-attachments.js";
export { SUBAGENT_SPAWN_ACCEPTED_NOTE, SUBAGENT_SPAWN_SESSION_ACCEPTED_NOTE, } from "./subagent-spawn-accepted-note.js";
import { callGateway, forkSessionFromParent, getRuntimeConfig, ensureContextEnginesInitialized, resolveParentForkDecision, resolveContextEngine, updateSessionStore } from "./subagent-spawn.runtime.js";
import { type SpawnSubagentContextMode, type SpawnSubagentMode, type SpawnSubagentSandboxMode } from "./subagent-spawn.types.js";
export { SUBAGENT_SPAWN_CONTEXT_MODES, SUBAGENT_SPAWN_MODES, SUBAGENT_SPAWN_SANDBOX_MODES, } from "./subagent-spawn.types.js";
export type { SpawnSubagentContextMode, SpawnSubagentMode, SpawnSubagentSandboxMode, } from "./subagent-spawn.types.js";
export { decodeStrictBase64 };
type SubagentSpawnDeps = {
    callGateway: typeof callGateway;
    forkSessionFromParent: typeof forkSessionFromParent;
    getGlobalHookRunner: () => SubagentLifecycleHookRunner | null;
    getRuntimeConfig: typeof getRuntimeConfig;
    ensureContextEnginesInitialized: typeof ensureContextEnginesInitialized;
    resolveContextEngine: typeof resolveContextEngine;
    resolveParentForkDecision: typeof resolveParentForkDecision;
    updateSessionStore: typeof updateSessionStore;
};
export type SpawnSubagentParams = {
    task: string;
    label?: string;
    agentId?: string;
    model?: string;
    thinking?: string;
    runTimeoutSeconds?: number;
    thread?: boolean;
    mode?: SpawnSubagentMode;
    cleanup?: "delete" | "keep";
    sandbox?: SpawnSubagentSandboxMode;
    context?: SpawnSubagentContextMode;
    lightContext?: boolean;
    expectsCompletionMessage?: boolean;
    attachments?: InlineAttachment[];
    attachMountPath?: string;
    /** When true, sub-agent completion is delivered as a silent system event
     *  instead of a visible channel message. Used for ambient enrichment shards. */
    silentAnnounce?: boolean;
    /** When true (with silentAnnounce), the parent session is woken after the
     *  enrichment is enqueued. Enables autonomous cognition loops where the agent
     *  acts on shard returns without external nudge. */
    wakeOnReturn?: boolean;
    /** When true, the spawned sub-agent's run drains the continuation delegate queue,
     *  enabling the continue_delegate tool for chain-hop delegates. */
    drainsContinuationDelegateQueue?: boolean;
    /** Continuation return targeting for cross-session delegate enrichment. */
    continuationTargetSessionKey?: string;
    continuationTargetSessionKeys?: string[];
    continuationFanoutMode?: "tree" | "all";
    traceparent?: string;
};
export type SpawnSubagentContext = {
    agentSessionKey?: string;
    agentChannel?: string;
    agentAccountId?: string;
    agentTo?: string;
    agentThreadId?: string | number;
    agentGroupId?: string | null;
    agentGroupChannel?: string | null;
    agentGroupSpace?: string | null;
    agentMemberRoleIds?: string[];
    requesterAgentIdOverride?: string;
    /** Explicit workspace directory for subagent to inherit (optional). */
    workspaceDir?: string;
};
export type SpawnSubagentResult = {
    status: "accepted" | "forbidden" | "error";
    childSessionKey?: string;
    runId?: string;
    mode?: SpawnSubagentMode;
    note?: string;
    modelApplied?: boolean;
    error?: string;
    attachments?: {
        count: number;
        totalBytes: number;
        files: Array<{
            name: string;
            bytes: number;
            sha256: string;
        }>;
        relDir: string;
    };
};
export { splitModelRef } from "./subagent-spawn-plan.js";
export declare function spawnSubagentDirect(params: SpawnSubagentParams, ctx: SpawnSubagentContext): Promise<SpawnSubagentResult>;
export declare const __testing: {
    setDepsForTest(overrides?: Partial<SubagentSpawnDeps>): void;
};
