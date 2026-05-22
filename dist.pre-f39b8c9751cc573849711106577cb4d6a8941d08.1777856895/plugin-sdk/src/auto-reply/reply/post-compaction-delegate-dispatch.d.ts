import { type SpawnSubagentContext, type SpawnSubagentParams, type SpawnSubagentResult } from "../../agents/subagent-spawn.js";
import type { SessionEntry, SessionPostCompactionDelegate } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { type SessionDeliveryRecoveryLogger } from "../../infra/session-delivery-queue-recovery.js";
import { type QueuedSessionDelivery, type SessionDeliveryContext } from "../../infra/session-delivery-queue-storage.js";
import type { ContinuationRuntimeConfig } from "../continuation/types.js";
import type { ContinuationSignal } from "../tokens.js";
import type { FollowupRun } from "./queue/types.js";
export type QueuedPostCompactionDelegateDelivery = Extract<QueuedSessionDelivery, {
    kind: "postCompactionDelegate";
}>;
export type PostCompactionDelegateSpawn = (params: SpawnSubagentParams, context: SpawnSubagentContext) => Promise<SpawnSubagentResult>;
export type PostCompactionDelegateDeliveryDeps = {
    enqueueSystemEvent(text: string, options: {
        sessionKey: string;
    }): void;
    getRuntimeConfig(): OpenClawConfig;
    loadSessionStore(storePath: string): Record<string, SessionEntry>;
    log(message: string): void;
    now(): number;
    resolveContinuationRuntimeConfig(cfg: OpenClawConfig): ContinuationRuntimeConfig;
    resolveSessionAgentId(params: {
        sessionKey?: string;
        config?: OpenClawConfig;
    }): string;
    resolveStorePath(store?: string, opts?: {
        agentId?: string;
        env?: NodeJS.ProcessEnv;
    }): string;
    spawnSubagentDirect: PostCompactionDelegateSpawn;
};
export type PostCompactionDelegateDispatchDeps = {
    consumeStagedPostCompactionDelegates(sessionKey: string): SessionPostCompactionDelegate[];
    drainPostCompactionDelegateDeliveries(params: {
        entryIds?: readonly string[];
        log: SessionDeliveryRecoveryLogger;
        sessionKey: string;
    }): Promise<void>;
    enqueuePostCompactionDelegateDelivery(params: {
        sessionKey: string;
        delegate: SessionPostCompactionDelegate;
        sequence: number;
        compactionCount?: number;
        deliveryContext?: SessionDeliveryContext;
    }): Promise<string>;
    enqueueSystemEvent(text: string, options: {
        sessionKey: string;
    }): void;
    log(message: string): void;
    now(): number;
    readPostCompactionContext(workspaceDir: string, options: {
        cfg: OpenClawConfig;
        agentId: string;
    }): Promise<string | null>;
    resolveAgentWorkspaceDir(cfg: OpenClawConfig, agentId: string): string;
    resolveContinuationRuntimeConfig(cfg: OpenClawConfig): ContinuationRuntimeConfig;
    resolveSessionAgentId(params: {
        sessionKey?: string;
        config?: OpenClawConfig;
    }): string;
};
export type DispatchPostCompactionDelegatesParams = {
    cfg: OpenClawConfig;
    compactionCount: number | undefined;
    continuationSignalKind?: ContinuationSignal["kind"];
    followupRun: FollowupRun;
    postCompactionDelegatesToPreserve: SessionPostCompactionDelegate[];
    sessionEntry?: SessionEntry;
    sessionKey: string;
    sessionStore?: Record<string, SessionEntry>;
    storePath?: string;
};
export type DispatchPostCompactionDelegatesResult = {
    queuedDelegates: number;
    droppedDelegates: number;
};
export declare const POST_COMPACTION_DELEGATE_TTL_MS: number;
export declare function normalizePostCompactionDelegate(delegate: SessionPostCompactionDelegate): SessionPostCompactionDelegate;
export declare function persistPendingPostCompactionDelegates(params: {
    sessionEntry?: SessionEntry;
    sessionStore?: Record<string, SessionEntry>;
    sessionKey: string;
    storePath?: string;
    delegates: SessionPostCompactionDelegate[];
}): Promise<SessionPostCompactionDelegate[]>;
export declare function takePendingPostCompactionDelegates(params: {
    sessionEntry?: SessionEntry;
    sessionStore?: Record<string, SessionEntry>;
    sessionKey: string;
    storePath?: string;
}): Promise<SessionPostCompactionDelegate[]>;
export declare function buildPostCompactionLifecycleEvent(params: {
    compactionCount?: number;
    /**
     * Number of delegates accepted into the persistent delivery queue this
     * dispatch. NOTE: this is the queued count (post-`enqueue` accept,
     * pre-spawn). The actual spawn happens asynchronously in the
     * fire-and-forget drain triggered after this event is emitted, so this
     * count is an upper bound on what will eventually be released into the
     * fresh session — individual queued entries may still fail to spawn
     * (their failure is recorded as a queue retry, not reflected here).
     *
     * Named `queuedDelegates` to make the semantic accurate; the previous
     * agent-runner path counted accepted
     * spawns, but the queue-extraction architecture cannot count spawns
     * synchronously without awaiting the drain. The honest name is
     * `queuedDelegates`.
     */
    queuedDelegates: number;
    droppedDelegates: number;
}): string;
export declare function deliverQueuedPostCompactionDelegate(params: {
    entry: QueuedPostCompactionDelegateDelivery;
}, deps?: PostCompactionDelegateDeliveryDeps): Promise<void>;
export declare function drainPostCompactionDelegateDeliveries(params: {
    entryIds?: readonly string[];
    log?: SessionDeliveryRecoveryLogger;
    sessionKey?: string;
    stateDir?: string;
    deliveryDeps?: PostCompactionDelegateDeliveryDeps;
}): Promise<void>;
export declare function dispatchPostCompactionDelegates(params: DispatchPostCompactionDelegatesParams, deps?: PostCompactionDelegateDispatchDeps): Promise<DispatchPostCompactionDelegatesResult>;
