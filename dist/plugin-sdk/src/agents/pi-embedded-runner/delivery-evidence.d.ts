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
    successfulCronAdds?: unknown;
    meta?: {
        toolSummary?: {
            calls?: unknown;
        };
    };
};
export declare function getGatewayAgentResult(response: unknown): AgentDeliveryEvidence | null;
export declare function hasVisibleAgentPayload(result: Pick<AgentDeliveryEvidence, "payloads">, options?: {
    includeErrorPayloads?: boolean;
    includeReasoningPayloads?: boolean;
}): boolean;
export declare function hasMessagingToolDeliveryEvidence(result: AgentDeliveryEvidence): boolean;
export declare function hasCommittedMessagingToolDeliveryEvidence(result: Pick<AgentDeliveryEvidence, "messagingToolSentTexts" | "messagingToolSentMediaUrls" | "messagingToolSentTargets">): boolean;
export declare function hasOutboundDeliveryEvidence(result: AgentDeliveryEvidence): boolean;
export declare function getAgentCommandDeliveryFailure(result: AgentDeliveryEvidence): string | undefined;
