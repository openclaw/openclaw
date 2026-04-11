import type {
  TelegramDirectConfig,
  TelegramGroupConfig,
  TelegramTopicConfig,
} from "openclaw/plugin-sdk/config-runtime";
import { firstDefined } from "./bot-access.js";

export function resolveTelegramGroupPromptSettings(params: {
  groupConfig?: TelegramGroupConfig | TelegramDirectConfig;
  topicConfig?: TelegramTopicConfig;
  promptGroupConfig?: TelegramGroupConfig | TelegramDirectConfig;
  promptTopicConfig?: TelegramTopicConfig;
}): {
  skillFilter: string[] | undefined;
  groupSystemPrompt: string | undefined;
} {
  const groupPrompt = firstDefined(
    params.groupConfig?.systemPrompt?.trim() || undefined,
    params.promptGroupConfig?.systemPrompt?.trim() || undefined,
  );
  const topicPrompt = firstDefined(
    params.topicConfig?.systemPrompt?.trim() || undefined,
    params.promptTopicConfig?.systemPrompt?.trim() || undefined,
  );
  const skillFilter = firstDefined(
    params.topicConfig?.skills,
    params.promptTopicConfig?.skills,
    params.groupConfig?.skills,
    params.promptGroupConfig?.skills,
  );
  const systemPromptParts = [
    groupPrompt ?? null,
    topicPrompt ?? null,
  ].filter((entry): entry is string => Boolean(entry));
  const groupSystemPrompt =
    systemPromptParts.length > 0 ? systemPromptParts.join("\n\n") : undefined;
  return { skillFilter, groupSystemPrompt };
}
