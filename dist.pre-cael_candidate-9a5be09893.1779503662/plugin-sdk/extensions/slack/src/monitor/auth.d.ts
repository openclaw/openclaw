import { type ChannelIngressEventInput, type ChannelIngressPolicyInput, type ChannelIngressStateInput } from "openclaw/plugin-sdk/channel-ingress-runtime";
import { type SlackMonitorContext } from "./context.js";
type SlackIngressChannelType = "im" | "mpim" | "channel" | "group";
type SlackSystemEventAuthorization = {
    allowed: true;
    channelType?: SlackIngressChannelType;
    channelName?: string;
} | {
    allowed: false;
    reason: string;
    channelType?: SlackIngressChannelType;
    channelName?: string;
};
export declare function resolveSlackEffectiveAllowFrom(ctx: SlackMonitorContext, options?: {
    includePairingStore?: boolean;
}): Promise<string[]>;
export declare function clearSlackAllowFromCacheForTest(): void;
export declare function authorizeSlackBotRoomMessage(params: {
    ctx: SlackMonitorContext;
    channelId: string;
    senderId: string;
    senderName?: string;
    channelUsers?: Array<string | number>;
    allowFromLower: string[];
}): Promise<boolean>;
export declare function resolveSlackCommandIngress(params: {
    ctx: SlackMonitorContext;
    senderId: string;
    senderName?: string;
    channelType: SlackIngressChannelType;
    channelId: string;
    ownerAllowFromLower: string[];
    channelUsers?: Array<string | number>;
    allowTextCommands: boolean;
    hasControlCommand: boolean;
    mentionFacts?: ChannelIngressStateInput["mentionFacts"];
    activation?: NonNullable<ChannelIngressPolicyInput["activation"]>;
    eventKind?: ChannelIngressEventInput["kind"];
    modeWhenAccessGroupsOff?: NonNullable<ChannelIngressPolicyInput["command"]>["modeWhenAccessGroupsOff"];
}): Promise<import("openclaw/plugin-sdk/channel-ingress-runtime").ResolvedChannelMessageIngress>;
export declare function authorizeSlackSystemEventSender(params: {
    ctx: SlackMonitorContext;
    senderId?: string;
    channelId?: string;
    channelType?: string | null;
    expectedSenderId?: string;
    /** When true, requires expectedSenderId, rejects ambiguous channel types,
     *  and applies interactive-only owner allowFrom checks without changing the
     *  open-by-default channel behavior when no allowlists are configured. */
    interactiveEvent?: boolean;
}): Promise<SlackSystemEventAuthorization>;
export {};
