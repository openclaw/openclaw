type SubagentDeliveryPath = "queued" | "steered" | "direct" | "direct-fallback" | "direct-thread-fallback" | "none";
type SubagentAnnounceQueueOutcome = "steered" | "queued" | "none" | "dropped";
export type SubagentAnnounceDeliveryResult = {
    delivered: boolean;
    path: SubagentDeliveryPath;
    error?: string;
    phases?: SubagentAnnounceDispatchPhaseResult[];
};
type SubagentAnnounceDispatchPhase = "queue-primary" | "direct-primary" | "queue-fallback";
type SubagentAnnounceDispatchPhaseResult = {
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
export {};
