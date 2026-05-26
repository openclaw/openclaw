import { Bt as AcpRuntimeCapabilities, Gt as AcpRuntimePromptMode, Kt as AcpRuntimeSessionMode, Ut as AcpRuntimeEvent, Wt as AcpRuntimeHandle, i as OpenClawConfig, qt as AcpRuntimeStatus, zt as AcpRuntime } from "./types.openclaw-BLF4DJTX.js";
import { a as SessionAcpMeta, i as SessionAcpIdentity, t as AcpSessionRuntimeOptions } from "./types-ChLEnNVH.js";
import { i as requireAcpRuntimeBackend, n as getAcpRuntimeBackend, o as AcpRuntimeError } from "./registry-BHYtGFIq.js";
import { i as upsertAcpSessionMeta, n as listAcpSessionEntries, r as readAcpSessionEntry } from "./session-meta-DS_CKwIP.js";

//#region src/acp/control-plane/manager.types.d.ts
type AcpSessionResolution = {
  kind: "none";
  sessionKey: string;
} | {
  kind: "stale";
  sessionKey: string;
  error: AcpRuntimeError;
} | {
  kind: "ready";
  sessionKey: string;
  meta: SessionAcpMeta;
};
type AcpInitializeSessionInput = {
  cfg: OpenClawConfig;
  sessionKey: string;
  agent: string;
  mode: AcpRuntimeSessionMode;
  resumeSessionId?: string;
  runtimeOptions?: Partial<AcpSessionRuntimeOptions>;
  cwd?: string;
  backendId?: string;
};
type AcpTurnAttachment = {
  mediaType: string;
  data: string;
};
type AcpRunTurnInput = {
  cfg: OpenClawConfig;
  sessionKey: string;
  text: string;
  attachments?: AcpTurnAttachment[];
  mode: AcpRuntimePromptMode;
  requestId: string;
  signal?: AbortSignal;
  onLifecycle?: (event: AcpTurnLifecycleEvent) => Promise<void> | void;
  onEvent?: (event: AcpRuntimeEvent) => Promise<void> | void;
};
type AcpTurnLifecycleEvent = {
  type: "prompt_submitted";
  at: number;
};
type AcpCloseSessionInput = {
  cfg: OpenClawConfig;
  sessionKey: string;
  reason: string;
  discardPersistentState?: boolean;
  clearMeta?: boolean;
  allowBackendUnavailable?: boolean;
  requireAcpSession?: boolean;
};
type AcpCloseSessionResult = {
  runtimeClosed: boolean;
  runtimeNotice?: string;
  metaCleared: boolean;
};
type AcpSessionStatus = {
  sessionKey: string;
  backend: string;
  agent: string;
  identity?: SessionAcpIdentity;
  state: SessionAcpMeta["state"];
  mode: AcpRuntimeSessionMode;
  runtimeOptions: AcpSessionRuntimeOptions;
  capabilities: AcpRuntimeCapabilities;
  runtimeStatus?: AcpRuntimeStatus;
  lastActivityAt: number;
  lastError?: string;
};
type AcpManagerObservabilitySnapshot = {
  runtimeCache: {
    activeSessions: number;
    idleTtlMs: number;
    evictedTotal: number;
    lastEvictedAt?: number;
  };
  turns: {
    active: number;
    queueDepth: number;
    completed: number;
    failed: number;
    averageLatencyMs: number;
    maxLatencyMs: number;
  };
  errorsByCode: Record<string, number>;
};
type AcpStartupIdentityReconcileResult = {
  checked: number;
  resolved: number;
  failed: number;
};
type AcpSessionManagerDeps = {
  listAcpSessions: typeof listAcpSessionEntries;
  readSessionEntry: typeof readAcpSessionEntry;
  upsertSessionMeta: typeof upsertAcpSessionMeta;
  getRuntimeBackend: typeof getAcpRuntimeBackend;
  requireRuntimeBackend: typeof requireAcpRuntimeBackend;
};
//#endregion
//#region src/acp/control-plane/manager.core.d.ts
declare class AcpSessionManager {
  private readonly deps;
  private readonly actorQueue;
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
    signal?: AbortSignal;
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
  private resolveTurnTimeoutMs;
  private awaitTurnWithTimeout;
  private cleanupTimedOutTurn;
  private awaitCleanupWithGrace;
  cancelSession(params: {
    cfg: OpenClawConfig;
    sessionKey: string;
    reason?: string;
  }): Promise<void>;
  closeSession(input: AcpCloseSessionInput): Promise<AcpCloseSessionResult>;
  private ensureRuntimeHandle;
  private isCachedRuntimeHandleReusable;
  private isRuntimeStatusUnavailable;
  private persistRuntimeOptions;
  private enforceConcurrentSessionLimit;
  private recordTurnCompletion;
  private recordErrorCode;
  private prepareFreshHandleRetry;
  private isRecoverableAcpxExitError;
  private isRecoverableMissingPersistentSessionError;
  private clearPersistedRuntimeResumeState;
  private discardPersistedRuntimeState;
  private evictIdleRuntimeHandles;
  private resolveRuntimeCapabilities;
  private applyRuntimeControls;
  private setSessionState;
  private reconcileRuntimeSessionIdentifiers;
  private writeSessionMeta;
  private withSessionActor;
  private throwIfAborted;
  private getCachedRuntimeState;
  private setCachedRuntimeState;
  private clearCachedRuntimeState;
  private closeCachedRuntimeState;
  private clearCachedRuntimeStateIfHandleMatches;
  private runtimeHandlesMatch;
  private runtimeHandleMatchesMeta;
  private resolveBackgroundTaskContext;
  private createBackgroundTaskRecord;
  private markBackgroundTaskRunning;
  private markBackgroundTaskTerminal;
}
//#endregion
export { AcpManagerObservabilitySnapshot as a, AcpSessionStatus as c, AcpInitializeSessionInput as i, AcpStartupIdentityReconcileResult as l, AcpCloseSessionInput as n, AcpRunTurnInput as o, AcpCloseSessionResult as r, AcpSessionResolution as s, AcpSessionManager as t };