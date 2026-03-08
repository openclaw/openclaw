import {
  emptyPluginConfigSchema,
  type OpenClawPluginApi,
  type ProviderAuthContext,
  type ProviderAuthResult,
} from "openclaw/plugin-sdk/crust-proxy";

const DEFAULT_BASE_URL = "http://localhost:9090";
const PLACEHOLDER_API_KEY = "crust-managed";
const DEFAULT_CONTEXT_WINDOW = 128_000;
const DEFAULT_MAX_TOKENS = 8192;

const OPENAI_PROVIDER_ID = "crust-openai";
const OPENAI_DEFAULT_MODELS = [
  "gpt-5.2",
  "gpt-5.2-codex",
  "gpt-5-mini",
  "claude-sonnet-4.5",
  "gemini-3-flash",
  "kimi-k2.5",
] as const;

const ANTHROPIC_PROVIDER_ID = "crust-anthropic";
const ANTHROPIC_DEFAULT_MODELS = [
  "claude-sonnet-4.5",
  "claude-opus-4.5",
  "claude-haiku-4.5",
] as const;

type ProviderFlavor = {
  providerId: string;
  label: string;
  docsPath: string;
  api: "openai-completions" | "anthropic-messages";
  defaultModels: readonly string[];
  defaultAlias: string;
  modelInputHint: string;
};

function normalizeBaseUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return DEFAULT_BASE_URL;
  }
  return trimmed.replace(/\/+$/, "");
}

function validateBaseUrl(value: string): string | undefined {
  try {
    new URL(normalizeBaseUrl(value));
  } catch {
    return "Enter a valid URL";
  }
  return undefined;
}

function validateApiKey(value: string): string | undefined {
  return value.trim() ? undefined : "Enter an API key";
}

function parseModelIds(input: string, fallback: readonly string[]): string[] {
  const parsed = input
    .split(/[\n,]/)
    .map((modelId) => modelId.trim())
    .filter(Boolean);
  const deduped = Array.from(new Set(parsed));
  return deduped.length > 0 ? deduped : Array.from(fallback);
}

function hasExplicitModelIds(input: string): boolean {
  return input.split(/[\n,]/).some((modelId) => modelId.trim().length > 0);
}

function inferReasoning(modelId: string): boolean {
  const normalized = modelId.toLowerCase();
  const tokenizedReasoningPattern = /(^|[/:._-])(o1|o3|o4)(?=($|[/:._-]))/;
  return (
    normalized.includes("gpt-5") ||
    tokenizedReasoningPattern.test(normalized) ||
    normalized.includes("reason")
  );
}

function buildModelDefinition(modelId: string, api: ProviderFlavor["api"]) {
  return {
    id: modelId,
    name: modelId,
    api,
    reasoning: inferReasoning(modelId),
    input: ["text", "image"] as Array<"text" | "image">,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    maxTokens: DEFAULT_MAX_TOKENS,
  };
}

function buildAgentDefaults(
  providerId: string,
  modelIds: string[],
  defaultAlias: string,
): Record<string, { alias?: string }> {
  return Object.fromEntries(
    modelIds.map((modelId, index) => [
      `${providerId}/${modelId}`,
      index === 0 ? { alias: defaultAlias } : {},
    ]),
  );
}

async function runApiKeyFlow(
  ctx: ProviderAuthContext,
  flavor: ProviderFlavor,
): Promise<ProviderAuthResult> {
  const baseUrlInput = await ctx.prompter.text({
    message: `${flavor.label} base URL`,
    initialValue: DEFAULT_BASE_URL,
    validate: validateBaseUrl,
  });

  const apiKey = await ctx.prompter.text({
    message: `${flavor.label} upstream API key`,
    placeholder: "Paste the upstream API key that Crust should forward",
    validate: validateApiKey,
  });

  const modelInput = await ctx.prompter.text({
    message: `${flavor.label} model IDs (comma-separated)`,
    placeholder: `${flavor.modelInputHint} (blank keeps: ${flavor.defaultModels.join(", ")})`,
    validate: (value: string) =>
      !value.trim() || hasExplicitModelIds(value) ? undefined : "Enter at least one model id",
  });

  const baseUrl = normalizeBaseUrl(baseUrlInput);
  const modelIds = parseModelIds(modelInput, flavor.defaultModels);
  const defaultModelRef = `${flavor.providerId}/${modelIds[0]}`;

  return {
    profiles: [
      {
        profileId: `${flavor.providerId}:default`,
        credential: {
          type: "api_key",
          provider: flavor.providerId,
          key: apiKey.trim(),
        },
      },
    ],
    configPatch: {
      models: {
        providers: {
          [flavor.providerId]: {
            baseUrl,
            apiKey: PLACEHOLDER_API_KEY,
            api: flavor.api,
            models: modelIds.map((modelId) => buildModelDefinition(modelId, flavor.api)),
          },
        },
      },
      agents: {
        defaults: {
          models: buildAgentDefaults(flavor.providerId, modelIds, flavor.defaultAlias),
        },
      },
    },
    defaultModel: defaultModelRef,
    notes: [
      "Start Crust before using these models.",
      `Crust base URL defaults to ${DEFAULT_BASE_URL}.`,
      "This flow is intended for API-key based routing through Crust.",
    ],
  };
}

const crustProxyPlugin = {
  id: "crust-proxy",
  name: "Crust Proxy",
  description: "Provider plugin for routing model traffic through a local Crust gateway",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    api.registerProvider({
      id: OPENAI_PROVIDER_ID,
      label: "Crust (OpenAI-compatible)",
      docsPath: "/providers/models",
      aliases: ["crust-openai", "crust"],
      auth: [
        {
          id: "api-key",
          label: "API key via Crust",
          hint: "Configure OpenAI-compatible routing through a local Crust gateway",
          kind: "api_key",
          run: (ctx: ProviderAuthContext) =>
            runApiKeyFlow(ctx, {
              providerId: OPENAI_PROVIDER_ID,
              label: "Crust (OpenAI-compatible)",
              docsPath: "/providers/models",
              api: "openai-completions",
              defaultModels: OPENAI_DEFAULT_MODELS,
              defaultAlias: "crust",
              modelInputHint: "gpt-5.2-codex, claude-sonnet-4.5, gemini-3-flash, kimi-k2.5",
            }),
        },
      ],
    });

    api.registerProvider({
      id: ANTHROPIC_PROVIDER_ID,
      label: "Crust (Anthropic Messages)",
      docsPath: "/providers/anthropic",
      aliases: ["crust-anthropic"],
      auth: [
        {
          id: "api-key",
          label: "API key via Crust",
          hint: "Configure Anthropic Messages routing through a local Crust gateway",
          kind: "api_key",
          run: (ctx: ProviderAuthContext) =>
            runApiKeyFlow(ctx, {
              providerId: ANTHROPIC_PROVIDER_ID,
              label: "Crust (Anthropic Messages)",
              docsPath: "/providers/anthropic",
              api: "anthropic-messages",
              defaultModels: ANTHROPIC_DEFAULT_MODELS,
              defaultAlias: "crust-anthropic",
              modelInputHint: "claude-sonnet-4.5, claude-opus-4.5",
            }),
        },
      ],
    });
  },
};

export default crustProxyPlugin;
