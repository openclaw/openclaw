import { getApiProvider, type Api, type Model } from "@mariozechner/pi-ai";
import type { OpenClawConfig } from "../config/config.js";
import { createAnthropicVertexStreamFnForModel } from "./anthropic-vertex-stream.js";
import { ensureCustomApiRegistered } from "./custom-api-registry.js";
import { applyProviderAttributionHeadersToModel } from "./provider-attribution.js";
import { registerProviderStreamForModel } from "./provider-stream.js";
import {
  buildTransportAwareSimpleStreamFn,
  prepareTransportAwareSimpleModel,
} from "./provider-transport-stream.js";

function resolveAnthropicVertexSimpleApi(baseUrl?: string): Api {
  const suffix = baseUrl?.trim() ? encodeURIComponent(baseUrl.trim()) : "default";
  return `openclaw-anthropic-vertex-simple:${suffix}`;
}

export function prepareModelForSimpleCompletion<TApi extends Api>(params: {
  model: Model<TApi>;
  cfg?: OpenClawConfig;
}): Model<Api> {
  const { model, cfg } = params;
  // Only provider-owned custom APIs need runtime stream registration here.
  if (!getApiProvider(model.api) && registerProviderStreamForModel({ model, cfg })) {
    return applyProviderAttributionHeadersToModel(model);
  }

  const transportAwareModel = prepareTransportAwareSimpleModel(model);
  if (transportAwareModel !== model) {
    const streamFn = buildTransportAwareSimpleStreamFn(model);
    if (streamFn) {
      ensureCustomApiRegistered(transportAwareModel.api, streamFn);
      return applyProviderAttributionHeadersToModel(transportAwareModel);
    }
  }

  if (model.provider === "anthropic-vertex") {
    const api = resolveAnthropicVertexSimpleApi(model.baseUrl);
    ensureCustomApiRegistered(api, createAnthropicVertexStreamFnForModel(model));
    return applyProviderAttributionHeadersToModel({ ...model, api });
  }

  return applyProviderAttributionHeadersToModel(model);
}
