import type { Message } from "@grammyjs/types";
import type { Bot } from "grammy";
import type { DmPolicy } from "../config/types.js";
import { type NormalizedAllowFrom } from "./bot-access.js";
type TelegramDmAccessLogger = {
    info: (obj: Record<string, unknown>, msg: string) => void;
};
export declare function enforceTelegramDmAccess(params: {
    isGroup: boolean;
    dmPolicy: DmPolicy;
    msg: Message;
    chatId: number;
    effectiveDmAllow: NormalizedAllowFrom;
    accountId: string;
    bot: Bot;
    logger: TelegramDmAccessLogger;
}): Promise<boolean>;
export {};
