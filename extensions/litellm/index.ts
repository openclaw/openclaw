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
import {
  buildApiKeyCredential,
  captureProviderApiKey,
} from "openclaw/plugin-sdk/provider-auth-api-key";
import { buildOpenAICompatibleProviderCatalog } from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import { resolveMergedModelProviderConfig } from "openclaw/plugin-sdk/provider-catalog-shared";
import { createProviderApiKeyAuthMethod } from "openclaw/plugin-sdk/provider-entry";
import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-shared";
import { buildLitellmImageGenerationProvider } from "./image-generation-provider.js";
import {
  applyLitellmConfig,
  applyLitellmModelConfig,
  buildLitellmModelDefinition,
  LITELLM_BASE_URL,
  LITELLM_DEFAULT_MODEL_REF,
} from "./onboard.js";

const PROVIDER_ID = "litellm";

function buildLitellmProvider(): ModelProviderConfig {
  return {
    baseUrl: LITELLM_BASE_URL,
    api: "openai-completions",
    models: [buildLitellmModelDefinition()],
  };
}

function applyLitellmBaseUrl(cfg: OpenClawConfig, baseUrl: unknown): OpenClawConfig {
  const normalized = normalizeOptionalSecretInput(baseUrl)?.replace(/\/+$/, "");
  if (!normalized) {
    return cfg;
  }
  // Preserve authored settings even when the provider key uses different casing.
  const existingProvider = resolveMergedModelProviderConfig(cfg, PROVIDER_ID);
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

async function promptLitellmBaseUrl(ctx: ProviderAuthContext): Promise<string> {
  const configured =
    resolveMergedModelProviderConfig(ctx.config, PROVIDER_ID)?.baseUrl?.trim() ?? "";
  const answer = await ctx.prompter.text({
    message: "LiteLLM proxy base URL",
    // Prefilling the default would make typed input append to it; hint it instead and
    // only prefill when there is a real value the operator may want to edit.
    initialValue: configured || undefined,
    placeholder: LITELLM_BASE_URL,
    validate: validateProxyBaseUrl,
  });
  return (answer.trim() || configured || LITELLM_BASE_URL).replace(/\/+$/, "");
}

async function promptLitellmModel(ctx: ProviderAuthContext, apiKey: string): Promise<string> {
  const baseUrl = ctx.config.models?.providers?.litellm?.baseUrl ?? LITELLM_BASE_URL;
  let modelIds: string[] = [];
  let reason = "the proxy could not be reached or its request settings could not be resolved";
  try {
    const { discoverOpenAICompatibleLocalModels } =
      await import("openclaw/plugin-sdk/provider-setup");
    const result = await discoverOpenAICompatibleLocalModels({
      baseUrl: baseUrl.endsWith("/v1") ? baseUrl : `${baseUrl}/v1`,
      apiKey,
      configuredProvider: { config: ctx.config, id: PROVIDER_ID },
      beforeRequest: ctx.assertCurrent,
      env: ctx.env,
      signal: ctx.signal,
      label: "LiteLLM",
      rawResult: true,
      discoverRuntimeContext: false,
    });
    if (result.kind === "success") {
      modelIds = [
        ...new Set(
          result.rows.flatMap(({ model }) =>
            typeof model.id === "string" && model.id.trim() ? [model.id.trim()] : [],
          ),
        ),
      ];
      reason = "the proxy returned an empty model list";
    } else if (result.kind === "http-error") {
      reason = `the proxy returned HTTP ${result.status}`;
    } else if (result.kind === "invalid-response") {
      reason = "the proxy returned an invalid model list";
    }
  } catch {
    // Discovery is advisory; keep request errors and credentials out of the prompt.
  }
  ctx.signal?.throwIfAborted();
  ctx.assertCurrent?.();
  if (modelIds.length > 0) {
    const selected = await ctx.prompter.select({
      message: "LiteLLM model",
      initialValue: modelIds[0],
      options: [
        ...modelIds.map((id) => ({ value: id, label: id })),
        { value: "", label: "Enter model ID manually" },
      ],
    });
    if (selected) {
      return selected;
    }
  } else {
    await ctx.prompter.note(
      `Model discovery unavailable: ${reason}. Enter a model ID manually.`,
      "LiteLLM models",
    );
  }
  return (
    await ctx.prompter.text({
      message: "LiteLLM model ID",
      placeholder: "Model ID served by your proxy",
      validate: (value) => (value.trim() ? undefined : "Model ID is required"),
    })
  ).trim();
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
            const config = applyLitellmBaseUrl(ctx.config, baseUrl);
            const flagValue = normalizeOptionalSecretInput(ctx.opts?.litellmApiKey);
            const { apiKey, input, mode } = await captureProviderApiKey(ctx, {
              provider: PROVIDER_ID,
              expectedProviders: [PROVIDER_ID],
              envLabel: "LITELLM_API_KEY",
              promptMessage: "Enter LiteLLM API key",
              noteTitle: "LiteLLM",
              noteMessage: [
                "LiteLLM provides a unified API to 100+ LLM providers.",
                "Get your API key from your LiteLLM proxy or https://litellm.ai",
                "Default proxy runs on http://localhost:4000",
              ].join("\n"),
              token: flagValue ?? normalizeOptionalSecretInput(ctx.opts?.token),
              tokenProvider: flagValue
                ? PROVIDER_ID
                : normalizeOptionalSecretInput(ctx.opts?.tokenProvider),
              env: ctx.env,
            });
            const modelId = ctx.credentialOnly
              ? undefined
              : await promptLitellmModel({ ...ctx, config }, apiKey);
            return {
              profiles: [
                {
                  profileId: "litellm:default",
                  credential: buildApiKeyCredential(
                    PROVIDER_ID,
                    input,
                    undefined,
                    mode ? { secretInputMode: mode, config } : undefined,
                  ),
                },
              ],
              configPatch: modelId ? await applyLitellmModelConfig(config, modelId) : config,
              ...(modelId ? { defaultModel: `${PROVIDER_ID}/${modelId}` } : {}),
            };
          },
          runNonInteractive: async (ctx: ProviderAuthMethodNonInteractiveContext) => {
            const runNonInteractive = apiKeyAuth.runNonInteractive;
            if (!runNonInteractive) {
              return null;
            }
            const urlError = validateProxyBaseUrl(
              normalizeOptionalSecretInput(ctx.opts.customBaseUrl) ?? "",
            );
            if (urlError) {
              // Resolve the key as usual so setup parity holds, but never store it for a bad URL.
              await runNonInteractive({
                ...ctx,
                resolveApiKey: async (params) => {
                  await ctx.resolveApiKey(params);
                  return null;
                },
              });
              ctx.runtime.error(urlError);
              ctx.runtime.exit(1);
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
