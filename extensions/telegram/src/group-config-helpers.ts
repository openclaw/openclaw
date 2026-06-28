// Telegram helper module supports group config helpers behavior.
import type {
  TelegramAccountConfig,
  TelegramDirectConfig,
  TelegramGroupConfig,
  TelegramTopicConfig,
} from "openclaw/plugin-sdk/config-contracts";

type SkillFilterMergeConfig = {
  add?: ReadonlyArray<unknown>;
  remove?: ReadonlyArray<unknown>;
};

type ScopedSkillConfig = {
  skills?: ReadonlyArray<unknown>;
  skillsMerge?: SkillFilterMergeConfig;
};

const topicSkillConfigChains = new WeakMap<object, readonly ScopedSkillConfig[]>();

function normalizeSkillFilter(skillFilter?: ReadonlyArray<unknown>): string[] | undefined {
  if (skillFilter === undefined) {
    return undefined;
  }
  return skillFilter
    .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
    .filter((entry): entry is string => entry.length > 0);
}

function mergeSkillFilter(
  inheritedFilter: ReadonlyArray<unknown> | undefined,
  mergeConfig: SkillFilterMergeConfig | undefined,
): string[] | undefined {
  const inherited = normalizeSkillFilter(inheritedFilter);
  if (!mergeConfig) {
    return inherited;
  }

  const add = normalizeSkillFilter(mergeConfig.add) ?? [];
  const remove = new Set(normalizeSkillFilter(mergeConfig.remove) ?? []);
  if (add.length === 0 && remove.size === 0) {
    return inherited;
  }

  const merged = (inherited ?? []).filter((skill) => !remove.has(skill));
  for (const skill of add) {
    if (!remove.has(skill) && !merged.includes(skill)) {
      merged.push(skill);
    }
  }
  return merged;
}

function resolveScopedSkillFilter(
  scopedConfig: ScopedSkillConfig | undefined,
  inheritedFilter?: ReadonlyArray<unknown>,
): string[] | undefined {
  if (scopedConfig && Object.hasOwn(scopedConfig, "skills")) {
    return normalizeSkillFilter(scopedConfig.skills);
  }
  return mergeSkillFilter(inheritedFilter, scopedConfig?.skillsMerge);
}

function resolveTopicSkillFilter(
  topicConfig: TelegramTopicConfig | undefined,
  inheritedFilter?: ReadonlyArray<unknown>,
): string[] | undefined {
  const chain = topicConfig ? topicSkillConfigChains.get(topicConfig) : undefined;
  if (!chain) {
    return resolveScopedSkillFilter(topicConfig, inheritedFilter);
  }
  return chain.reduce<string[] | undefined>(
    (filter, scopedConfig) => resolveScopedSkillFilter(scopedConfig, filter),
    normalizeSkillFilter(inheritedFilter),
  );
}

export function resolveTelegramScopedGroupConfig(
  telegramCfg: TelegramAccountConfig,
  chatId: string | number,
  messageThreadId?: number,
) {
  const resolveTopicConfig = <T extends object>(
    scopedConfig: { topics?: Record<string, T | undefined> } | undefined,
  ): T | undefined => {
    if (!scopedConfig || messageThreadId == null) {
      return undefined;
    }
    const defaultConfig = scopedConfig.topics?.["*"];
    const exactConfig = scopedConfig.topics?.[String(messageThreadId)];
    if (defaultConfig && exactConfig) {
      const mergedConfig = { ...defaultConfig, ...exactConfig };
      topicSkillConfigChains.set(mergedConfig, [defaultConfig, exactConfig]);
      return mergedConfig;
    }
    return exactConfig ?? defaultConfig;
  };
  const chatIdStr = String(chatId);
  const scopedConfigs = chatIdStr.startsWith("-") ? telegramCfg.groups : telegramCfg.direct;
  const groupConfig = scopedConfigs?.[chatIdStr] ?? scopedConfigs?.["*"];
  const topicConfig = resolveTopicConfig(groupConfig);
  return { groupConfig, topicConfig };
}

export function resolveTelegramGroupPromptSettings(params: {
  groupConfig?: TelegramGroupConfig | TelegramDirectConfig;
  topicConfig?: TelegramTopicConfig;
}): {
  skillFilter: string[] | undefined;
  groupSystemPrompt: string | undefined;
} {
  const groupSkillFilter = resolveScopedSkillFilter(params.groupConfig);
  const skillFilter = resolveTopicSkillFilter(params.topicConfig, groupSkillFilter);
  const systemPromptParts = [
    params.groupConfig?.systemPrompt?.trim() || null,
    params.topicConfig?.systemPrompt?.trim() || null,
  ].filter((entry): entry is string => Boolean(entry));
  const groupSystemPrompt =
    systemPromptParts.length > 0 ? systemPromptParts.join("\n\n") : undefined;
  return { skillFilter, groupSystemPrompt };
}
