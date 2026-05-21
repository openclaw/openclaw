import { getApiProvider, type Api, type Model } from "@earendil-works/pi-ai";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createAnthropicVertexStreamFnForModel } from "./anthropic-vertex-stream.js";
import { ensureCustomApiRegistered } from "./custom-api-registry.js";
import { prepareGoogleSimpleCompletionModel } from "./google-simple-completion-stream.js";
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
    return model;
  }

  // Wrap pi-ai's native Google generative-ai stream with the shared Google
  // thinking-payload sanitizer so simple-completion entry points (e.g.
  // `openclaw model run` --transport=local) cannot send `thinkingBudget: -1`
  // to Google for Gemini aliases whose upstream pi-ai mapping returns -1
  // (e.g. `gemini-flash-latest`). The normal agent runtime already applies
  // this sanitizer via the embedded-runner stream wrappers; this keeps the
  // local simple-completion path consistent without forking pi-ai upstream.
  if (model.api === "google-generative-ai") {
    return prepareGoogleSimpleCompletionModel(model);
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
