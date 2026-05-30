import type {
  TelegramAccountConfig,
  TelegramDirectConfig,
  TelegramGroupConfig,
  TelegramTopicConfig,
} from "openclaw/plugin-sdk/config-contracts";
import { firstDefined } from "./bot-access.js";

type TelegramPreviewStreamingConfig = NonNullable<TelegramAccountConfig["streaming"]>;
type TelegramUiOverrideConfig = {
  streaming?: TelegramPreviewStreamingConfig;
  ackReaction?: string | null;
};

function hasOwnConfigKey(config: object | undefined, key: string): boolean {
  return Boolean(config && Object.prototype.hasOwnProperty.call(config, key));
}

function asUiOverrideConfig(
  config: TelegramGroupConfig | TelegramDirectConfig | TelegramTopicConfig | undefined,
): TelegramUiOverrideConfig | undefined {
  return config as TelegramUiOverrideConfig | undefined;
}

export function mergeTelegramStreamingConfig(
  base: TelegramPreviewStreamingConfig | undefined,
  override: TelegramPreviewStreamingConfig | undefined,
): TelegramPreviewStreamingConfig | undefined {
  if (!override) {
    return base;
  }
  const merged: TelegramPreviewStreamingConfig = {
    ...(base ?? {}),
    ...override,
  };
  if (base?.preview || override.preview) {
    merged.preview = {
      ...(base?.preview ?? {}),
      ...(override.preview ?? {}),
    };
  }
  if (base?.progress || override.progress) {
    merged.progress = {
      ...(base?.progress ?? {}),
      ...(override.progress ?? {}),
    };
  }
  if (base?.block || override.block) {
    merged.block = {
      ...(base?.block ?? {}),
      ...(override.block ?? {}),
    };
    if (base?.block?.coalesce || override.block?.coalesce) {
      merged.block.coalesce = {
        ...(base?.block?.coalesce ?? {}),
        ...(override.block?.coalesce ?? {}),
      };
    }
  }
  return merged;
}

export function resolveTelegramEffectiveUiConfig(params: {
  accountConfig: TelegramAccountConfig;
  groupConfig?: TelegramGroupConfig | TelegramDirectConfig;
  topicConfig?: TelegramTopicConfig;
}): TelegramAccountConfig {
  const groupUi = asUiOverrideConfig(params.groupConfig);
  const topicUi = asUiOverrideConfig(params.topicConfig);
  let streaming = params.accountConfig.streaming;
  streaming = mergeTelegramStreamingConfig(streaming, groupUi?.streaming);
  streaming = mergeTelegramStreamingConfig(streaming, topicUi?.streaming);
  if (streaming === params.accountConfig.streaming) {
    return params.accountConfig;
  }
  return {
    ...params.accountConfig,
    ...(streaming !== undefined ? { streaming } : {}),
  };
}

export function resolveTelegramScopedAckReaction(params: {
  groupConfig?: TelegramGroupConfig | TelegramDirectConfig;
  topicConfig?: TelegramTopicConfig;
}): string | null | undefined {
  const topicUi = asUiOverrideConfig(params.topicConfig);
  if (hasOwnConfigKey(topicUi, "ackReaction")) {
    return topicUi?.ackReaction;
  }
  const groupUi = asUiOverrideConfig(params.groupConfig);
  if (hasOwnConfigKey(groupUi, "ackReaction")) {
    return groupUi?.ackReaction;
  }
  return undefined;
}

export function resolveTelegramGroupPromptSettings(params: {
  groupConfig?: TelegramGroupConfig | TelegramDirectConfig;
  topicConfig?: TelegramTopicConfig;
}): {
  skillFilter: string[] | undefined;
  groupSystemPrompt: string | undefined;
} {
  const skillFilter = firstDefined(params.topicConfig?.skills, params.groupConfig?.skills);
  const systemPromptParts = [
    params.groupConfig?.systemPrompt?.trim() || null,
    params.topicConfig?.systemPrompt?.trim() || null,
  ].filter((entry): entry is string => Boolean(entry));
  const groupSystemPrompt =
    systemPromptParts.length > 0 ? systemPromptParts.join("\n\n") : undefined;
  return { skillFilter, groupSystemPrompt };
}
