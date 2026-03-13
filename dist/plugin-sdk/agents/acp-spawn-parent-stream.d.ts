export declare function resolveAcpSpawnStreamLogPath(params: {
    childSessionKey: string;
}): string | undefined;
export declare function startAcpSpawnParentStreamRelay(params: {
    runId: string;
    parentSessionKey: string;
    childSessionKey: string;
    agentId: string;
    logPath?: string;
    streamFlushMs?: number;
    noOutputNoticeMs?: number;
    noOutputPollMs?: number;
    maxRelayLifetimeMs?: number;
    emitStartNotice?: boolean;
}): AcpSpawnParentRelayHandle;
export type AcpSpawnParentRelayHandle = {
    dispose: () => void;
    notifyStarted: () => void;
};
