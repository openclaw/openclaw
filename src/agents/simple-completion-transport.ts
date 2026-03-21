import type { Api, Model } from "@mariozechner/pi-ai";
import type { OpenClawConfig } from "../config/config.js";
import { createAnthropicVertexStreamFnForModel } from "./anthropic-vertex-stream.js";
import { ensureCustomApiRegistered } from "./custom-api-registry.js";
import { createConfiguredOllamaStreamFn } from "./ollama-stream.js";

function resolveAnthropicVertexSimpleApi(baseUrl?: string): Api {
  const suffix = baseUrl?.trim() ? encodeURIComponent(baseUrl.trim()) : "default";
  return `openclaw-anthropic-vertex-simple:${suffix}`;
}

export function prepareModelForSimpleCompletion<TApi extends Api>(params: {
  model: Model<TApi>;
  cfg?: OpenClawConfig;
}): Model<Api> {
  const { model, cfg } = params;
  if (model.api === "ollama") {
    const providerBaseUrl =
      typeof cfg?.models?.providers?.[model.provider]?.baseUrl === "string"
        ? cfg.models.providers[model.provider]?.baseUrl
        : undefined;
    ensureCustomApiRegistered(
      model.api,
      createConfiguredOllamaStreamFn({
        model,
        providerBaseUrl,
      }),
    );
    return model;
  }

  if (model.provider === "anthropic-vertex") {
    const api = resolveAnthropicVertexSimpleApi(model.baseUrl);
    ensureCustomApiRegistered(api, createAnthropicVertexStreamFnForModel(model));
    return { ...model, api };
  }

  return model;
}
