import { definePluginEntry, type ProviderCatalogContext } from "openclaw/plugin-sdk/plugin-entry";
import { createProviderApiKeyAuthMethod } from "openclaw/plugin-sdk/provider-auth-api-key";
import { buildOpenAICompatibleLiveProviderCatalog } from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  applyStepFunPlanConfig,
  applyStepFunPlanConfigCn,
  applyStepFunStandardConfig,
  applyStepFunStandardConfigCn,
} from "./onboard.js";
import {
  buildStepFunPlanProvider,
  buildStepFunProvider,
  STEPFUN_DEFAULT_MODEL_REF,
  STEPFUN_PLAN_CN_BASE_URL,
  STEPFUN_PLAN_DEFAULT_MODEL_REF,
  STEPFUN_PLAN_INTL_BASE_URL,
  STEPFUN_PLAN_PROVIDER_ID,
  STEPFUN_PROVIDER_ID,
  STEPFUN_STANDARD_CN_BASE_URL,
  STEPFUN_STANDARD_INTL_BASE_URL,
} from "./provider-catalog.js";

type StepFunRegion = "cn" | "intl";
type StepFunSurface = "standard" | "plan";

const STEPFUN_SURFACES = {
  standard: {
    providerId: STEPFUN_PROVIDER_ID,
    label: "StepFun",
    authLabel: "StepFun Standard",
    defaultModel: STEPFUN_DEFAULT_MODEL_REF,
    baseUrls: { cn: STEPFUN_STANDARD_CN_BASE_URL, intl: STEPFUN_STANDARD_INTL_BASE_URL },
    buildProvider: buildStepFunProvider,
    applyConfig: { cn: applyStepFunStandardConfigCn, intl: applyStepFunStandardConfig },
  },
  plan: {
    providerId: STEPFUN_PLAN_PROVIDER_ID,
    label: "StepFun Step Plan",
    authLabel: "StepFun Step Plan",
    defaultModel: STEPFUN_PLAN_DEFAULT_MODEL_REF,
    baseUrls: { cn: STEPFUN_PLAN_CN_BASE_URL, intl: STEPFUN_PLAN_INTL_BASE_URL },
    buildProvider: buildStepFunPlanProvider,
    applyConfig: { cn: applyStepFunPlanConfigCn, intl: applyStepFunPlanConfig },
  },
};

function trimExplicitBaseUrl(ctx: ProviderCatalogContext, providerId: string): string | undefined {
  const explicitProvider = ctx.config.models?.providers?.[providerId];
  const baseUrl =
    typeof explicitProvider?.baseUrl === "string" ? explicitProvider.baseUrl.trim() : "";
  return baseUrl || undefined;
}

