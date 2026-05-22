import type { DiscordMessagePreflightContext } from "./message-handler.preflight.js";
import { type DiscordMediaInfo } from "./message-utils.js";
export declare function buildDiscordMessageProcessContext(params: {
    ctx: DiscordMessagePreflightContext;
    text: string;
    mediaList: DiscordMediaInfo[];
}): Promise<{
    ctxPayload: import("openclaw/plugin-sdk/channel-inbound").BuiltChannelInboundEventContext;
    persistedSessionKey: string;
    turn: {
        storePath: string;
        record: {
            updateLastRoute: {
                sessionKey: string;
                channel: string;
                to: string;
                accountId: string;
                mainDmOwnerPin: {
                    ownerRecipient: string;
                    senderRecipient: string;
                    onSkip: ({ ownerRecipient, senderRecipient, }: {
                        ownerRecipient: string;
                        senderRecipient: string;
                    }) => void;
                } | undefined;
            };
            onRecordError: (err: unknown) => void;
        };
    };
    replyPlan: import("./threading.types.ts").DiscordAutoThreadReplyPlan;
    deliverTarget: string;
    replyTarget: string;
    replyReference: import("../../../../dist/plugin-sdk/src/auto-reply/reply/reply-reference.js").ReplyReferencePlanner;
} | null>;
