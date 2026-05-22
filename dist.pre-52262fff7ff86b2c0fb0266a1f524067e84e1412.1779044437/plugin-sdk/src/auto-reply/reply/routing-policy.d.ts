export declare function resolveReplyRoutingDecision(params: {
    provider?: string;
    surface?: string;
    explicitDeliverRoute?: boolean;
    originatingChannel?: string;
    originatingTo?: string;
    suppressDirectUserDelivery?: boolean;
    isRoutableChannel: (channel: string | undefined) => boolean;
}): {
    originatingChannel: string | undefined;
    currentSurface: string | undefined;
    isInternalWebchatTurn: boolean;
    shouldRouteToOriginating: boolean;
    shouldSuppressTyping: boolean;
};
