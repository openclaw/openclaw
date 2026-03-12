import type { OpenClawConfig } from "../../config/config.js";
import type { AcpRuntime, AcpRuntimeHandle } from "../runtime/types.js";
import { type AcpCloseSessionInput, type AcpCloseSessionResult, type AcpInitializeSessionInput, type AcpManagerObservabilitySnapshot, type AcpRunTurnInput, type AcpSessionManagerDeps, type AcpSessionResolution, type AcpSessionRuntimeOptions, type AcpSessionStatus, type AcpStartupIdentityReconcileResult, type SessionAcpMeta } from "./manager.types.js";
export declare class AcpSessionManager {
    private readonly deps;
    private readonly actorQueue;
    private readonly actorTailBySession;
    private readonly runtimeCache;
    private readonly activeTurnBySession;
    private readonly turnLatencyStats;
    private readonly errorCountsByCode;
    private evictedRuntimeCount;
    private lastEvictedAt;
    constructor(deps?: AcpSessionManagerDeps);
    resolveSession(params: {
        cfg: OpenClawConfig;
        sessionKey: string;
    }): AcpSessionResolution;
    getObservabilitySnapshot(cfg: OpenClawConfig): AcpManagerObservabilitySnapshot;
    reconcilePendingSessionIdentities(params: {
        cfg: OpenClawConfig;
    }): Promise<AcpStartupIdentityReconcileResult>;
    initializeSession(input: AcpInitializeSessionInput): Promise<{
        runtime: AcpRuntime;
        handle: AcpRuntimeHandle;
        meta: SessionAcpMeta;
    }>;
    getSessionStatus(params: {
        cfg: OpenClawConfig;
        sessionKey: string;
    }): Promise<AcpSessionStatus>;
    setSessionRuntimeMode(params: {
        cfg: OpenClawConfig;
        sessionKey: string;
        runtimeMode: string;
    }): Promise<AcpSessionRuntimeOptions>;
    setSessionConfigOption(params: {
        cfg: OpenClawConfig;
        sessionKey: string;
        key: string;
        value: string;
    }): Promise<AcpSessionRuntimeOptions>;
    updateSessionRuntimeOptions(params: {
        cfg: OpenClawConfig;
        sessionKey: string;
        patch: Partial<AcpSessionRuntimeOptions>;
    }): Promise<AcpSessionRuntimeOptions>;
    resetSessionRuntimeOptions(params: {
        cfg: OpenClawConfig;
        sessionKey: string;
    }): Promise<AcpSessionRuntimeOptions>;
    runTurn(input: AcpRunTurnInput): Promise<void>;
    cancelSession(params: {
        cfg: OpenClawConfig;
        sessionKey: string;
        reason?: string;
    }): Promise<void>;
    closeSession(input: AcpCloseSessionInput): Promise<AcpCloseSessionResult>;
    private ensureRuntimeHandle;
    private persistRuntimeOptions;
    private enforceConcurrentSessionLimit;
    private recordTurnCompletion;
    private recordErrorCode;
    private evictIdleRuntimeHandles;
    private resolveRuntimeCapabilities;
    private applyRuntimeControls;
    private setSessionState;
    private reconcileRuntimeSessionIdentifiers;
    private writeSessionMeta;
    private withSessionActor;
    private getCachedRuntimeState;
    private setCachedRuntimeState;
    private clearCachedRuntimeState;
}
