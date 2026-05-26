//#region src/plugin-sdk/pair-loop-guard-runtime.d.ts
type PairLoopGuardSettings = {
  enabled: boolean;
  maxEventsPerWindow: number;
  windowMs: number;
  cooldownMs: number;
};
type PairLoopGuardConfig = {
  enabled?: boolean;
  maxEventsPerWindow?: number;
  windowSeconds?: number;
  cooldownSeconds?: number;
};
type PairLoopGuardResult = {
  suppressed: false;
} | {
  suppressed: true;
  cooldownUntilMs: number;
};
type PairLoopGuardSnapshotEntry = {
  key: string;
  recentCount: number;
  cooldownUntilMs: number;
};
type PairLoopGuard = {
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
declare const DEFAULT_PAIR_LOOP_GUARD_CONFIG: Required<PairLoopGuardConfig>;
declare const DEFAULT_PAIR_LOOP_GUARD_SETTINGS: PairLoopGuardSettings;
declare function mergePairLoopGuardConfig(...configs: Array<PairLoopGuardConfig | undefined>): PairLoopGuardConfig | undefined;
declare function resolvePairLoopGuardSettings(params: {
  config?: PairLoopGuardConfig;
  defaultsConfig?: PairLoopGuardConfig;
  defaultEnabled: boolean;
}): PairLoopGuardSettings;
declare function createPairLoopGuard(params?: {
  pruneIntervalMs?: number;
}): PairLoopGuard;
//#endregion
export { PairLoopGuardResult as a, createPairLoopGuard as c, PairLoopGuardConfig as i, mergePairLoopGuardConfig as l, DEFAULT_PAIR_LOOP_GUARD_SETTINGS as n, PairLoopGuardSettings as o, PairLoopGuard as r, PairLoopGuardSnapshotEntry as s, DEFAULT_PAIR_LOOP_GUARD_CONFIG as t, resolvePairLoopGuardSettings as u };