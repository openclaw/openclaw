import { getApiProvider, type Api, type Model } from "@earendil-works/pi-ai";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createAnthropicVertexStreamFnForModel } from "./anthropic-vertex-stream.js";
import { ensureCustomApiRegistered } from "./custom-api-registry.js";
import { registerProviderStreamForModel } from "./provider-stream.js";
import {
  buildTransportAwareSimpleStreamFn,
  createOpenClawTransportStreamFnForModel,
  prepareTransportAwareSimpleModel,
  resolveTransportAwareSimpleApi,
} from "./provider-transport-stream.js";

function resolveAnthropicVertexSimpleApi(baseUrl?: string): Api {
  const suffix = baseUrl?.trim() ? encodeURIComponent(baseUrl.trim()) : "default";
  return `openclaw-anthropic-vertex-simple:${suffix}`;
}

function prepareCodexSimpleTransportModel<TApi extends Api>(
  model: Model<TApi>,
  cfg?: OpenClawConfig,
): Model<Api> | undefined {
  if (model.provider !== "openai-codex" || model.api !== "openai-codex-responses") {
    return undefined;
  }

  // Static Codex provider catalogs intentionally omit credentials; the simple
  // completion path must use OpenClaw's transport so resolved request auth is applied.
  const api = resolveTransportAwareSimpleApi(model.api);
  const streamFn = createOpenClawTransportStreamFnForModel(model as Model<Api>, { cfg });
  if (!api || !streamFn) {
    return undefined;
  }

  ensureCustomApiRegistered(api, streamFn);
  return {
    ...model,
    api,
  };
}

export function prepareModelForSimpleCompletion<TApi extends Api>(params: {
  model: Model<TApi>;
  cfg?: OpenClawConfig;
}): Model<Api> {
  const { model, cfg } = params;
  // Only provider-owned custom APIs need runtime stream registration here.
  if (!getApiProvider(model.api) && registerProviderStreamForModel({ model, cfg })) {
    return model;
  }

  const codexTransportModel = prepareCodexSimpleTransportModel(model, cfg);
  if (codexTransportModel) {
    return codexTransportModel;
  }

  const transportAwareModel = prepareTransportAwareSimpleModel(model, { cfg });
  if (transportAwareModel !== model) {
    const streamFn = buildTransportAwareSimpleStreamFn(model, { cfg });
    if (streamFn) {
      ensureCustomApiRegistered(transportAwareModel.api, streamFn);
      return transportAwareModel;
    }
  }

  if (model.provider === "anthropic-vertex") {
    const api = resolveAnthropicVertexSimpleApi(model.baseUrl);
    ensureCustomApiRegistered(api, createAnthropicVertexStreamFnForModel(model));
    return { ...model, api };
  }

  return model;
}
