import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  definePluginEntry,
  type OpenClawPluginApi,
  type ProviderAuthContext,
  type ProviderAuthMethodNonInteractiveContext,
} from "openclaw/plugin-sdk/plugin-entry";
import {
  findNormalizedProviderValue,
  normalizeOptionalSecretInput,
} from "openclaw/plugin-sdk/provider-auth";
import { buildOpenAICompatibleProviderCatalog } from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import { createProviderApiKeyAuthMethod } from "openclaw/plugin-sdk/provider-entry";
import { buildLitellmImageGenerationProvider } from "./image-generation-provider.js";
import { applyLitellmConfig, LITELLM_BASE_URL, LITELLM_DEFAULT_MODEL_REF } from "./onboard.js";
import { buildLitellmProvider } from "./provider-catalog.js";

const PROVIDER_ID = "litellm";

function applyLitellmBaseUrl(cfg: OpenClawConfig, baseUrl: unknown): OpenClawConfig {
  const normalized = normalizeOptionalSecretInput(baseUrl)?.replace(/\/+$/, "");
  if (!normalized) {
    return cfg;
  }
  // Preserve authored settings even when the provider key uses different casing.
  const existingProvider =
    cfg.models?.providers?.[PROVIDER_ID] ??
    findNormalizedProviderValue(cfg.models?.providers, PROVIDER_ID);
  return {
    ...cfg,
    models: {
      ...cfg.models,
      providers: {
        ...cfg.models?.providers,
        [PROVIDER_ID]: {
          ...existingProvider,
          baseUrl: normalized,
          models: existingProvider?.models ?? [],
        },
      },
    },
  };
}

function validateProxyBaseUrl(value: string): string | undefined {
  const candidate = value.trim();
  if (!candidate) {
    return undefined;
  }
  if (!URL.canParse(candidate)) {
    return `Enter a full URL, such as ${LITELLM_BASE_URL}`;
  }
  const { protocol } = new URL(candidate);
  return protocol === "http:" || protocol === "https:"
    ? undefined
    : "The LiteLLM proxy URL must start with http:// or https://";
}

async function promptLitellmBaseUrl(ctx: ProviderAuthContext): Promise<string | undefined> {
  const configured =
    (
      ctx.config.models?.providers?.[PROVIDER_ID] ??
      findNormalizedProviderValue(ctx.config.models?.providers, PROVIDER_ID)
    )?.baseUrl?.trim() ?? "";
  const answer = await ctx.prompter.text({
    message: "LiteLLM proxy base URL",
    // Prefilling the default would make typed input append to it; hint it instead and
    // only prefill when there is a real value the operator may want to edit.
    initialValue: configured || undefined,
    placeholder: LITELLM_BASE_URL,
    validate: validateProxyBaseUrl,
  });
  const chosen = answer.trim().replace(/\/+$/, "");
  // Keep fresh default-model seeding, but honor switching an existing remote URL back.
  return chosen === LITELLM_BASE_URL && !configured ? undefined : chosen;
}

export default definePluginEntry({
  id: PROVIDER_ID,
  name: "LiteLLM Provider",
  description: "Bundled LiteLLM provider plugin",
  register(api: OpenClawPluginApi) {
    const apiKeyAuth = createProviderApiKeyAuthMethod({
      providerId: PROVIDER_ID,
      methodId: "api-key",
      label: "LiteLLM API key",
      hint: "Unified gateway for 100+ LLM providers",
      optionKey: "litellmApiKey",
      flagName: "--litellm-api-key",
      envVar: "LITELLM_API_KEY",
      promptMessage: "Enter LiteLLM API key",
      defaultModel: LITELLM_DEFAULT_MODEL_REF,
      applyConfig: applyLitellmConfig,
      noteTitle: "LiteLLM",
      noteMessage: [
        "LiteLLM provides a unified API to 100+ LLM providers.",
        "Get your API key from your LiteLLM proxy or https://litellm.ai",
        "Default proxy runs on http://localhost:4000",
      ].join("\n"),
      wizard: {
        choiceId: `${PROVIDER_ID}-api-key`,
        choiceLabel: "LiteLLM API key",
        groupId: PROVIDER_ID,
        groupLabel: "LiteLLM",
        groupHint: "Unified LLM gateway (100+ providers)",
        methodId: "api-key",
      },
    });

    api.registerProvider({
      id: PROVIDER_ID,
      label: "LiteLLM",
      docsPath: "/providers/litellm",
      envVars: ["LITELLM_API_KEY"],
      auth: [
        {
          ...apiKeyAuth,
          run: async (ctx: ProviderAuthContext) => {
            const baseUrl = await promptLitellmBaseUrl(ctx);
            return await apiKeyAuth.run({
              ...ctx,
              config: applyLitellmBaseUrl(ctx.config, baseUrl),
            });
          },
          runNonInteractive: async (ctx: ProviderAuthMethodNonInteractiveContext) => {
            const runNonInteractive = apiKeyAuth.runNonInteractive;
            if (!runNonInteractive) {
              return null;
            }
            return await runNonInteractive({
              ...ctx,
              config: applyLitellmBaseUrl(ctx.config, ctx.opts.customBaseUrl),
            });
          },
        },
      ],
      catalog: {
        order: "simple",
        run: (ctx) => {
          // LiteLLM serves models at both /models and /v1/models, and operators
          // configure bases with or without /v1; the shared join does not dedupe it.
          const explicitBaseUrl =
            findNormalizedProviderValue(ctx.config.models?.providers, PROVIDER_ID)?.baseUrl ?? "";
          const versionedBaseUrl = /\/v1\/*$/.test(explicitBaseUrl.trim());
          return buildOpenAICompatibleProviderCatalog({
            discoveryMode: "strict",
            ctx,
            providerId: PROVIDER_ID,
            buildProvider: buildLitellmProvider,
            allowExplicitBaseUrl: true,
            modelDiscovery: { endpointPath: versionedBaseUrl ? "models" : "v1/models" },
          });
        },
      },
      staticCatalog: {
        order: "simple",
        run: async () => ({ provider: buildLitellmProvider() }),
      },
    });
    api.registerImageGenerationProvider(buildLitellmImageGenerationProvider());
  },
});
