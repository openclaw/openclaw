type SubagentDeliveryPath = "steered" | "direct" | "none";
type SubagentAnnounceSteerOutcome = {
    status: "steered";
    deliveredAt?: number;
    enqueuedAt?: number;
} | {
    status: "none" | "dropped";
};
export type SubagentAnnounceDeliveryResult = {
    delivered: boolean;
    path: SubagentDeliveryPath;
    deliveredAt?: number;
    enqueuedAt?: number;
    error?: string;
    phases?: SubagentAnnounceDispatchPhaseResult[];
};
type SubagentAnnounceDispatchPhase = "steer-primary" | "direct-primary" | "steer-fallback";
type SubagentAnnounceDispatchPhaseResult = {
    phase: SubagentAnnounceDispatchPhase;
    delivered: boolean;
    path: SubagentDeliveryPath;
    deliveredAt?: number;
    enqueuedAt?: number;
    error?: string;
};
export declare function mapSteerOutcomeToDeliveryResult(outcome: SubagentAnnounceSteerOutcome): SubagentAnnounceDeliveryResult;
export declare function runSubagentAnnounceDispatch(params: {
    expectsCompletionMessage: boolean;
    signal?: AbortSignal;
    steer: () => Promise<SubagentAnnounceSteerOutcome>;
    direct: () => Promise<SubagentAnnounceDeliveryResult>;
}): Promise<SubagentAnnounceDeliveryResult>;
export {};
