import { definePluginEntry, type ProviderCatalogContext } from "openclaw/plugin-sdk/plugin-entry";
import { createProviderApiKeyAuthMethod } from "openclaw/plugin-sdk/provider-auth-api-key";
import { buildOpenAICompatibleLiveProviderCatalog } from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import { createProviderConnectionPresetAppliers } from "openclaw/plugin-sdk/provider-onboard";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
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

const STEPFUN_SURFACES = {
  standard: {
    providerId: STEPFUN_PROVIDER_ID,
    label: "StepFun",
    authLabel: "StepFun Standard",
    defaultModel: STEPFUN_DEFAULT_MODEL_REF,
    baseUrls: { cn: STEPFUN_STANDARD_CN_BASE_URL, intl: STEPFUN_STANDARD_INTL_BASE_URL },
    buildProvider: buildStepFunProvider,
    modelAlias: "StepFun",
  },
  plan: {
    providerId: STEPFUN_PLAN_PROVIDER_ID,
    label: "StepFun Step Plan",
    authLabel: "StepFun Step Plan",
    defaultModel: STEPFUN_PLAN_DEFAULT_MODEL_REF,
    baseUrls: { cn: STEPFUN_PLAN_CN_BASE_URL, intl: STEPFUN_PLAN_INTL_BASE_URL },
    buildProvider: buildStepFunPlanProvider,
    modelAlias: "StepFun Plan",
  },
};

function trimExplicitBaseUrl(ctx: ProviderCatalogContext, providerId: string): string | undefined {
  return normalizeOptionalString(ctx.config.models?.providers?.[providerId]?.baseUrl);
}

function inferRegionFromBaseUrl(baseUrl: string | undefined): StepFunRegion | undefined {
  if (!baseUrl) {
    return undefined;
  }
  const host = normalizeLowercaseStringOrEmpty(URL.parse(baseUrl)?.hostname);
  if (host === "api.stepfun.com") {
    return "cn";
  }
  if (host === "api.stepfun.ai") {
    return "intl";
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

export default definePluginEntry({
  id: STEPFUN_PROVIDER_ID,
  name: "StepFun",
  description: "Bundled StepFun standard and Step Plan provider plugin",
  register(api) {
    for (const surface of ["standard", "plan"] as const) {
      const provider = STEPFUN_SURFACES[surface];
      const presetAppliers = createProviderConnectionPresetAppliers<[string]>({
        primaryModelRef: provider.defaultModel,
        resolveParams: (_cfg, baseUrl) => {
          const catalog = provider.buildProvider(baseUrl);
          return {
            providerId: provider.providerId,
            api: catalog.api ?? "openai-completions",
            baseUrl,
            catalogModels: catalog.models,
            aliases: [
              ...catalog.models.map((model) => `${provider.providerId}/${model.id}`),
              { modelRef: provider.defaultModel, alias: provider.modelAlias },
            ],
          };
        },
      });
      api.registerProvider({
        id: provider.providerId,
        label: provider.label,
        docsPath: "/providers/stepfun",
        envVars: ["STEPFUN_API_KEY"],
        auth: (["cn", "intl"] as const).map((region) => {
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
            profileIds: [`stepfun:${region}`, `stepfun-plan:${region}`],
            allowProfile: false,
            defaultModel: provider.defaultModel,
            preserveExistingPrimary: true,
            expectedProviders: [STEPFUN_PROVIDER_ID, STEPFUN_PLAN_PROVIDER_ID],
            applyConfig: (cfg) => presetAppliers.applyConfig(cfg, provider.baseUrls[region]),
            wizard: {
              choiceId: `stepfun-${methodId}`,
              choiceLabel: label,
              choiceHint: hint,
              groupId: "stepfun",
              groupLabel: "StepFun",
              groupHint: "Standard / Step Plan (China / Global)",
            },
          });
        }),
        catalog: {
          order: "paired",
          run: async (ctx) => {
            const profileAuth = ctx.resolveProviderAuth(provider.providerId);
            const auth = profileAuth.apiKey
              ? profileAuth
              : ctx.resolveProviderApiKey(provider.providerId);
            const apiKey = auth.apiKey;
            if (!apiKey) {
              return null;
            }

            const explicitBaseUrl = trimExplicitBaseUrl(ctx, provider.providerId);
            const region =
              inferRegionFromBaseUrl(explicitBaseUrl) ??
              inferRegionFromBaseUrl(trimExplicitBaseUrl(ctx, STEPFUN_PROVIDER_ID)) ??
              inferRegionFromBaseUrl(trimExplicitBaseUrl(ctx, STEPFUN_PLAN_PROVIDER_ID)) ??
              inferRegionFromProfileId(auth.profileId);
            // Keep discovery working for legacy/manual auth profiles that resolved a
            // key but do not encode region in the profile id.
            const baseUrl = explicitBaseUrl ?? provider.baseUrls[region ?? "intl"];
            const providerConfig = provider.buildProvider(baseUrl);
            return await buildOpenAICompatibleLiveProviderCatalog({
              discoveryMode: "strict",
              providerId: provider.providerId,
              providerConfig,
              apiKey,
              discoveryApiKey: auth.discoveryApiKey,
              profileId: auth.profileId,
            });
          },
        },
        staticCatalog: {
          order: "paired",
          run: async () => ({ provider: provider.buildProvider() }),
        },
      });
    }
  },
});
