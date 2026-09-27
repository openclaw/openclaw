import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import type {
  OpenClawConfig,
  ProviderAuthContext,
  ProviderAuthMethod,
  ProviderAuthMethodNonInteractiveContext,
  ProviderCatalogContext,
  ProviderAuthResult,
  ProviderRuntimeModel,
  ProviderWrapStreamFnContext,
} from "openclaw/plugin-sdk/plugin-entry";
import {
  applyAuthProfileConfig,
  buildApiKeyCredential,
  captureProviderApiKey,
  normalizeOptionalSecretInput,
  persistProviderApiKey,
} from "openclaw/plugin-sdk/provider-auth-api-key";
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
import { isMiMoReasoningModelRef, resolveMiMoThinkingProfile } from "./thinking.js";

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
      shouldPatchModel: isMiMoReasoningModelRef,
    }),
  resolveThinkingProfile: ({ modelId }: { modelId: string }) => resolveMiMoThinkingProfile(modelId),
  isModernModelRef: ({ modelId }: { modelId: string }) =>
    Boolean(resolveMiMoThinkingProfile(modelId)),
};

async function resolveXiaomiCatalog(params: {
  ctx: ProviderCatalogContext;
  providerId: string;
  buildProvider: () => ReturnType<typeof buildXiaomiProvider>;
  requiresRegion: boolean;
}) {
  const auth = params.ctx.resolveProviderApiKey(params.providerId);
  if (!auth.apiKey) {
    return null;
  }
  const explicitBaseUrl = normalizeOptionalString(
    params.ctx.config.models?.providers?.[params.providerId]?.baseUrl,
  );
  if (params.requiresRegion && !explicitBaseUrl) {
    return null;
  }
  return await buildOpenAICompatibleLiveProviderCatalog({
    discoveryMode: "strict",
    providerId: params.providerId,
    providerConfig: {
      ...params.buildProvider(),
      ...(explicitBaseUrl ? { baseUrl: explicitBaseUrl } : {}),
    },
    apiKey: auth.apiKey,
    discoveryApiKey: auth.discoveryApiKey,
    profileId: auth.profileId,
  });
}

function buildXiaomiKeyMismatchMessage(params: {
  actualKey: string;
  expectedKind: "payg" | "token-plan";
}): string | undefined {
  const normalized = params.actualKey.trim().toLowerCase();
  const expectedPrefix = params.expectedKind === "payg" ? "sk-" : "tp-";
  const kindLabel = params.expectedKind === "payg" ? "pay-as-you-go" : "Token Plan";

  if (normalized.startsWith(expectedPrefix)) {
    return undefined;
  }
  if (params.expectedKind === "payg" && normalized.startsWith("tp-")) {
    return (
      "This looks like a Xiaomi MiMo Token Plan key (tp-...). " +
      "Re-run onboarding with one of: --auth-choice xiaomi-token-plan-cn, " +
      "--auth-choice xiaomi-token-plan-sgp, or --auth-choice xiaomi-token-plan-ams."
    );
  }
  if (params.expectedKind === "token-plan" && normalized.startsWith("sk-")) {
    return (
      "This looks like a Xiaomi MiMo pay-as-you-go key (sk-...). " +
      `Re-run onboarding with --auth-choice xiaomi-api-key or pass ${PAYG_FLAG_NAME}.`
    );
  }
  return (
    `Xiaomi MiMo ${kindLabel} keys must start with "${expectedPrefix}". ` +
    "The entered key does not match the expected format."
  );
}

function assertCompatibleXiaomiKey(params: {
  actualKey: string;
  expectedKind: "payg" | "token-plan";
}): void {
  const message = buildXiaomiKeyMismatchMessage(params);
  if (message) {
    throw new Error(message);
  }
}

async function runXiaomiApiKeyAuth(
  ctx: ProviderAuthContext,
  params: {
    providerId: string;
    optionKey: string;
    envVar: string;
    promptMessage: string;
    expectedKind: "payg" | "token-plan";
    defaultModel: string;
    applyConfig: (cfg: OpenClawConfig) => OpenClawConfig;
  },
): Promise<ProviderAuthResult> {
  const profileId = `${params.providerId}:default`;
  const { apiKey, input, mode } = await captureProviderApiKey(ctx, {
    token:
      normalizeOptionalSecretInput(ctx.opts?.[params.optionKey]) ??
      normalizeOptionalSecretInput(ctx.opts?.token),
    tokenProvider: normalizeOptionalSecretInput(ctx.opts?.[params.optionKey])
      ? params.providerId
      : normalizeOptionalSecretInput(ctx.opts?.tokenProvider),
    env: ctx.env,
    expectedProviders: [params.providerId],
    provider: params.providerId,
    envLabel: params.envVar,
    promptMessage: params.promptMessage,
    missingInputMessage: `Missing Xiaomi API key for provider "${params.providerId}".`,
  });
  assertCompatibleXiaomiKey({
    actualKey: apiKey,
    expectedKind: params.expectedKind,
  });
  return {
    profiles: [
      {
        profileId,
        credential: buildApiKeyCredential(
          params.providerId,
          input,
          undefined,
          mode ? { secretInputMode: mode } : undefined,
        ),
      },
    ],
    configPatch: params.applyConfig(ctx.config),
    defaultModel: params.defaultModel,
  };
}

async function runXiaomiApiKeyAuthNonInteractive(
  ctx: ProviderAuthMethodNonInteractiveContext,
  params: {
    providerId: string;
    optionKey: string;
    flagName: `--${string}`;
    envVar: string;
    expectedKind: "payg" | "token-plan";
    applyConfig: (cfg: OpenClawConfig) => OpenClawConfig;
  },
) {
  const resolved = await ctx.resolveApiKey({
    provider: params.providerId,
    flagValue: normalizeOptionalSecretInput(ctx.opts[params.optionKey]),
    flagName: params.flagName,
    envVar: params.envVar,
  });
  if (!resolved) {
    return null;
  }
  assertCompatibleXiaomiKey({
    actualKey: resolved.key,
    expectedKind: params.expectedKind,
  });

  const profileId = `${params.providerId}:default`;
  if (
    !(await persistProviderApiKey(ctx, profileId, {
      provider: params.providerId,
      resolved,
    }))
  ) {
    return null;
  }

  const next = applyAuthProfileConfig(ctx.config, {
    profileId,
    provider: params.providerId,
    mode: "api_key",
  });
  return params.applyConfig(next);
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
  return {
    id: region ? `token-plan-${region}` : "api-key",
    label: choiceLabel,
    hint: choiceHint,
    kind: "api_key",
    wizard: {
      choiceId: region ? `xiaomi-token-plan-${region}` : "xiaomi-api-key",
      choiceLabel,
      choiceHint,
      ...XIAOMI_WIZARD_GROUP,
    },
    run: async (ctx) => await runXiaomiApiKeyAuth(ctx, auth),
    runNonInteractive: async (ctx) => await runXiaomiApiKeyAuthNonInteractive(ctx, auth),
  };
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
          run: async (ctx) =>
            resolveXiaomiCatalog({
              ctx,
              providerId: provider.id,
              buildProvider: provider.buildProvider,
              requiresRegion: provider.requiresRegion,
            }),
        },
        staticCatalog: {
          order: "simple",
          run: async () => ({ provider: provider.buildProvider() }),
        },
        ...XIAOMI_PROVIDER_HOOKS,
        resolveUsageAuth: async (ctx) => {
          const apiKey = ctx.resolveApiKeyFromConfigAndStore({
            providerIds: [provider.id],
            envDirect: [ctx.env[provider.envVar]],
          });
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
