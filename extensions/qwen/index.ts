import { createProviderApiKeyAuthMethod } from "openclaw/plugin-sdk/provider-auth-api-key";
import { buildOpenAICompatibleLiveProviderCatalog } from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import {
  defineSingleProviderPluginEntry,
  type SingleProviderPluginApiKeyAuthOptions,
} from "openclaw/plugin-sdk/provider-entry";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import { classifyQwenFailoverReason } from "./failover.js";
import { buildQwenMediaUnderstandingProvider } from "./media-understanding-provider.js";
import {
  isQwen38ModelId,
  isQwenCodingPlanBaseUrl,
  isQwenStandardOnlyModelId,
  isQwenTokenPlanDeepSeekV4ModelId,
  isQwenTokenPlanGlmModelId,
  isQwenTokenPlanThinkingOnlyModelId,
  QWEN_BASE_URL,
  QWEN_DEFAULT_MODEL_REF,
  QWEN_TOKEN_PLAN_DEFAULT_MODEL_REF,
  QWEN_TOKEN_PLAN_LEGACY_PROVIDER_ID,
  QWEN_TOKEN_PLAN_PROVIDER_ID,
  supportsQwenTokenPlanGlmMaxThinking,
} from "./models.js";
import {
  applyQwenConfig,
  applyQwenConfigCn,
  applyQwenStandardConfig,
  applyQwenStandardConfigCn,
  applyQwenTokenPlanConfig,
} from "./onboard.js";
import { buildQwenProvider, buildQwenTokenPlanProvider } from "./provider-catalog.js";
import { wrapQwenProviderStream } from "./stream.js";
import { qwenVideoGenerationProvider } from "./video-generation-provider.js";

const PROVIDER_ID = "qwen";
const LEGACY_PROVIDER_ID = "modelstudio";
const QWEN_TOKEN_PLAN_THINKING_LEVEL_IDS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;
const QWEN_TOKEN_PLAN_GLM_NO_MAX_THINKING_LEVEL_IDS = QWEN_TOKEN_PLAN_THINKING_LEVEL_IDS.filter(
  (id) => id !== "max",
);

function resolveConfiguredQwenBaseUrl(
  config: { models?: { providers?: Record<string, { baseUrl?: string } | undefined> } } | undefined,
  providerIds: readonly string[],
): string | undefined {
  for (const [providerId, provider] of Object.entries(config?.models?.providers ?? {})) {
    if (!providerIds.includes(normalizeLowercaseStringOrEmpty(providerId))) {
      continue;
    }
    const baseUrl = provider?.baseUrl?.trim();
    if (baseUrl) {
      return baseUrl;
    }
  }
  return undefined;
}

function createQwenAuthMethod(
  plan: "standard" | "coding",
  region: "global" | "cn",
): SingleProviderPluginApiKeyAuthOptions {
  const isStandard = plan === "standard";
  const isCn = region === "cn";
  const regionLabel = isCn ? "China" : "Global/Intl";
  const planLabel = isStandard ? "Standard" : "Coding Plan";
  const host = isStandard
    ? isCn
      ? "dashscope.aliyuncs.com"
      : "dashscope-intl.aliyuncs.com"
    : isCn
      ? "coding.dashscope.aliyuncs.com"
      : "coding-intl.dashscope.aliyuncs.com";
  const standardKey = isStandard ? "Standard" : "";
  const standardFlag = isStandard ? "standard-" : "";
  return {
    methodId: `${standardFlag}api-key${isCn ? "-cn" : ""}`,
    label: `${planLabel} API Key for ${regionLabel} (${isStandard ? "pay-as-you-go" : "subscription"})`,
    hint: `Endpoint: ${host}`,
    optionKey: `modelstudio${standardKey}ApiKey${isCn ? "Cn" : ""}`,
    flagName: `--modelstudio-${standardFlag}api-key${isCn ? "-cn" : ""}`,
    envVar: "QWEN_API_KEY",
    promptMessage: isStandard
      ? `Enter Qwen Cloud API key (${regionLabel} standard endpoint)`
      : `Enter Qwen Cloud Coding Plan API key (${regionLabel})`,
    defaultModel: QWEN_DEFAULT_MODEL_REF,
    applyConfig: isStandard
      ? isCn
        ? applyQwenStandardConfigCn
        : applyQwenStandardConfig
      : isCn
        ? applyQwenConfigCn
        : applyQwenConfig,
    noteMessage: [
      "Manage API keys: https://home.qwencloud.com/api-keys",
      "Docs: https://docs.qwencloud.com/",
      `Endpoint: ${host}${isStandard ? "/compatible-mode/v1" : ""}`,
      isStandard
        ? "Models: qwen3.8-max, qwen3.8-flash, qwen3.7-plus, and other discovered models."
        : "Models: qwen3.5-plus, glm-5, kimi-k2.5, MiniMax-M2.5, etc.",
    ].join("\n"),
    noteTitle: `Qwen Cloud ${planLabel} (${regionLabel})`,
    wizard: {
      choiceHint: `Endpoint: ${host}`,
      groupLabel: "Qwen Cloud",
      groupHint: "Standard / Coding Plan (CN / Global) + multimodal roadmap",
    },
  };
}

