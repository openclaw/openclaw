import type { Message } from "@grammyjs/types";
import type { TelegramContext } from "./bot/types.js";
declare const MEDIA_GROUP_TIMEOUT_MS = 500;
export type MediaGroupEntry = {
    messages: Array<{
        msg: Message;
        ctx: TelegramContext;
    }>;
    timer: ReturnType<typeof setTimeout>;
};
export type TelegramUpdateKeyContext = {
    update?: {
        update_id?: number;
        message?: Message;
        edited_message?: Message;
        channel_post?: Message;
        edited_channel_post?: Message;
    };
    update_id?: number;
    message?: Message;
    channelPost?: Message;
    editedChannelPost?: Message;
    callbackQuery?: {
        id?: string;
        message?: Message;
    };
};
export declare const resolveTelegramUpdateId: (ctx: TelegramUpdateKeyContext) => number | undefined;
export declare const buildTelegramUpdateKey: (ctx: TelegramUpdateKeyContext) => string | undefined;
export declare const createTelegramUpdateDedupe: () => import("../infra/dedupe.js").DedupeCache;
export { MEDIA_GROUP_TIMEOUT_MS };
