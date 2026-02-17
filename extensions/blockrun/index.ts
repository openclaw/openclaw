import {
  emptyPluginConfigSchema,
  type OpenClawPluginApi,
  type ProviderAuthContext,
  type ProviderAuthResult,
} from "openclaw/plugin-sdk";

const PROVIDER_ID = "blockrun";
const PROVIDER_LABEL = "BlockRun";
const DEFAULT_BASE_URL = "http://127.0.0.1:8402/v1";
const DEFAULT_MODEL = "blockrun/auto";
const DEFAULT_CONTEXT_WINDOW = 1_050_000;
const DEFAULT_MAX_TOKENS = 128_000;

// Smart routing meta-models
const ROUTING_MODELS = [
  {
    id: "auto",
    name: "Auto (Smart Router - Balanced)",
    contextWindow: 1_050_000,
    maxOutput: 128_000,
  },
  {
    id: "free",
    name: "Free (NVIDIA GPT-OSS-120B only)",
    contextWindow: 128_000,
    maxOutput: 4_096,
  },
  {
    id: "eco",
    name: "Eco (Smart Router - Cost Optimized)",
    contextWindow: 1_050_000,
    maxOutput: 128_000,
  },
  {
    id: "premium",
    name: "Premium (Smart Router - Best Quality)",
    contextWindow: 2_000_000,
    maxOutput: 200_000,
  },
] as const;

// Popular direct models (subset - full list available via ClawRouter)
const DIRECT_MODELS = [
  { id: "openai/gpt-5.2", name: "GPT-5.2", vision: true },
  { id: "openai/gpt-4o", name: "GPT-4o", vision: true },
  { id: "openai/gpt-4o-mini", name: "GPT-4o Mini", vision: true },
  { id: "anthropic/claude-opus-4.6", name: "Claude Opus 4.6", vision: true },
  { id: "anthropic/claude-sonnet-4", name: "Claude Sonnet 4", vision: true },
  { id: "anthropic/claude-haiku-4.5", name: "Claude Haiku 4.5", vision: true },
  { id: "google/gemini-2.5-pro", name: "Gemini 2.5 Pro", vision: true },
  { id: "google/gemini-2.5-flash", name: "Gemini 2.5 Flash", vision: true },
  { id: "deepseek/deepseek-chat", name: "DeepSeek Chat", vision: false },
  { id: "deepseek/deepseek-reasoner", name: "DeepSeek Reasoner", vision: false },
  { id: "xai/grok-3", name: "Grok 3", vision: true },
] as const;

function normalizeBaseUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return DEFAULT_BASE_URL;
  }
  let normalized = trimmed;
  while (normalized.endsWith("/")) {
    normalized = normalized.slice(0, -1);
  }
  if (!normalized.endsWith("/v1")) {
    normalized = `${normalized}/v1`;
  }
  return normalized;
}

function validateBaseUrl(value: string): string | undefined {
  const normalized = normalizeBaseUrl(value);
  try {
    new URL(normalized);
  } catch {
    return "Enter a valid URL";
  }
  return undefined;
}

function buildModelDefinition(params: {
  id: string;
  name: string;
  contextWindow?: number;
  maxOutput?: number;
  vision?: boolean;
}) {
  return {
    id: params.id,
    name: params.name,
    api: "openai-completions" as const,
    reasoning: false,
    input:
      params.vision !== false
        ? (["text", "image"] as Array<"text" | "image">)
        : (["text"] as Array<"text">),
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: params.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
    maxTokens: params.maxOutput ?? DEFAULT_MAX_TOKENS,
  };
}

const blockrunPlugin = {
  id: "blockrun",
  name: "BlockRun",
  description: "Smart LLM routing with x402 micropayments — 30+ models, no API keys needed",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    api.registerProvider({
      id: PROVIDER_ID,
      label: PROVIDER_LABEL,
      docsPath: "/providers/blockrun",
      auth: [
        {
          id: "local",
          label: "ClawRouter Proxy",
          hint: "Connect to local ClawRouter proxy for smart model routing",
          kind: "custom",
          run: async (ctx: ProviderAuthContext): Promise<ProviderAuthResult> => {
            const baseUrlInput = await ctx.prompter.text({
              message: "ClawRouter proxy URL",
              initialValue: DEFAULT_BASE_URL,
              validate: validateBaseUrl,
            });

            const baseUrl = normalizeBaseUrl(baseUrlInput);

            // Build model definitions
            const routingModelDefs = ROUTING_MODELS.map((m) =>
              buildModelDefinition({
                id: m.id,
                name: m.name,
                contextWindow: m.contextWindow,
                maxOutput: m.maxOutput,
                vision: true,
              }),
            );

            const directModelDefs = DIRECT_MODELS.map((m) =>
              buildModelDefinition({
                id: m.id,
                name: m.name,
                vision: m.vision,
              }),
            );

            const allModels = [...routingModelDefs, ...directModelDefs];

            // Build model aliases for agents.defaults.models
            const modelAliases: Record<string, Record<string, unknown>> = {};
            for (const model of ROUTING_MODELS) {
              modelAliases[`blockrun/${model.id}`] = {};
            }
            for (const model of DIRECT_MODELS) {
              modelAliases[`blockrun/${model.id}`] = {};
            }

            return {
              profiles: [
                {
                  profileId: "blockrun:local",
                  credential: {
                    type: "token",
                    provider: PROVIDER_ID,
                    token: "x402", // ClawRouter uses x402 micropayments, no API key needed
                  },
                },
              ],
              configPatch: {
                models: {
                  providers: {
                    [PROVIDER_ID]: {
                      baseUrl,
                      apiKey: "x402",
                      api: "openai-completions",
                      authHeader: false,
                      models: allModels,
                    },
                  },
                },
                agents: {
                  defaults: {
                    models: modelAliases,
                  },
                },
              },
              defaultModel: DEFAULT_MODEL,
              notes: [
                "Start ClawRouter before using: npx @blockrun/clawrouter start",
                "Smart routing: 'blockrun/auto' picks the best model for each request.",
                "Free tier: 'blockrun/free' uses NVIDIA GPT-OSS-120B at $0 cost.",
                "Direct access: Use 'blockrun/openai/gpt-4o' or 'blockrun/anthropic/claude-sonnet-4'.",
                "Wallet: ClawRouter auto-generates a wallet. Fund it at https://blockrun.ai/fund",
              ],
            };
          },
        },
      ],
    });
  },
};

export default blockrunPlugin;
