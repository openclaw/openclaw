import {
  definePluginEntry,
  type OpenClawConfig,
  type ProviderCatalogContext,
} from "openclaw/plugin-sdk/plugin-entry";
import { ensureAuthProfileStore, listProfilesForProvider } from "openclaw/plugin-sdk/provider-auth";
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

function resolvePairedProviderId(providerId: string): string {
  return providerId === STEPFUN_PROVIDER_ID ? STEPFUN_PLAN_PROVIDER_ID : STEPFUN_PROVIDER_ID;
}

function inferOrderedRegionForProvider(
  ctx: ProviderCatalogContext,
  providerId: string,
  currentProfileId?: string,
): StepFunRegion | undefined {
  const configuredOrder = ctx.config.auth?.order;
  if (!configuredOrder || typeof configuredOrder !== "object") {
    return undefined;
  }

  const matchingOrder = Object.entries(configuredOrder).find(
    ([key]) => key.trim().toLowerCase() === providerId,
  )?.[1];
  if (!Array.isArray(matchingOrder)) {
    return undefined;
  }
  const configuredProfiles = ctx.config.auth?.profiles;
  const normalizedProviderId = providerId.trim().toLowerCase();
  const normalizedCurrentProfileId = currentProfileId?.trim();
  const credentialBackedProfiles = resolveCredentialBackedProfiles(ctx, providerId);

  // applyAuthProfileConfig writes the latest selected profile first.
  for (const profileId of matchingOrder) {
    if (typeof profileId !== "string") {
      continue;
    }
    const normalizedProfileId = profileId.trim();
    if (!normalizedProfileId) {
      continue;
    }

    const configuredProfile = configuredProfiles?.[normalizedProfileId];
    const profileMatchesConfiguredProvider =
      configuredProfile &&
      typeof configuredProfile === "object" &&
      typeof configuredProfile.provider === "string" &&
      configuredProfile.provider.trim().toLowerCase() === normalizedProviderId;
    const profileMatchesCurrent =
      Boolean(normalizedCurrentProfileId) && normalizedProfileId === normalizedCurrentProfileId;
    const profileIsCredentialBacked =
      credentialBackedProfiles?.has(normalizedProfileId) ?? profileMatchesConfiguredProvider;

    // Skip stale auth.order entries without usable credentials.
    if (!profileMatchesCurrent && !profileIsCredentialBacked) {
      continue;
    }

    const region = inferRegionFromProfileId(normalizedProfileId);
    if (region) {
      return region;
    }
  }
  return undefined;
}

function resolveCredentialBackedProfiles(
  ctx: ProviderCatalogContext,
  providerId: string,
): Set<string> | undefined {
  const agentDir = ctx.agentDir?.trim();
  if (!agentDir) {
    return undefined;
  }
  try {
    const store = ensureAuthProfileStore(agentDir, { allowKeychainPrompt: false });
    return new Set(
      listProfilesForProvider(store, providerId)
        .map((profileId) => profileId.trim())
        .filter((profileId) => profileId.length > 0),
    );
  } catch {
    return undefined;
  }
}

function inferLatestConfiguredRegion(
  ctx: ProviderCatalogContext,
  providerId: string,
  profileId: string | undefined,
): StepFunRegion | undefined {
  return (
    inferOrderedRegionForProvider(ctx, providerId, profileId) ??
    inferRegionFromProfileId(profileId) ??
    inferOrderedRegionForProvider(ctx, resolvePairedProviderId(providerId))
  );
}

function inferRegionFromEnv(env: NodeJS.ProcessEnv): StepFunRegion | undefined {
  // Shared env-only setup needs one stable fallback region.
  if (env.STEPFUN_API_KEY?.trim()) {
    return "intl";
  }
  return undefined;
}

function inferRegionFromExplicitBaseUrls(ctx: ProviderCatalogContext): StepFunRegion | undefined {
  for (const providerId of STEPFUN_PROVIDER_IDS) {
    const region = inferRegionFromBaseUrl(trimExplicitBaseUrl(ctx, providerId));
    if (region) {
      return region;
    }
  }
  return undefined;
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
  // auth.order/auth.profiles can drift from credential reality. Only use those
  // config hints when discovery is currently profile-backed.
  const configuredRegion =
    auth.source === "profile"
      ? inferLatestConfiguredRegion(ctx, params.providerId, auth.profileId)
      : inferRegionFromProfileId(auth.profileId);
  const region =
    inferRegionFromBaseUrl(explicitBaseUrl) ??
    inferRegionFromExplicitBaseUrls(ctx) ??
    configuredRegion ??
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
