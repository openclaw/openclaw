import type {
  ProviderAuthContext,
  ProviderAuthMethod,
  ProviderAuthMethodNonInteractiveContext,
  ProviderAuthResult,
} from "openclaw/plugin-sdk/core";
import { definePluginEntry, type OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { createProviderApiKeyAuthMethod } from "openclaw/plugin-sdk/provider-auth";
import { readConfiguredProviderCatalogEntries } from "openclaw/plugin-sdk/provider-catalog-shared";
import { PASSTHROUGH_GEMINI_REPLAY_HOOKS } from "openclaw/plugin-sdk/provider-model-shared";
import type { OpenClawConfig } from "openclaw/plugin-sdk/provider-onboard";
import { isProxyReasoningUnsupported } from "openclaw/plugin-sdk/provider-stream";
import { createDeepInfraSystemCacheWrapper, createDeepInfraWrapper } from "./stream.js";
import { applyDeepInfraConfig } from "./onboard.js";
import { buildDeepInfraProvider, buildDeepInfraProviderWithDiscovery } from "./provider-catalog.js";
import { resolveDeepInfraDefaultModelRef } from "./provider-models.js";

const PROVIDER_ID = "deepinfra";
const AUTH_METHOD_ID = "api-key";
const AUTH_LABEL = "DeepInfra API key";
const AUTH_HINT = "Unified API for open source models";

function buildApiKeyAuthMethod(defaultModelRef: string): ProviderAuthMethod {
  return createProviderApiKeyAuthMethod({
    methodId: AUTH_METHOD_ID,
    label: AUTH_LABEL,
    hint: AUTH_HINT,
    optionKey: "deepinfraApiKey",
    flagName: "--deepinfra-api-key",
    envVar: "DEEPINFRA_API_KEY",
    promptMessage: "Enter DeepInfra API key",
    defaultModel: defaultModelRef,
    providerId: PROVIDER_ID,
    expectedProviders: [PROVIDER_ID],
    applyConfig: (cfg: OpenClawConfig) => applyDeepInfraConfig(cfg, defaultModelRef),
    wizard: {
      choiceId: "deepinfra-api-key",
      choiceLabel: AUTH_LABEL,
      choiceHint: AUTH_HINT,
      groupId: PROVIDER_ID,
      groupLabel: "DeepInfra",
      groupHint: AUTH_HINT,
      methodId: AUTH_METHOD_ID,
    },
  });
}

// Default model ref is resolved dynamically from the discovered catalog so
// onboarding never commits to a model the runtime registry won't serve. If the
// preferred default is missing from /models (deprecation, region filtering,
// curated list change), the helper falls back to the first discovered model.
// The shared 30-min cache in `discoverDeepInfraModels` coalesces this call and
// the subsequent `catalog.run` into a single /models round trip.
const deepInfraAuthMethod: ProviderAuthMethod = {
  id: AUTH_METHOD_ID,
  label: AUTH_LABEL,
  hint: AUTH_HINT,
  kind: "api_key",
  wizard: {
    choiceId: "deepinfra-api-key",
    choiceLabel: AUTH_LABEL,
    choiceHint: AUTH_HINT,
    groupId: PROVIDER_ID,
    groupLabel: "DeepInfra",
    groupHint: AUTH_HINT,
    methodId: AUTH_METHOD_ID,
  },
  run: async (ctx: ProviderAuthContext): Promise<ProviderAuthResult> => {
    const ref = await resolveDeepInfraDefaultModelRef();
    return buildApiKeyAuthMethod(ref).run(ctx);
  },
  runNonInteractive: async (
    ctx: ProviderAuthMethodNonInteractiveContext,
  ): Promise<OpenClawConfig | null> => {
    const method = buildApiKeyAuthMethod(await resolveDeepInfraDefaultModelRef());
    return method.runNonInteractive ? method.runNonInteractive(ctx) : null;
  },
};

export default definePluginEntry({
  id: PROVIDER_ID,
  name: "DeepInfra Provider",
  description: "Bundled DeepInfra provider plugin",
  register(api: OpenClawPluginApi) {
    api.registerProvider({
      id: PROVIDER_ID,
      label: "DeepInfra",
      docsPath: "/providers/deepinfra",
      auth: [deepInfraAuthMethod],
      catalog: {
        order: "simple",
        run: async (ctx) => {
          const apiKey = ctx.resolveProviderApiKey(PROVIDER_ID).apiKey;
          if (!apiKey) {
            return null;
          }
          const provider = await buildDeepInfraProviderWithDiscovery();
          return { provider: { ...provider, apiKey } };
        },
        preserveDiscoveryOrder: true,
      },
      staticCatalog: {
        order: "simple",
        run: async () => ({ provider: buildDeepInfraProvider() }),
      },
      augmentModelCatalog: ({ config }) =>
        readConfiguredProviderCatalogEntries({
          config,
          providerId: PROVIDER_ID,
        }),
      ...PASSTHROUGH_GEMINI_REPLAY_HOOKS,
      wrapStreamFn: (ctx) => {
        const thinkingLevel = isProxyReasoningUnsupported(ctx.modelId)
          ? undefined
          : ctx.thinkingLevel;
        return createDeepInfraSystemCacheWrapper(
          createDeepInfraWrapper(ctx.streamFn, thinkingLevel),
        );
      },
      isCacheTtlEligible: (ctx) => ctx.modelId.toLowerCase().startsWith("anthropic/"),
    });
  },
});
