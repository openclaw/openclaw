export type StuckSessionRecoveryParams = {
    sessionId?: string;
    sessionKey?: string;
    ageMs: number;
    queueDepth?: number;
    allowActiveAbort?: boolean;
};
export declare function recoverStuckDiagnosticSession(params: StuckSessionRecoveryParams): Promise<void>;
export declare const __testing: {
    resetRecoveriesInFlight(): void;
};
