import type { TelegramGroupConfig, TelegramTopicConfig } from "../config/types.js";
export declare function resolveTelegramGroupPromptSettings(params: {
    groupConfig?: TelegramGroupConfig;
    topicConfig?: TelegramTopicConfig;
}): {
    skillFilter: string[] | undefined;
    groupSystemPrompt: string | undefined;
};