function inferRegionFromBaseUrl(baseUrl: string | undefined): StepFunRegion | undefined {
  if (!baseUrl) {
    return undefined;
  }
  try {
    const host = normalizeLowercaseStringOrEmpty(new URL(baseUrl).hostname);
    if (host === "api.stepfun.com") {
      return "cn";
    }
    if (host === "api.stepfun.ai") {
      return "intl";
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function inferRegionFromProfileId(profileId: string | undefined): StepFunRegion | undefined {
  if (!profileId) {
    return undefined;
  }
  if (profileId.includes(":cn")) {
    return "cn";
  }
  if (profileId.includes(":intl")) {
    return "intl";
  }
  return undefined;
}

function inferRegionFromEnv(env: NodeJS.ProcessEnv): StepFunRegion | undefined {
  // Shared env-only setup needs one stable fallback region.
  if (env.STEPFUN_API_KEY?.trim()) {
    return "intl";
  }
  return undefined;
}

function inferRegionFromExplicitBaseUrls(ctx: ProviderCatalogContext): StepFunRegion | undefined {
  return (
    inferRegionFromBaseUrl(trimExplicitBaseUrl(ctx, STEPFUN_PROVIDER_ID)) ??
    inferRegionFromBaseUrl(trimExplicitBaseUrl(ctx, STEPFUN_PLAN_PROVIDER_ID))
  );
}

async function resolveStepFunCatalog(
  ctx: ProviderCatalogContext,
  params: { providerId: string; surface: StepFunSurface },
) {
  const profileAuth = ctx.resolveProviderAuth(params.providerId);
  const auth = profileAuth.apiKey ? profileAuth : ctx.resolveProviderApiKey(params.providerId);
  const apiKey = auth.apiKey;
  if (!apiKey) {
    return null;
  }

  const explicitBaseUrl = trimExplicitBaseUrl(ctx, params.providerId);
  const region =
    inferRegionFromBaseUrl(explicitBaseUrl) ??
    inferRegionFromExplicitBaseUrls(ctx) ??
    inferRegionFromProfileId(auth.profileId) ??
    inferRegionFromEnv(ctx.env);
  // Keep discovery working for legacy/manual auth profiles that resolved a
  // key but do not encode region in the profile id.
  const provider = STEPFUN_SURFACES[params.surface];
  const baseUrl = explicitBaseUrl ?? provider.baseUrls[region ?? "intl"];
  const providerConfig = provider.buildProvider(baseUrl);
  return await buildOpenAICompatibleLiveProviderCatalog({
    discoveryMode: "strict",
    providerId: params.providerId,
    providerConfig,
    apiKey,
    discoveryApiKey: auth.discoveryApiKey,
    profileId: auth.profileId,
  });
}

function resolveProfileIds(region: StepFunRegion): [string, string] {
  return region === "cn"
    ? ["stepfun:cn", "stepfun-plan:cn"]
    : ["stepfun:intl", "stepfun-plan:intl"];
}

function createStepFunApiKeyMethod(surface: StepFunSurface, region: StepFunRegion) {
  const provider = STEPFUN_SURFACES[surface];
  const methodId = `${surface}-api-key-${region}`;
  const label = `${provider.authLabel} API key (${region === "cn" ? "China" : "Global/Intl"})`;
  const hint = `Endpoint: ${provider.baseUrls[region].replace(/^https:\/\//u, "")}`;
  return createProviderApiKeyAuthMethod({
    providerId: provider.providerId,
    methodId,
    label,
    hint,
    optionKey: "stepfunApiKey",
    flagName: "--stepfun-api-key",
    envVar: "STEPFUN_API_KEY",
    promptMessage: `Enter StepFun API key for ${region === "cn" ? "China" : "global"} endpoints`,
    profileIds: resolveProfileIds(region),
    allowProfile: false,
    defaultModel: provider.defaultModel,
    preserveExistingPrimary: true,
    expectedProviders: [STEPFUN_PROVIDER_ID, STEPFUN_PLAN_PROVIDER_ID],
    applyConfig: provider.applyConfig[region],
    wizard: {
      choiceId: `stepfun-${methodId}`,
      choiceLabel: label,
      choiceHint: hint,
      groupId: "stepfun",
      groupLabel: "StepFun",
      groupHint: "Standard / Step Plan (China / Global)",
    },
  });
}

export default definePluginEntry({
  id: STEPFUN_PROVIDER_ID,
  name: "StepFun",
  description: "Bundled StepFun standard and Step Plan provider plugin",
  register(api) {
    for (const surface of ["standard", "plan"] as const) {
      const provider = STEPFUN_SURFACES[surface];
      api.registerProvider({
        id: provider.providerId,
        label: provider.label,
        docsPath: "/providers/stepfun",
        envVars: ["STEPFUN_API_KEY"],
        auth: (["cn", "intl"] as const).map((region) => createStepFunApiKeyMethod(surface, region)),
        catalog: {
          order: "paired",
          run: async (ctx) =>
            resolveStepFunCatalog(ctx, { providerId: provider.providerId, surface }),
        },
        staticCatalog: {
          order: "paired",
          run: async () => ({ provider: provider.buildProvider() }),
        },
      });
    }
  },
});
