import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import type {
  OpenClawConfig,
  ProviderAuthMethod,
  ProviderRuntimeModel,
  ProviderThinkingProfile,
  ProviderWrapStreamFnContext,
} from "openclaw/plugin-sdk/plugin-entry";
import { createProviderApiKeyAuthMethod } from "openclaw/plugin-sdk/provider-auth-api-key";
import { buildOpenAICompatibleLiveProviderCatalog } from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import {
  applyModelCompatPatch,
  buildProviderReplayFamilyHooks,
} from "openclaw/plugin-sdk/provider-model-shared";
import { createDeepSeekV4OpenAICompatibleThinkingWrapper } from "openclaw/plugin-sdk/provider-stream-shared";
import { PROVIDER_LABELS } from "openclaw/plugin-sdk/provider-usage";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  applyXiaomiConnectionConfig,
  applyXiaomiTokenPlanConfig,
  XIAOMI_DEFAULT_MODEL_REF,
  XIAOMI_TOKEN_PLAN_DEFAULT_MODEL_REF,
} from "./onboard.js";
import {
  buildXiaomiProvider,
  buildXiaomiTokenPlanProvider,
  XIAOMI_PROVIDER_ID,
  XIAOMI_TOKEN_PLAN_PROVIDER_ID,
  type XiaomiTokenPlanRegion,
} from "./provider-catalog.js";
import { buildXiaomiSpeechProvider } from "./speech-provider.js";

const PAYG_FLAG_NAME = "--xiaomi-api-key";
const PAYG_OPTION_KEY = "xiaomiApiKey";
const PAYG_ENV_VAR = "XIAOMI_API_KEY";
const TOKEN_PLAN_FLAG_NAME = "--xiaomi-token-plan-api-key";
const TOKEN_PLAN_OPTION_KEY = "xiaomiTokenPlanApiKey";
const TOKEN_PLAN_ENV_VAR = "XIAOMI_TOKEN_PLAN_API_KEY";
const XIAOMI_WIZARD_GROUP = {
  groupId: "xiaomi",
  groupLabel: "Xiaomi",
  groupHint: "Pay-as-you-go / Token Plan",
};
const MIMO_REASONING_MODEL_IDS = new Set([
  "mimo-v2.5",
  "mimo-v2.5-pro",
  "mimo-v2.6-flash",
  "mimo-v2.6-pro",
  "mimo-v2.6-pro-ultraspeed",
]);

const MIMO_THINKING_PROFILE = {
  levels: (["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const).map((id) => ({
    id,
  })),
  defaultLevel: "high",
} satisfies ProviderThinkingProfile;

const XIAOMI_PROVIDER_HOOKS = {
  ...buildProviderReplayFamilyHooks({
    family: "openai-compatible",
    dropReasoningFromHistory: false,
  }),
  normalizeResolvedModel: ({ model }: { model: ProviderRuntimeModel }) =>
    applyModelCompatPatch(model, { omitEmptyArrayItems: true }),
  wrapStreamFn: (ctx: ProviderWrapStreamFnContext) =>
    createDeepSeekV4OpenAICompatibleThinkingWrapper({
      baseStreamFn: ctx.streamFn,
      thinkingLevel: ctx.thinkingLevel,
      shouldPatchModel: (model) =>
        (model.provider === XIAOMI_PROVIDER_ID ||
          model.provider === XIAOMI_TOKEN_PLAN_PROVIDER_ID) &&
        MIMO_REASONING_MODEL_IDS.has(model.id.toLowerCase()),
    }),
  resolveThinkingProfile: ({ modelId }: { modelId: string }) =>
    MIMO_REASONING_MODEL_IDS.has(modelId.toLowerCase()) ? MIMO_THINKING_PROFILE : undefined,
  isModernModelRef: ({ modelId }: { modelId: string }) =>
    MIMO_REASONING_MODEL_IDS.has(modelId.toLowerCase()),
};

function assertCompatibleXiaomiKey(actualKey: string, expectedKind: "payg" | "token-plan"): void {
  const normalized = actualKey.trim().toLowerCase();
  const expectedPrefix = expectedKind === "payg" ? "sk-" : "tp-";
  const kindLabel = expectedKind === "payg" ? "pay-as-you-go" : "Token Plan";

  if (normalized.startsWith(expectedPrefix)) {
    return;
  }
  if (expectedKind === "payg" && normalized.startsWith("tp-")) {
    throw new Error(
      "This looks like a Xiaomi MiMo Token Plan key (tp-...). " +
        "Re-run onboarding with one of: --auth-choice xiaomi-token-plan-cn, " +
        "--auth-choice xiaomi-token-plan-sgp, or --auth-choice xiaomi-token-plan-ams.",
    );
  }
  if (expectedKind === "token-plan" && normalized.startsWith("sk-")) {
    throw new Error(
      "This looks like a Xiaomi MiMo pay-as-you-go key (sk-...). " +
        `Re-run onboarding with --auth-choice xiaomi-api-key or pass ${PAYG_FLAG_NAME}.`,
    );
  }
  throw new Error(
    `Xiaomi MiMo ${kindLabel} keys must start with "${expectedPrefix}". ` +
      "The entered key does not match the expected format.",
  );
}

