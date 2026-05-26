import { type PairLoopGuardConfig, type PairLoopGuardResult, type PairLoopGuardSnapshotEntry } from "../../plugin-sdk/pair-loop-guard-runtime.js";
export type ChannelBotLoopProtectionFacts = {
    scopeId: string;
    conversationId: string;
    senderId: string;
    receiverId: string;
    config?: PairLoopGuardConfig;
    defaultsConfig?: PairLoopGuardConfig;
    defaultEnabled: boolean;
    nowMs?: number;
};
export declare function recordChannelBotPairLoopAndCheckSuppression(params: ChannelBotLoopProtectionFacts): PairLoopGuardResult;
export declare function clearChannelBotPairLoopGuardForTests(): void;
export declare function listTrackedChannelBotPairsForTests(): PairLoopGuardSnapshotEntry[];
