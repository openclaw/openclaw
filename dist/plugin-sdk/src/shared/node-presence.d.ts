export declare const NODE_PRESENCE_ALIVE_EVENT = "node.presence.alive";
declare const NODE_PRESENCE_ALIVE_REASONS: readonly ["background", "silent_push", "bg_app_refresh", "significant_location", "manual", "connect"];
export type NodePresenceAliveReason = (typeof NODE_PRESENCE_ALIVE_REASONS)[number];
export declare function normalizeNodePresenceAliveReason(value: unknown): NodePresenceAliveReason;
export {};