function createQwenTokenPlanAuthMethod(region: "global" | "cn") {
  const isCn = region === "cn";
  const regionLabel = isCn ? "China" : "Global/Intl";
  const host = isCn
    ? "token-plan.cn-beijing.maas.aliyuncs.com"
    : "token-plan.ap-southeast-1.maas.aliyuncs.com";
  return createProviderApiKeyAuthMethod({
    providerId: QWEN_TOKEN_PLAN_PROVIDER_ID,
    methodId: isCn ? "api-key-cn" : "api-key",
    label: `Qwen Token Plan API Key for ${regionLabel} (subscription)`,
    hint: `Endpoint: ${host}`,
    optionKey: isCn ? "qwenTokenPlanApiKeyCn" : "qwenTokenPlanApiKey",
    flagName: isCn ? "--qwen-token-plan-api-key-cn" : "--qwen-token-plan-api-key",
    envVar: "QWEN_TOKEN_PLAN_API_KEY",
    promptMessage: `Enter Alibaba Qwen Token Plan API key (${regionLabel}, sk-sp-...)`,
    defaultModel: QWEN_TOKEN_PLAN_DEFAULT_MODEL_REF,
    applyConfig: (cfg) => applyQwenTokenPlanConfig(cfg, region),
    wizard: {
      choiceId: isCn ? "qwen-token-plan-cn" : "qwen-token-plan",
      choiceLabel: `Qwen Token Plan (${regionLabel})`,
      choiceHint: `Endpoint: ${host}`,
      groupId: "qwen",
      groupLabel: "Qwen Cloud",
      groupHint: "Standard / Coding Plan / Token Plan",
    },
  });
}

function resolveQwenTokenPlanThinkingProfile(modelId: string) {
  const qwenProfile = resolveQwenThinkingProfile(modelId);
  if (qwenProfile) {
    return qwenProfile;
  }
  // Uncataloged exact refs remain selectable, so family predicates preserve their request controls.
  if (isQwenTokenPlanThinkingOnlyModelId(modelId)) {
    return {
      levels: [{ id: "low" as const, label: "on" }],
      defaultLevel: "low" as const,
      preserveWhenCatalogReasoningFalse: true,
    };
  }
  if (isQwenTokenPlanDeepSeekV4ModelId(modelId)) {
    return {
      levels: QWEN_TOKEN_PLAN_THINKING_LEVEL_IDS.map((id) => ({ id })),
      defaultLevel: "high" as const,
    };
  }
  if (isQwenTokenPlanGlmModelId(modelId)) {
    const levels = supportsQwenTokenPlanGlmMaxThinking(modelId)
      ? QWEN_TOKEN_PLAN_THINKING_LEVEL_IDS
      : QWEN_TOKEN_PLAN_GLM_NO_MAX_THINKING_LEVEL_IDS;
    return {
      levels: levels.map((id) => ({ id })),
      defaultLevel: "high" as const,
    };
  }
  return undefined;
}

function resolveQwenThinkingProfile(modelId: string) {
  return isQwen38ModelId(modelId)
    ? {
        levels: (["off", "low", "medium", "xhigh"] as const).map((id) => ({ id })),
        defaultLevel: "xhigh" as const,
      }
    : undefined;
}

