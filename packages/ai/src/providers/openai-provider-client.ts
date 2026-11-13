import OpenAI, { AzureOpenAI } from "openai";
import { getAiTransportHost } from "../host.js";
import { buildGuardedModelFetch } from "../transports/host-policy.js";
import { resolveAzureOpenAIApiVersion } from "../transports/openai-responses-replay-internal.js";
import { buildOpenAISdkClientOptions } from "../transports/openai-transport-params.js";
import {
  resolveOpenAIClientBaseUrl,
  withOpenAIErrorResponseHook,
} from "../transports/openai-transport-shared.js";
import type { Model, ModelRequestHeaders, StreamOptions } from "../types.js";
import { isOpenAICompatibleAzureResponsesBaseUrl } from "./azure-openai-responses-client-compat.js";
import { isCloudflareProvider, resolveCloudflareBaseUrl } from "./cloudflare.js";

export function createOpenAIProviderClient(
  model: Model<"openai-completions" | "openai-responses">,
  apiKey: string,
  headers: ModelRequestHeaders,
  optionsHeaders?: ModelRequestHeaders,
  onResponse?: StreamOptions["onResponse"],
): OpenAI {
  // Merge options headers last so they can override defaults
  if (optionsHeaders) {
    Object.assign(headers, optionsHeaders);
  }

  const defaultHeaders =
    model.provider === "cloudflare-ai-gateway"
      ? {
          ...headers,
          Authorization: headers.Authorization ?? null,
          "cf-aig-authorization": `Bearer ${apiKey}`,
        }
      : headers;

  const baseUrl = isCloudflareProvider(model.provider)
    ? resolveCloudflareBaseUrl(model)
    : model.baseUrl;
  return new OpenAI({
    apiKey,
    baseURL: resolveOpenAIClientBaseUrl(model, baseUrl),
    dangerouslyAllowBrowser: true,
    defaultHeaders,
    maxRetries: 0,
    // OpenAI supports custom fetch, so sentinels stay opaque until guarded egress.
    fetch: withOpenAIErrorResponseHook(
      getAiTransportHost().buildModelFetch(model) ?? globalThis.fetch,
      onResponse,
      model,
    ),
  });
}

export function createOpenAIResponsesClient(
  model: Model,
  apiKey: string,
  defaultHeaders: ModelRequestHeaders,
  fetchOverride?: typeof globalThis.fetch,
) {
  return new OpenAI({
    apiKey,
    baseURL: resolveOpenAIClientBaseUrl(model),
    dangerouslyAllowBrowser: true,
    defaultHeaders,
    fetch: fetchOverride ?? buildGuardedModelFetch(model),
    ...buildOpenAISdkClientOptions(model),
  });
}

export function createAzureOpenAIClient(
  model: Model,
  apiKey: string,
  defaultHeaders: ModelRequestHeaders,
  fetchOverride?: typeof globalThis.fetch,
) {
  const baseURL = model.baseUrl.replace(/\/+$/, "");
  const clientOptions = {
    apiKey,
    dangerouslyAllowBrowser: true,
    defaultHeaders,
    baseURL,
    fetch: fetchOverride ?? buildGuardedModelFetch(model),
    ...buildOpenAISdkClientOptions(model),
  };

  if (isOpenAICompatibleAzureResponsesBaseUrl(baseURL)) {
    return new OpenAI(clientOptions);
  }

  return new AzureOpenAI({
    ...clientOptions,
    apiVersion: resolveAzureOpenAIApiVersion(),
  });
}
