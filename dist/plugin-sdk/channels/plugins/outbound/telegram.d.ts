import type { ReplyPayload } from "../../../auto-reply/types.js";
import { sendMessageTelegram } from "../../../telegram/send.js";
import type { ChannelOutboundAdapter } from "../types.js";
type TelegramSendFn = typeof sendMessageTelegram;
type TelegramSendOpts = Parameters<TelegramSendFn>[2];
export declare function sendTelegramPayloadMessages(params: {
    send: TelegramSendFn;
    to: string;
    payload: ReplyPayload;
    baseOpts: Omit<NonNullable<TelegramSendOpts>, "buttons" | "mediaUrl" | "quoteText">;
}): Promise<Awaited<ReturnType<TelegramSendFn>>>;
export declare const telegramOutbound: ChannelOutboundAdapter;
export {};
