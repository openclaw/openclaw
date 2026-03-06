export type HeartbeatDeliveryPayload = {
    text?: string;
    mediaUrl?: string;
    mediaUrls?: string[];
};
export declare function shouldSkipHeartbeatOnlyDelivery(payloads: HeartbeatDeliveryPayload[], ackMaxChars: number): boolean;
export declare function shouldEnqueueCronMainSummary(params: {
    summaryText: string | undefined;
    deliveryRequested: boolean;
    delivered: boolean | undefined;
    deliveryAttempted: boolean | undefined;
    suppressMainSummary: boolean;
    isCronSystemEvent: (text: string) => boolean;
}): boolean;
