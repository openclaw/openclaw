export type LaneDeliverySnapshot = {
    delivered: boolean;
    skippedNonSilent: number;
    failedNonSilent: number;
};
export type LaneDeliveryStateTracker = {
    markDelivered: () => void;
    markNonSilentSkip: () => void;
    markNonSilentFailure: () => void;
    snapshot: () => LaneDeliverySnapshot;
};
export declare function createLaneDeliveryStateTracker(): LaneDeliveryStateTracker;