export default defineSingleProviderPluginEntry({
  id: PROVIDER_ID,
  name: "Qwen Provider",
  description: "Bundled Qwen Cloud provider plugin",
  provider: {
    label: "Qwen Cloud",
    docsPath: "/providers/qwen",
    aliases: ["modelstudio", "qwencloud"],
    auth: [
      createQwenAuthMethod("standard", "cn"),
      createQwenAuthMethod("standard", "global"),
      createQwenAuthMethod("coding", "cn"),
      createQwenAuthMethod("coding", "global"),
    ],
    catalog: {
      run: async (ctx) => {
        const auth = ctx.resolveProviderApiKey(PROVIDER_ID);
        if (!auth.apiKey) {
          return null;
        }
        const baseUrl =
          resolveConfiguredQwenBaseUrl(ctx.config, [PROVIDER_ID, LEGACY_PROVIDER_ID]) ??
          QWEN_BASE_URL;
        return await buildOpenAICompatibleLiveProviderCatalog({
          discoveryMode: "strict",
          providerId: PROVIDER_ID,
          providerConfig: buildQwenProvider({ baseUrl }),
          apiKey: auth.apiKey,
          discoveryApiKey: auth.discoveryApiKey,
          profileId: auth.profileId,
        });
      },
      staticRun: async () => ({ provider: buildQwenProvider() }),
    },
    wrapStreamFn: wrapQwenProviderStream,
    wrapSimpleCompletionStreamFn: wrapQwenProviderStream,
    classifyFailoverReason: classifyQwenFailoverReason,
    resolveThinkingProfile: ({ modelId }) => resolveQwenThinkingProfile(modelId),
    normalizeConfig: ({ providerConfig }) => {
      if (!isQwenCodingPlanBaseUrl(providerConfig.baseUrl)) {
        return undefined;
      }
      const models = providerConfig.models?.filter((model) => !isQwenStandardOnlyModelId(model.id));
      return models && models.length !== providerConfig.models?.length
        ? { ...providerConfig, models }
        : undefined;
    },
  },
  register(api) {
    api.registerProvider({
      id: QWEN_TOKEN_PLAN_PROVIDER_ID,
      label: "Qwen Token Plan",
      docsPath: "/providers/qwen",
      envVars: ["QWEN_TOKEN_PLAN_API_KEY"],
      auth: [createQwenTokenPlanAuthMethod("global"), createQwenTokenPlanAuthMethod("cn")],
      catalog: {
        order: "simple",
        run: async (ctx) => {
          const auth = ctx.resolveProviderApiKey(QWEN_TOKEN_PLAN_PROVIDER_ID);
          if (!auth.apiKey) {
            return null;
          }
          const baseUrl = resolveConfiguredQwenBaseUrl(ctx.config, [QWEN_TOKEN_PLAN_PROVIDER_ID]);
          return await buildOpenAICompatibleLiveProviderCatalog({
            discoveryMode: "strict",
            providerId: QWEN_TOKEN_PLAN_PROVIDER_ID,
            providerConfig: buildQwenTokenPlanProvider({ baseUrl }),
            apiKey: auth.apiKey,
            discoveryApiKey: auth.discoveryApiKey,
            profileId: auth.profileId,
          });
        },
      },
      staticCatalog: {
        order: "simple",
        run: async () => ({
          provider: buildQwenTokenPlanProvider(),
        }),
      },
      wrapStreamFn: wrapQwenProviderStream,
      wrapSimpleCompletionStreamFn: wrapQwenProviderStream,
      classifyFailoverReason: classifyQwenFailoverReason,
      resolveThinkingProfile: ({ modelId }) => resolveQwenTokenPlanThinkingProfile(modelId),
    });
    api.registerProvider({
      id: QWEN_TOKEN_PLAN_LEGACY_PROVIDER_ID,
      label: "Alibaba Token Plan (legacy custom config)",
      docsPath: "/providers/qwen",
      auth: [],
      wrapStreamFn: wrapQwenProviderStream,
      wrapSimpleCompletionStreamFn: wrapQwenProviderStream,
      classifyFailoverReason: classifyQwenFailoverReason,
    });
    api.registerMediaUnderstandingProvider(buildQwenMediaUnderstandingProvider());
    api.registerVideoGenerationProvider(qwenVideoGenerationProvider);
  },
});
