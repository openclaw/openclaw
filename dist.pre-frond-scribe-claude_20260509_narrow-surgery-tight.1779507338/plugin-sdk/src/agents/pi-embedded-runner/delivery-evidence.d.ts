export type AgentDeliveryEvidence = {
    payloads?: unknown;
    deliveryStatus?: {
        status?: unknown;
        errorMessage?: unknown;
    };
    didSendViaMessagingTool?: unknown;
    messagingToolSentTexts?: unknown;
    messagingToolSentMediaUrls?: unknown;
    messagingToolSentTargets?: unknown;
    acceptedSessionSpawns?: unknown;
    successfulCronAdds?: unknown;
    meta?: {
        toolSummary?: {
            calls?: unknown;
        };
    };
};
export declare function collectDeliveredMediaUrls(result: AgentDeliveryEvidence): string[];
export declare function collectMessagingToolDeliveredMediaUrls(result: Pick<AgentDeliveryEvidence, "messagingToolSentMediaUrls" | "messagingToolSentTargets">): string[];
export declare function hasDeliveredExpectedMedia(result: AgentDeliveryEvidence, expectedMediaUrls: readonly string[]): boolean;
export declare function getGatewayAgentResult(response: unknown): AgentDeliveryEvidence | null;
export declare function hasVisibleAgentPayload(result: Pick<AgentDeliveryEvidence, "payloads">, options?: {
    includeErrorPayloads?: boolean;
    includeReasoningPayloads?: boolean;
}): boolean;
export declare function hasMessagingToolDeliveryEvidence(result: AgentDeliveryEvidence): boolean;
export declare function hasCommittedMessagingToolDeliveryEvidence(result: Pick<AgentDeliveryEvidence, "messagingToolSentTexts" | "messagingToolSentMediaUrls" | "messagingToolSentTargets">): boolean;
export declare function hasOutboundDeliveryEvidence(result: AgentDeliveryEvidence): boolean;
export declare function getAgentCommandDeliveryFailure(result: AgentDeliveryEvidence): string | undefined;
