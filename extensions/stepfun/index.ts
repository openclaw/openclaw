import {
  definePluginEntry,
  type OpenClawConfig,
  type ProviderCatalogContext,
} from "openclaw/plugin-sdk/plugin-entry";
import { createProviderApiKeyAuthMethod } from "openclaw/plugin-sdk/provider-auth-api-key";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/text-runtime";
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
const STEPFUN_PROVIDER_IDS = [STEPFUN_PROVIDER_ID, STEPFUN_PLAN_PROVIDER_ID] as const;

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

function inferLatestConfiguredRegion(ctx: ProviderCatalogContext): StepFunRegion | undefined {
  const configuredOrder = ctx.config.auth?.order;
  if (!configuredOrder || typeof configuredOrder !== "object") {
    // Without explicit ordering, defer to other inference methods
    // (env vars, profile ID patterns, etc.) which have clearer semantics
    return undefined;
  }

  // Use auth.order to find the most recently configured StepFun profile
  for (const providerId of STEPFUN_PROVIDER_IDS) {
    const matchingOrder = Object.entries(configuredOrder).find(
      ([key]) => key.trim().toLowerCase() === providerId,
    )?.[1];
    if (!Array.isArray(matchingOrder)) {
      continue;
    }
    // auth.order is an array where later entries are more recent
    // Iterate in reverse to find the most recent matching profile
    for (let i = matchingOrder.length - 1; i >= 0; i--) {
      const profileId = matchingOrder[i];
      const region = inferRegionFromProfileId(typeof profileId === "string" ? profileId : "");
      if (region) {
        return region;
      }
    }
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

function resolveDefaultBaseUrl(surface: StepFunSurface, region: StepFunRegion): string {
  if (surface === "plan") {
    return region === "cn" ? STEPFUN_PLAN_CN_BASE_URL : STEPFUN_PLAN_INTL_BASE_URL;
  }
  return region === "cn" ? STEPFUN_STANDARD_CN_BASE_URL : STEPFUN_STANDARD_INTL_BASE_URL;
}

function resolveStepFunCatalog(
  ctx: ProviderCatalogContext,
  params: { providerId: string; surface: StepFunSurface },
) {
  const auth = ctx.resolveProviderAuth(params.providerId);
  const apiKey = auth.apiKey ?? ctx.resolveProviderApiKey(params.providerId).apiKey;
  if (!apiKey) {
    return null;
  }

  const explicitBaseUrl = trimExplicitBaseUrl(ctx, params.providerId);
  const region =
    inferRegionFromBaseUrl(explicitBaseUrl) ??
    inferRegionFromExplicitBaseUrls(ctx) ??
    inferLatestConfiguredRegion(ctx) ??
    inferRegionFromProfileId(auth.profileId) ??
    inferRegionFromEnv(ctx.env);
  // Keep discovery working for legacy/manual auth profiles that resolved a
  // key but do not encode region in the profile id.
  const baseUrl = explicitBaseUrl ?? resolveDefaultBaseUrl(params.surface, region ?? "intl");
  return {
    provider:
      params.surface === "plan"
        ? { ...buildStepFunPlanProvider(baseUrl), apiKey }
        : { ...buildStepFunProvider(baseUrl), apiKey },
  };
}

function resolveProfileIds(region: StepFunRegion): [string, string] {
  return region === "cn"
    ? ["stepfun:cn", "stepfun-plan:cn"]
    : ["stepfun:intl", "stepfun-plan:intl"];
}

function createStepFunApiKeyMethod(params: {
  providerId: string;
  methodId: string;
  label: string;
  hint: string;
  region: StepFunRegion;
  promptMessage: string;
  defaultModel: string;
  choiceId: string;
  choiceLabel: string;
  choiceHint: string;
  applyConfig: (cfg: OpenClawConfig) => OpenClawConfig;
}) {
  return createProviderApiKeyAuthMethod({
    providerId: params.providerId,
    methodId: params.methodId,
    label: params.label,
    hint: params.hint,
    optionKey: "stepfunApiKey",
    flagName: "--stepfun-api-key",
    envVar: "STEPFUN_API_KEY",
    promptMessage: params.promptMessage,
    profileIds: resolveProfileIds(params.region),
    allowProfile: false,
    defaultModel: params.defaultModel,
    expectedProviders: [STEPFUN_PROVIDER_ID, STEPFUN_PLAN_PROVIDER_ID],
    applyConfig: params.applyConfig,
    wizard: {
      choiceId: params.choiceId,
      choiceLabel: params.choiceLabel,
      choiceHint: params.choiceHint,
      groupId: "stepfun",
      groupLabel: "StepFun",
      groupHint: "Standard API / Step Plan (China / Global)",
    },
  });
}

export default definePluginEntry({
  id: STEPFUN_PROVIDER_ID,
  name: "StepFun",
  description: "Bundled StepFun standard and Step Plan provider plugin",
  register(api) {
    api.registerProvider({
      id: STEPFUN_PROVIDER_ID,
      label: "StepFun",
      docsPath: "/providers/stepfun",
      envVars: ["STEPFUN_API_KEY"],
      auth: [
        createStepFunApiKeyMethod({
          providerId: STEPFUN_PROVIDER_ID,
          methodId: "standard-api-key-cn",
          label: "StepFun Standard API key (China)",
          hint: "Endpoint: api.stepfun.com/v1",
          region: "cn",
          promptMessage: "Enter StepFun API key for the China standard endpoint",
          defaultModel: STEPFUN_DEFAULT_MODEL_REF,
          choiceId: "stepfun-standard-api-key-cn",
          choiceLabel: "StepFun Standard API key (China)",
          choiceHint: "Endpoint: api.stepfun.com/v1",
          applyConfig: applyStepFunStandardConfigCn,
        }),
        createStepFunApiKeyMethod({
          providerId: STEPFUN_PROVIDER_ID,
          methodId: "standard-api-key-intl",
          label: "StepFun Standard API key (Global)",
          hint: "Endpoint: api.stepfun.ai/v1",
          region: "intl",
          promptMessage: "Enter StepFun API key for the global standard endpoint",
          defaultModel: STEPFUN_DEFAULT_MODEL_REF,
          choiceId: "stepfun-standard-api-key-intl",
          choiceLabel: "StepFun Standard API key (Global)",
          choiceHint: "Endpoint: api.stepfun.ai/v1",
          applyConfig: applyStepFunStandardConfig,
        }),
      ],
      catalog: {
        order: "paired",
        run: async (ctx) =>
          resolveStepFunCatalog(ctx, {
            providerId: STEPFUN_PROVIDER_ID,
            surface: "standard",
          }),
      },
    });

    api.registerProvider({
      id: STEPFUN_PLAN_PROVIDER_ID,
      label: "StepFun Step Plan",
      docsPath: "/providers/stepfun",
      envVars: ["STEPFUN_API_KEY"],
      auth: [
        createStepFunApiKeyMethod({
          providerId: STEPFUN_PLAN_PROVIDER_ID,
          methodId: "plan-api-key-cn",
          label: "StepFun Step Plan API key (China)",
          hint: "Endpoint: api.stepfun.com/step_plan/v1",
          region: "cn",
          promptMessage: "Enter StepFun API key for the China Step Plan endpoint",
          defaultModel: STEPFUN_PLAN_DEFAULT_MODEL_REF,
          choiceId: "stepfun-plan-api-key-cn",
          choiceLabel: "StepFun Step Plan API key (China)",
          choiceHint: "Endpoint: api.stepfun.com/step_plan/v1",
          applyConfig: applyStepFunPlanConfigCn,
        }),
        createStepFunApiKeyMethod({
          providerId: STEPFUN_PLAN_PROVIDER_ID,
          methodId: "plan-api-key-intl",
          label: "StepFun Step Plan API key (Global)",
          hint: "Endpoint: api.stepfun.ai/step_plan/v1",
          region: "intl",
          promptMessage: "Enter StepFun API key for the global Step Plan endpoint",
          defaultModel: STEPFUN_PLAN_DEFAULT_MODEL_REF,
          choiceId: "stepfun-plan-api-key-intl",
          choiceLabel: "StepFun Step Plan API key (Global)",
          choiceHint: "Endpoint: api.stepfun.ai/step_plan/v1",
          applyConfig: applyStepFunPlanConfig,
        }),
      ],
      catalog: {
        order: "paired",
        run: async (ctx) =>
          resolveStepFunCatalog(ctx, {
            providerId: STEPFUN_PLAN_PROVIDER_ID,
            surface: "plan",
          }),
      },
    });
  },
});
