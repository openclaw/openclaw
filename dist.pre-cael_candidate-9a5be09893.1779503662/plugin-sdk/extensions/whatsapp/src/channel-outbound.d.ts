import { type ChannelMessageSendResult } from "openclaw/plugin-sdk/channel-message";
export declare function normalizeWhatsAppChannelPayloadText(text: string | undefined): string;
export declare const whatsappChannelOutbound: {
    deliveryMode: "direct" | "gateway" | "hybrid";
    chunker?: ((text: string, limit: number, ctx?: import("openclaw/plugin-sdk/channel-runtime").ChannelOutboundChunkContext) => string[]) | null;
    chunkerMode?: "text" | "markdown";
    textChunkLimit?: number;
    sanitizeText?: (params: {
        text: string;
        payload: import("../../../dist/plugin-sdk/src/auto-reply/reply-payload.js").ReplyPayload;
    }) => string;
    pollMaxOptions?: number;
    deliveryCapabilities?: import("openclaw/plugin-sdk/channel-runtime").ChannelDeliveryCapabilities;
    resolveTarget?: (params: {
        cfg?: import("openclaw/plugin-sdk").OpenClawConfig;
        to?: string;
        allowFrom?: string[];
        accountId?: string | null;
        mode?: import("openclaw/plugin-sdk/channel-runtime").ChannelOutboundTargetMode;
    }) => {
        ok: true;
        to: string;
    } | {
        ok: false;
        error: Error;
    };
    sendPayload?: (ctx: import("openclaw/plugin-sdk/channel-runtime").ChannelOutboundPayloadContext) => Promise<import("openclaw/plugin-sdk/outbound-runtime").OutboundDeliveryResult>;
    sendText?: (ctx: import("openclaw/plugin-sdk/channel-contract").ChannelOutboundContext) => Promise<import("openclaw/plugin-sdk/outbound-runtime").OutboundDeliveryResult>;
    sendMedia?: (ctx: import("openclaw/plugin-sdk/channel-contract").ChannelOutboundContext) => Promise<import("openclaw/plugin-sdk/outbound-runtime").OutboundDeliveryResult>;
    sendPoll?: (ctx: import("openclaw/plugin-sdk/channel-runtime").ChannelPollContext) => Promise<import("openclaw/plugin-sdk/channel-runtime").ChannelPollResult>;
    sendTextOnlyErrorPayloads: boolean;
    normalizePayload: ({ payload }: {
        payload: {
            text?: string;
        };
    }) => {
        text: string;
    };
};
export declare const whatsappMessageAdapter: {
    readonly id: "whatsapp";
    readonly durableFinal: {
        readonly capabilities: {
            readonly text: true;
            readonly replyTo: true;
            readonly messageSendingHooks: true;
        };
    };
    readonly send: {
        text: (ctx: import("openclaw/plugin-sdk/channel-message").ChannelMessageSendTextContext<import("openclaw/plugin-sdk").OpenClawConfig>) => Promise<ChannelMessageSendResult>;
    };
} & {
    receive: {};
};
