import type { StreamFn } from "@mariozechner/pi-agent-core";
import type { Api, Model } from "@mariozechner/pi-ai";
import { createAnthropicMessagesTransportStreamFn } from "./anthropic-transport-stream.js";
import {
  createAzureOpenAIResponsesTransportStreamFn,
  createOpenAICompletionsTransportStreamFn,
  createOpenAIResponsesTransportStreamFn,
} from "./openai-transport-stream.js";
import { getModelProviderRequestTransport } from "./provider-request-config.js";

const SUPPORTED_TRANSPORT_APIS = new Set<Api>([
  "openai-responses",
  "openai-completions",
  "azure-openai-responses",
  "anthropic-messages",
]);

const SIMPLE_TRANSPORT_API_ALIAS: Record<string, Api> = {
  "openai-responses": "openclaw-openai-responses-transport",
  "openai-completions": "openclaw-openai-completions-transport",
  "azure-openai-responses": "openclaw-azure-openai-responses-transport",
  "anthropic-messages": "openclaw-anthropic-messages-transport",
};

function hasTransportOverrides(model: Model<Api>): boolean {
  const request = getModelProviderRequestTransport(model);
  return Boolean(request?.proxy || request?.tls);
}

export function isTransportAwareApiSupported(api: Api): boolean {
  return SUPPORTED_TRANSPORT_APIS.has(api);
}

export function resolveTransportAwareSimpleApi(api: Api): Api | undefined {
  return SIMPLE_TRANSPORT_API_ALIAS[api];
}

export function createTransportAwareStreamFnForModel(model: Model<Api>): StreamFn | undefined {
  if (!hasTransportOverrides(model)) {
    return undefined;
  }
  if (!isTransportAwareApiSupported(model.api)) {
    throw new Error(
      `Model-provider request.proxy/request.tls is not yet supported for api "${model.api}"`,
    );
  }
  switch (model.api) {
    case "openai-responses":
      return createOpenAIResponsesTransportStreamFn();
    case "openai-completions":
      return createOpenAICompletionsTransportStreamFn();
    case "azure-openai-responses":
      return createAzureOpenAIResponsesTransportStreamFn();
    case "anthropic-messages":
      return createAnthropicMessagesTransportStreamFn();
    default:
      return undefined;
  }
}

export function prepareTransportAwareSimpleModel<TApi extends Api>(model: Model<TApi>): Model<Api> {
  const streamFn = createTransportAwareStreamFnForModel(model as Model<Api>);
  const alias = resolveTransportAwareSimpleApi(model.api);
  if (!streamFn || !alias) {
    return model;
  }
  return {
    ...model,
    api: alias,
  };
}

export function buildTransportAwareSimpleStreamFn(model: Model<Api>): StreamFn | undefined {
  return createTransportAwareStreamFnForModel(model);
}