function createXiaomiApiKeyAuthMethod(region?: XiaomiTokenPlanRegion): ProviderAuthMethod {
  const regionLabel = region === "ams" ? "Europe" : region === "cn" ? "China" : "Singapore";
  const choiceLabel = region
    ? `Xiaomi Token Plan (${regionLabel})`
    : "Xiaomi API key (Pay-as-you-go)";
  const choiceHint = region
    ? `Endpoint preset: token-plan-${region}.xiaomimimo.com/v1`
    : "Endpoint: api.xiaomimimo.com/v1";
  const auth = region
    ? ({
        providerId: XIAOMI_TOKEN_PLAN_PROVIDER_ID,
        optionKey: TOKEN_PLAN_OPTION_KEY,
        flagName: TOKEN_PLAN_FLAG_NAME,
        envVar: TOKEN_PLAN_ENV_VAR,
        promptMessage: `Enter Xiaomi MiMo Token Plan API key (tp-...) for ${regionLabel}`,
        expectedKind: "token-plan",
        defaultModel: XIAOMI_TOKEN_PLAN_DEFAULT_MODEL_REF,
        applyConfig: (cfg: OpenClawConfig) => applyXiaomiTokenPlanConfig(cfg, region),
      } as const)
    : ({
        providerId: XIAOMI_PROVIDER_ID,
        optionKey: PAYG_OPTION_KEY,
        flagName: PAYG_FLAG_NAME,
        envVar: PAYG_ENV_VAR,
        promptMessage: "Enter Xiaomi MiMo API key (pay-as-you-go, sk-...)",
        expectedKind: "payg",
        defaultModel: XIAOMI_DEFAULT_MODEL_REF,
        applyConfig: applyXiaomiConnectionConfig,
      } as const);
  return createProviderApiKeyAuthMethod({
    providerId: auth.providerId,
    methodId: region ? `token-plan-${region}` : "api-key",
    label: choiceLabel,
    hint: choiceHint,
    optionKey: auth.optionKey,
    flagName: auth.flagName,
    envVar: auth.envVar,
    promptMessage: auth.promptMessage,
    defaultModel: auth.defaultModel,
    applyConfig: auth.applyConfig,
    validateApiKey: (key) => {
      assertCompatibleXiaomiKey(key, auth.expectedKind);
      return undefined;
    },
    wizard: {
      choiceId: region ? `xiaomi-token-plan-${region}` : "xiaomi-api-key",
      choiceLabel,
      choiceHint,
      ...XIAOMI_WIZARD_GROUP,
    },
  });
}

export default definePluginEntry({
  id: XIAOMI_PROVIDER_ID,
  name: "Xiaomi Provider",
  description: "Xiaomi provider plugin",
  register(api) {
    for (const provider of [
      {
        id: XIAOMI_PROVIDER_ID,
        label: "Xiaomi",
        envVar: PAYG_ENV_VAR,
        auth: () => [createXiaomiApiKeyAuthMethod()],
        buildProvider: buildXiaomiProvider,
        displayName: PROVIDER_LABELS.xiaomi,
        requiresRegion: false,
      },
      {
        id: XIAOMI_TOKEN_PLAN_PROVIDER_ID,
        label: "Xiaomi Token Plan",
        envVar: TOKEN_PLAN_ENV_VAR,
        auth: () => (["ams", "cn", "sgp"] as const).map(createXiaomiApiKeyAuthMethod),
        buildProvider: buildXiaomiTokenPlanProvider,
        displayName: "Xiaomi MiMo Token Plan",
        requiresRegion: true,
      },
    ]) {
      api.registerProvider({
        id: provider.id,
        label: provider.label,
        docsPath: "/providers/xiaomi",
        envVars: [provider.envVar],
        auth: provider.auth(),
        catalog: {
          order: "simple",
          run: async (ctx) => {
            const auth = ctx.resolveProviderApiKey(provider.id);
            if (!auth.apiKey) {
              return null;
            }
            const explicitBaseUrl = normalizeOptionalString(
              ctx.config.models?.providers?.[provider.id]?.baseUrl,
            );
            if (provider.requiresRegion && !explicitBaseUrl) {
              return null;
            }
            return await buildOpenAICompatibleLiveProviderCatalog({
              discoveryMode: "strict",
              providerId: provider.id,
              providerConfig: {
                ...provider.buildProvider(),
                ...(explicitBaseUrl ? { baseUrl: explicitBaseUrl } : {}),
              },
              apiKey: auth.apiKey,
              discoveryApiKey: auth.discoveryApiKey,
              profileId: auth.profileId,
            });
          },
        },
        staticCatalog: {
          order: "simple",
          run: async () => ({ provider: provider.buildProvider() }),
        },
        ...XIAOMI_PROVIDER_HOOKS,
        resolveUsageAuth: async (ctx) => {
          const apiKey = (
            await ctx.resolveApiKeyCandidatesFromConfigAndStore?.({
              providerIds: [provider.id],
              envDirect: [ctx.env[provider.envVar]],
            })
          )?.[0];
          return apiKey ? { token: apiKey } : null;
        },
        fetchUsageSnapshot: async () => ({
          provider: provider.id,
          displayName: provider.displayName,
          windows: [],
        }),
      });
    }

    api.registerSpeechProvider(buildXiaomiSpeechProvider());
  },
});
