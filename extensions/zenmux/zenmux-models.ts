import type { ModelDefinitionConfig } from "openclaw/plugin-sdk/provider-model-shared";

export const ZENMUX_BASE_URL = "https://zenmux.ai/api/v1";
const ZENMUX_MODELS_URL = "https://zenmux.ai/api/v1/models";
const ZENMUX_DEFAULT_CONTEXT_WINDOW = 200000;
const ZENMUX_DEFAULT_MAX_TOKENS = 8192;
const ZENMUX_DEFAULT_COST = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
};

// Static fallback when discovery is unavailable (matches onboarding default model ref).
function staticZenmuxModelDefinitions(): ModelDefinitionConfig[] {
  return [
    {
      id: "openai/gpt-5.2",
      name: "GPT-5.2",
      reasoning: false,
      input: ["text", "image"],
      cost: ZENMUX_DEFAULT_COST,
      contextWindow: ZENMUX_DEFAULT_CONTEXT_WINDOW,
      maxTokens: ZENMUX_DEFAULT_MAX_TOKENS,
    },
  ];
}

type ZenMuxPricingType = {
  value: number;
  unit: string;
  currency: string;
};
interface ZenmuxModel {
  id: string;
  display_name: string;
  context_length: number;
  input_modalities: string[];
  output_modalities: string[];
  capabilities?: {
    reasoning?: boolean;
  };
  pricings: {
    prompt?: ZenMuxPricingType[];
    completion?: ZenMuxPricingType[];
    input_cache_read?: ZenMuxPricingType[];
    input_cache_write_5_min?: ZenMuxPricingType[];
    input_cache_write_1_h?: ZenMuxPricingType[];
    input_cache_write?: ZenMuxPricingType[];
    web_search?: ZenMuxPricingType[];
    internal_reasoning?: ZenMuxPricingType[];
    video?: ZenMuxPricingType[];
    image?: ZenMuxPricingType[];
    audio?: ZenMuxPricingType[];
    audio_and_video?: ZenMuxPricingType[];
  };
}

interface ZenmuxModelsResponse {
  data: ZenmuxModel[];
}

function extractZenmuxCost(pricings: ZenmuxModel["pricings"]): {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
} {
  const getPrice = (arr?: ZenMuxPricingType[]): number => arr?.[0]?.value ?? 0;

  return {
    input: getPrice(pricings.prompt),
    output: getPrice(pricings.completion),
    cacheRead: getPrice(pricings.input_cache_read),
    cacheWrite: getPrice(
      [
        pricings.input_cache_write,
        pricings.input_cache_write_5_min,
        pricings.input_cache_write_1_h,
      ].find((t) => t != null && t.length > 0),
    ),
  };
}

export async function discoverZenmuxModels(): Promise<ModelDefinitionConfig[]> {
  if (process.env.VITEST || process.env.NODE_ENV === "test") {
    return staticZenmuxModelDefinitions();
  }
  try {
    const response = await fetch(ZENMUX_MODELS_URL, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) {
      console.warn(
        `Failed to discover ZenMux models: HTTP ${response.status}, using static catalog`,
      );
      return staticZenmuxModelDefinitions();
    }
    const data = (await response.json()) as ZenmuxModelsResponse;
    if (!data.data || data.data.length === 0) {
      console.warn("No ZenMux models found, using static catalog");
      return staticZenmuxModelDefinitions();
    }
    return data.data.map((model) => {
      const inputModalities = model.input_modalities ?? ["text"];
      const hasImage = inputModalities.includes("image");
      const input: Array<"text" | "image"> = hasImage ? ["text", "image"] : ["text"];
      const cost = model.pricings ? extractZenmuxCost(model.pricings) : ZENMUX_DEFAULT_COST;
      return {
        id: model.id,
        name: model.display_name || model.id,
        reasoning: model.capabilities?.reasoning ?? false,
        input,
        cost,
        contextWindow: model.context_length ?? ZENMUX_DEFAULT_CONTEXT_WINDOW,
        maxTokens: ZENMUX_DEFAULT_MAX_TOKENS,
      };
    });
  } catch (error) {
    console.warn(`Discovery failed: ${String(error)}, using static catalog`);
    return staticZenmuxModelDefinitions();
  }
}
