import type { Bot } from "grammy";
import type { OpenClawConfig } from "../config/config.js";
import type { ChannelGroupPolicy } from "../config/group-policy.js";
import type { ReplyToMode, TelegramAccountConfig, TelegramGroupConfig, TelegramTopicConfig } from "../config/types.js";
import { getChildLogger } from "../logging.js";
import type { RuntimeEnv } from "../runtime.js";
import type { TelegramMediaRef } from "./bot-message-context.js";
import { TelegramUpdateKeyContext } from "./bot-updates.js";
import { TelegramBotOptions } from "./bot.js";
import type { TelegramContext } from "./bot/types.js";
export type RegisterTelegramHandlerParams = {
    cfg: OpenClawConfig;
    accountId: string;
    bot: Bot;
    mediaMaxBytes: number;
    opts: TelegramBotOptions;
    runtime: RuntimeEnv;
    telegramCfg: TelegramAccountConfig;
    allowFrom?: Array<string | number>;
    groupAllowFrom?: Array<string | number>;
    resolveGroupPolicy: (chatId: string | number) => ChannelGroupPolicy;
    resolveTelegramGroupConfig: (chatId: string | number, messageThreadId?: number) => {
        groupConfig?: TelegramGroupConfig;
        topicConfig?: TelegramTopicConfig;
    };
    shouldSkipUpdate: (ctx: TelegramUpdateKeyContext) => boolean;
    processMessage: (ctx: TelegramContext, allMedia: TelegramMediaRef[], storeAllowFrom: string[], options?: {
        messageIdOverride?: string;
        forceWasMentioned?: boolean;
    }, replyMedia?: TelegramMediaRef[]) => Promise<void>;
    logger: ReturnType<typeof getChildLogger>;
};
type RegisterTelegramNativeCommandsParams = {
    bot: Bot;
    cfg: OpenClawConfig;
    runtime: RuntimeEnv;
    accountId: string;
    telegramCfg: TelegramAccountConfig;
    allowFrom?: Array<string | number>;
    groupAllowFrom?: Array<string | number>;
    replyToMode: ReplyToMode;
    textLimit: number;
    useAccessGroups: boolean;
    nativeEnabled: boolean;
    nativeSkillsEnabled: boolean;
    nativeDisabledExplicit: boolean;
    resolveGroupPolicy: (chatId: string | number) => ChannelGroupPolicy;
    resolveTelegramGroupConfig: (chatId: string | number, messageThreadId?: number) => {
        groupConfig?: TelegramGroupConfig;
        topicConfig?: TelegramTopicConfig;
    };
    shouldSkipUpdate: (ctx: TelegramUpdateKeyContext) => boolean;
    opts: {
        token: string;
    };
};
export declare const registerTelegramNativeCommands: ({ bot, cfg, runtime, accountId, telegramCfg, allowFrom, groupAllowFrom, replyToMode, textLimit, useAccessGroups, nativeEnabled, nativeSkillsEnabled, nativeDisabledExplicit, resolveGroupPolicy, resolveTelegramGroupConfig, shouldSkipUpdate, opts, }: RegisterTelegramNativeCommandsParams) => void;
export {};
