import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { classifyPrompt } from "./src/classifier.js";
import { resolveModelForTier } from "./src/model-mapper.js";
import type { SmartRouterConfig } from "./src/types.js";

export default function register(api: OpenClawPluginApi) {
  const config = (api.pluginConfig ?? {}) as SmartRouterConfig;

  if (config.enabled === false) {
    api.logger.info("[smart-router] disabled via config");
    return;
  }

  api.on("before_model_resolve", (event) => {
    const result = classifyPrompt(event.prompt);
    const threshold = config.confidenceThreshold ?? 0.7;
    const effectiveTier = result.confidence < threshold ? "medium" : result.tier;

    if (config.debug) {
      api.logger.info(
        `[smart-router] tier=${effectiveTier} (raw=${result.tier}) ` +
          `confidence=${result.confidence.toFixed(2)} score=${result.weightedScore.toFixed(3)}`,
      );
    }

    const mapping = resolveModelForTier(effectiveTier, config);
    if (!mapping) return; // no override — use default model

    return {
      providerOverride: mapping.provider,
      modelOverride: mapping.model,
    };
  });
}
