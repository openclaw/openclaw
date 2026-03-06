import { type Message, type UserFromGetMe } from "@grammyjs/types";
export type TelegramSequentialKeyContext = {
    chat?: {
        id?: number;
    };
    me?: UserFromGetMe;
    message?: Message;
    channelPost?: Message;
    editedChannelPost?: Message;
    update?: {
        message?: Message;
        edited_message?: Message;
        channel_post?: Message;
        edited_channel_post?: Message;
        callback_query?: {
            message?: Message;
        };
        message_reaction?: {
            chat?: {
                id?: number;
            };
        };
    };
};
export declare function getTelegramSequentialKey(ctx: TelegramSequentialKeyContext): string;
