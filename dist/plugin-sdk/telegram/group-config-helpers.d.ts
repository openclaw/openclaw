import type { TelegramDirectConfig, TelegramGroupConfig, TelegramTopicConfig } from "../config/types.js";
export declare function resolveTelegramGroupPromptSettings(params: {
    groupConfig?: TelegramGroupConfig | TelegramDirectConfig;
    topicConfig?: TelegramTopicConfig;
}): {
    skillFilter: string[] | undefined;
    groupSystemPrompt: string | undefined;
};
