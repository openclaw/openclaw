import type { DiscordMessagePreflightContext } from "./message-handler.preflight.js";
type DiscordMessageProcessObserver = {
    onFinalReplyStart?: () => void;
    onFinalReplyDelivered?: () => void;
    onReplyPlanResolved?: (params: {
        createdThreadId?: string;
        sessionKey?: string;
    }) => void;
};
export declare function processDiscordMessage(ctx: DiscordMessagePreflightContext, observer?: DiscordMessageProcessObserver): Promise<void>;
export {};
