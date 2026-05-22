export declare const INTERNAL_MESSAGE_CHANNEL: "webchat";
export type InternalMessageChannel = typeof INTERNAL_MESSAGE_CHANNEL;
export declare const INTERNAL_NON_DELIVERY_CHANNELS: readonly ["heartbeat", "cron", "webhook"];
export type InternalNonDeliveryChannel = (typeof INTERNAL_NON_DELIVERY_CHANNELS)[number];
export declare function isInternalNonDeliveryChannel(value: string): value is InternalNonDeliveryChannel;
