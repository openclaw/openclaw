export type SubagentDeliveryPath = "queued" | "steered" | "direct" | "none";
export type SubagentAnnounceQueueOutcome = "steered" | "queued" | "none";
export type SubagentAnnounceDeliveryResult = {
    delivered: boolean;
    path: SubagentDeliveryPath;
    error?: string;
    phases?: SubagentAnnounceDispatchPhaseResult[];
};
export type SubagentAnnounceDispatchPhase = "queue-primary" | "direct-primary" | "queue-fallback";
export type SubagentAnnounceDispatchPhaseResult = {
    phase: SubagentAnnounceDispatchPhase;
    delivered: boolean;
    path: SubagentDeliveryPath;
    error?: string;
};
export declare function mapQueueOutcomeToDeliveryResult(outcome: SubagentAnnounceQueueOutcome): SubagentAnnounceDeliveryResult;
export declare function runSubagentAnnounceDispatch(params: {
    expectsCompletionMessage: boolean;
    signal?: AbortSignal;
    queue: () => Promise<SubagentAnnounceQueueOutcome>;
    direct: () => Promise<SubagentAnnounceDeliveryResult>;
}): Promise<SubagentAnnounceDeliveryResult>;
