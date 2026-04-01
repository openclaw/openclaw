import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi, AnyAgentTool } from "openclaw/plugin-sdk";
import { textResult } from "../tools/common.js";
import { ModelRegistry } from "./registry.js";
import { ModelResolver } from "./resolver.js";
import type { ModelRouterConfig } from "./types.js";

export function registerModelRouter(
  api: OpenClawPluginApi,
  config: { modelRouter?: ModelRouterConfig },
): void {
  const log = api.logger;
  const routerConfig = config.modelRouter ?? {};
  const registry = new ModelRegistry();
  const resolver = new ModelResolver(registry, routerConfig);

  // Tool: model_list
  api.registerTool({
    name: "model_list",
    label: "List Models",
    description: "List all available AI models with pricing and capabilities.",
    parameters: Type.Object({
      provider: Type.Optional(Type.String({ description: "Filter by provider" })),
    }),
    async execute(_id: string, params: { provider?: string }) {
      const models = params.provider
        ? registry.listByProvider(params.provider)
        : registry.listModels();
      const lines = models.map(
        (m) =>
          `${m.provider}/${m.id} — ctx:${m.contextWindow / 1000}K out:${m.maxOutput / 1000}K in:$${m.inputPricePer1kTokens}/1K out:$${m.outputPricePer1kTokens}/1K${m.supportsPromptCaching ? " [cache]" : ""}${m.supportsExtendedThinking ? " [thinking]" : ""}`,
      );
      return textResult(`Available models (${models.length}):\n${lines.join("\n")}`);
    },
  } as AnyAgentTool);

  // Tool: model_cost
  api.registerTool({
    name: "model_cost",
    label: "Estimate Model Cost",
    description: "Estimate the cost of a prompt for a given model.",
    parameters: Type.Object({
      model: Type.String({ description: "Model ID" }),
      input_tokens: Type.Number({ description: "Estimated input tokens" }),
      output_tokens: Type.Number({ description: "Estimated output tokens" }),
    }),
    async execute(
      _id: string,
      params: { model: string; input_tokens: number; output_tokens: number },
    ) {
      const cost = registry.estimateCost(params.model, params.input_tokens, params.output_tokens);
      return textResult(
        `Estimated cost for ${params.model}: $${cost.toFixed(6)} (${params.input_tokens} input + ${params.output_tokens} output tokens)`,
      );
    },
  } as AnyAgentTool);

  // Hook: before_model_resolve
  api.on("before_model_resolve", async (ctx: any) => {
    if (!ctx.requestedModel) return;
    try {
      const resolved = resolver.resolve(ctx.requestedModel);
      ctx.model = resolved.modelId;
      ctx.provider = resolved.provider;
      if (routerConfig.promptCaching?.enabled !== false && resolved.spec.supportsPromptCaching) {
        ctx.systemPromptCacheControl = true;
      }
    } catch {
      // Let default resolution handle it
    }
  });

  log.info(
    `[model-router] Model router initialized (${registry.listModels().length} models, fallback chain: ${routerConfig.fallbackChain?.join(" → ") ?? "none"})`,
  );
}

export { ModelRegistry } from "./registry.js";
export { ModelResolver } from "./resolver.js";
