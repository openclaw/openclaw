import { emptyPluginConfigSchema } from "clawdbot/plugin-sdk";

const PROVIDER_ID = "openrouter";
const PROVIDER_LABEL = "OpenRouter";
const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
const DEFAULT_MAX_TOKENS = 4096;
const ENV_VARS = ["OPENROUTER_API_KEY", "OPENCLAW_OPENROUTER_API_KEY"];

// Free models on OpenRouter (updated 2026-02-06)
// Note: Free model availability changes frequently - check openrouter.ai for current list
export const FREE_MODELS = [
  { id: "openrouter/auto", context: 128_000, description: "Auto-select best free model" },
  { id: "qwen/qwen3-next-80b-a3b-instruct:free", context: 262_144, description: "Qwen3 Next 80B" },
  { id: "qwen/qwen3-coder:free", context: 262_000, description: "Qwen3 Coder 480B" },
  { id: "stepfun/step-3.5-flash:free", context: 256_000, description: "StepFun 3.5 Flash" },
  { id: "deepseek/deepseek-r1-0528:free", context: 163_840, description: "DeepSeek R1" },
  { id: "meta-llama/llama-3.3-70b-instruct:free", context: 128_000, description: "Llama 3.3 70B" },
  { id: "arcee-ai/trinity-mini:free", context: 131_072, description: "Arcee Trinity Mini" },
  { id: "openai/gpt-oss-120b:free", context: 131_072, description: "GPT OSS 120B" },
  { id: "nvidia/nemotron-3-nano-30b-a3b:free", context: 256_000, description: "Nemotron 3 Nano" },
] as const;

export type FreeModel = (typeof FREE_MODELS)[number];

/**
 * Validate OpenRouter API key format
 */
export function validateApiKey(key: string): string | undefined {
  const trimmed = key.trim();
  if (!trimmed) {
    return "API key is required";
  }
  if (!trimmed.startsWith("sk-or-")) {
    return "OpenRouter keys start with 'sk-or-'";
  }
  if (trimmed.length < 20) {
    return "API key appears too short";
  }
  return undefined;
}

/**
 * Parse comma/newline separated model list
 */
export function parseModelIds(input: string): string[] {
  return input
    .split(/[\n,]/)
    .map((model) => model.trim())
    .filter(Boolean);
}

/**
 * Build model definition for OpenClaw
 */
export function buildModelDefinition(model: FreeModel | { id: string; context?: number }) {
  const isFreeModel = "description" in model;
  return {
    id: model.id,
    name: isFreeModel ? model.description : model.id,
    api: "openai-completions",
    reasoning: model.id.includes("deepseek-r1"),
    input: ["text", "image"] as const,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: model.context ?? 128_000,
    maxTokens: DEFAULT_MAX_TOKENS,
  };
}

/**
 * Get API key from environment
 */
export function getApiKeyFromEnv(): string | undefined {
  for (const envVar of ENV_VARS) {
    const value = process.env[envVar];
    if (value && value.startsWith("sk-or-")) {
      return value;
    }
  }
  return undefined;
}

/**
 * Convert OpenRouter model ID to OpenClaw model ref
 */
export function toModelRef(modelId: string): string {
  // openrouter/auto -> openrouter/auto
  // google/gemini-2.0-flash-exp:free -> openrouter/google/gemini-2.0-flash-exp/free
  if (modelId.startsWith("openrouter/")) {
    return modelId;
  }
  return `openrouter/${modelId.replace(":", "/")}`;
}

const openrouterPlugin = {
  id: "openrouter",
  name: "OpenRouter",
  description: "OpenRouter multi-provider API with 18+ free models",
  configSchema: emptyPluginConfigSchema(),

  register(api) {
    api.registerProvider({
      id: PROVIDER_ID,
      label: PROVIDER_LABEL,
      docsPath: "/providers/openrouter",
      aliases: ["or", "free"],
      envVars: ENV_VARS,
      auth: [
        {
          id: "api-key",
          label: "API Key",
          hint: "Enter your OpenRouter API key (sk-or-...)",
          kind: "custom",
          run: async (ctx) => {
            // Step 1: Get API key
            const apiKey = await ctx.prompter.password({
              message: "OpenRouter API Key",
              validate: validateApiKey,
            });

            // Step 2: Select models
            const freeModelIds = FREE_MODELS.map((m) => m.id).join(", ");
            const modelInput = await ctx.prompter.text({
              message: "Models to enable",
              initialValue: freeModelIds,
              validate: (value) =>
                parseModelIds(value).length > 0 ? undefined : "Select at least one model",
            });

            const modelIds = parseModelIds(modelInput);
            const defaultModelRef = toModelRef(modelIds[0] ?? "openrouter/auto");

            return {
              profiles: [
                {
                  profileId: "openrouter:default",
                  credential: {
                    type: "api_key",
                    provider: PROVIDER_ID,
                    key: apiKey,
                  },
                },
              ],
              configPatch: {
                models: {
                  providers: {
                    [PROVIDER_ID]: {
                      baseUrl: OPENROUTER_BASE_URL,
                      api: "openai-completions",
                      headers: {
                        "HTTP-Referer": "https://github.com/openclaw/openclaw",
                        "X-Title": "OpenClaw Agent",
                      },
                      models: modelIds.map((id) => {
                        const known = FREE_MODELS.find((m) => m.id === id);
                        return known
                          ? buildModelDefinition(known)
                          : buildModelDefinition({ id, context: 128_000 });
                      }),
                    },
                  },
                },
                agents: {
                  defaults: {
                    models: Object.fromEntries(modelIds.map((id) => [toModelRef(id), {}])),
                  },
                },
              },
              defaultModel: defaultModelRef,
              notes: [
                "OpenRouter provides 18+ free models at zero cost",
                "Free models may log prompts for improvement",
                "Use :free suffix for free model variants",
              ],
            };
          },
        },
        {
          id: "env",
          label: "From Environment",
          hint: "Use OPENROUTER_API_KEY from environment",
          kind: "custom",
          run: async (ctx) => {
            const apiKey = getApiKeyFromEnv();
            if (!apiKey) {
              await ctx.prompter.note(
                `No OpenRouter API key found in environment.\n\nSet one of: ${ENV_VARS.join(", ")}`,
                "Missing API Key",
              );
              throw new Error("OPENROUTER_API_KEY not found in environment");
            }

            const modelIds = FREE_MODELS.map((m) => m.id);
            const defaultModelRef = "openrouter/auto";

            return {
              profiles: [
                {
                  profileId: "openrouter:env",
                  credential: {
                    type: "api_key",
                    provider: PROVIDER_ID,
                    key: apiKey,
                  },
                },
              ],
              configPatch: {
                models: {
                  providers: {
                    [PROVIDER_ID]: {
                      baseUrl: OPENROUTER_BASE_URL,
                      api: "openai-completions",
                      headers: {
                        "HTTP-Referer": "https://github.com/openclaw/openclaw",
                        "X-Title": "OpenClaw Agent",
                      },
                      models: FREE_MODELS.map(buildModelDefinition),
                    },
                  },
                },
                agents: {
                  defaults: {
                    models: Object.fromEntries(modelIds.map((id) => [toModelRef(id), {}])),
                  },
                },
              },
              defaultModel: defaultModelRef,
              notes: ["Using API key from environment", "All free models enabled by default"],
            };
          },
        },
      ],
    });
  },
};

export default openrouterPlugin;
