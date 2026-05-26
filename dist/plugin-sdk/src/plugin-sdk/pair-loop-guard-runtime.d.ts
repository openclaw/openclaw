export type PairLoopGuardSettings = {
    enabled: boolean;
    maxEventsPerWindow: number;
    windowMs: number;
    cooldownMs: number;
};
export type PairLoopGuardConfig = {
    enabled?: boolean;
    maxEventsPerWindow?: number;
    windowSeconds?: number;
    cooldownSeconds?: number;
};
export type PairLoopGuardResult = {
    suppressed: false;
} | {
    suppressed: true;
    cooldownUntilMs: number;
};
export type PairLoopGuardSnapshotEntry = {
    key: string;
    recentCount: number;
    cooldownUntilMs: number;
};
export type PairLoopGuard = {
    recordAndCheck: (params: {
        scopeId: string;
        conversationId: string;
        senderId: string;
        receiverId: string;
        settings: PairLoopGuardSettings;
        nowMs?: number;
    }) => PairLoopGuardResult;
    clear: () => void;
    snapshot: () => PairLoopGuardSnapshotEntry[];
};
export declare const DEFAULT_PAIR_LOOP_GUARD_CONFIG: Required<PairLoopGuardConfig>;
export declare const DEFAULT_PAIR_LOOP_GUARD_SETTINGS: PairLoopGuardSettings;
export declare function mergePairLoopGuardConfig(...configs: Array<PairLoopGuardConfig | undefined>): PairLoopGuardConfig | undefined;
export declare function resolvePairLoopGuardSettings(params: {
    config?: PairLoopGuardConfig;
    defaultsConfig?: PairLoopGuardConfig;
    defaultEnabled: boolean;
}): PairLoopGuardSettings;
export declare function createPairLoopGuard(params?: {
    pruneIntervalMs?: number;
}): PairLoopGuard;
