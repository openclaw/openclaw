import { type SlackMonitorContext } from "./context.js";
export declare function resolveSlackEffectiveAllowFrom(ctx: SlackMonitorContext, options?: {
    includePairingStore?: boolean;
}): Promise<{
    allowFrom: string[];
    allowFromLower: string[];
}>;
export declare function isSlackSenderAllowListed(params: {
    allowListLower: string[];
    senderId: string;
    senderName?: string;
    allowNameMatching?: boolean;
}): boolean;
export type SlackSystemEventAuthResult = {
    allowed: boolean;
    reason?: "missing-sender" | "sender-mismatch" | "channel-not-allowed" | "dm-disabled" | "sender-not-allowlisted" | "sender-not-channel-allowed";
    channelType?: "im" | "mpim" | "channel" | "group";
    channelName?: string;
};
export declare function authorizeSlackSystemEventSender(params: {
    ctx: SlackMonitorContext;
    senderId?: string;
    channelId?: string;
    channelType?: string | null;
    expectedSenderId?: string;
}): Promise<SlackSystemEventAuthResult>;
