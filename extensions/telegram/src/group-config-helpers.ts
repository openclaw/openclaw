import type {
  TelegramDirectConfig,
  TelegramGroupConfig,
  TelegramTopicConfig,
} from "openclaw/plugin-sdk/config-types";
import { firstDefined } from "./bot-access.js";

export function resolveTelegramGroupPromptSettings(params: {
  groupConfig?: TelegramGroupConfig | TelegramDirectConfig;
  topicConfig?: TelegramTopicConfig;
}): {
  skillFilter: string[] | undefined;
  groupSystemPrompt: string | undefined;
} {
  const skillFilter = firstDefined(params.topicConfig?.skills, params.groupConfig?.skills);
  const groupPrompt = params.groupConfig?.systemPrompt?.trim() || "";
  const topicPrompt = params.topicConfig?.systemPrompt?.trim() || "";
  const groupSystemPrompt =
    groupPrompt && topicPrompt
      ? `${groupPrompt}\n\n${topicPrompt}`
      : groupPrompt || topicPrompt || undefined;
  return { skillFilter, groupSystemPrompt };
}
