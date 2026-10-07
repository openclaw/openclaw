import OpenAI, { AzureOpenAI } from "openai";
import type { ResponseCreateParamsStreaming } from "openai/resources/responses/responses.js";
import { getEnvApiKey } from "../env-api-keys.js";
import { getAiTransportHost } from "../host.js";
import type { BaseOpenAIStreamOptions } from "../provider-options.js";
import type { OpenAIResponsesReplayMode } from "../transports/openai-responses-compaction-replay.js";
import type { OpenAIResponsesRequestParams } from "../transports/openai-responses-contracts.js";
import { resolvePromptCacheKey } from "../transports/openai-transport-shared.js";
import type { Context, Model, SimpleStreamOptions, StreamFunction } from "../types.js";
import { AssistantMessageEventStream } from "../utils/event-stream.js";
import { requireApiKey } from "../utils/required-api-key.js";
import { resolveAzureDeploymentNameFromMap } from "./azure-deployment-map.js";
import {
  isOpenAICompatibleAzureResponsesBaseUrl,
  isTraditionalAzureOpenAIHost,
} from "./azure-openai-responses-client-compat.js";
import {
  resolveOpenAISimpleReasoningEffort,
  type OpenAIRequestReasoningEffort,
} from "./openai-request-reasoning.js";
import {
  applyCommonResponsesParams,
  convertResponsesMessages,
  createResponsesAssistantOutput,
  runResponsesStreamLifecycle,
} from "./openai-responses-shared.js";
import { buildBaseOptions } from "./simple-options.js";

const DEFAULT_AZURE_API_VERSION = "v1";
const AZURE_TOOL_CALL_PROVIDERS = new Set(["openai", "opencode", "azure-openai-responses"]);

function resolveDeploymentName(
  model: Model<"azure-openai-responses">,
  options?: AzureOpenAIResponsesOptions,
): string {
  if (options?.azureDeploymentName) {
    return options.azureDeploymentName;
  }
  return resolveAzureDeploymentNameFromMap({
    modelId: model.id,
    deploymentMap: process.env.AZURE_OPENAI_DEPLOYMENT_NAME_MAP,
  });
}

interface AzureOpenAIResponsesOptions extends BaseOpenAIStreamOptions {
  reasoningEffort?: OpenAIRequestReasoningEffort;
  reasoningSummary?: "auto" | "detailed" | "concise" | null;
  azureApiVersion?: string;
  azureResourceName?: string;
  azureBaseUrl?: string;
  azureDeploymentName?: string;
}

export const streamAzureOpenAIResponses: StreamFunction<
  "azure-openai-responses",
  AzureOpenAIResponsesOptions
> = (model, context, options) => {
  const stream = new AssistantMessageEventStream();
  const output = createResponsesAssistantOutput(model, "azure-openai-responses");

  void runResponsesStreamLifecycle({
    stream,
    model,
    output,
    options,
    resolveRequestModel: (requestModel) => {
      const { baseUrl } = resolveAzureConfig(requestModel, options);
      return baseUrl === requestModel.baseUrl ? requestModel : { ...requestModel, baseUrl };
    },
    createClient: (requestModel) => {
      const apiKey = options?.apiKey || getEnvApiKey(model.provider) || "";
      return createClient(requestModel, apiKey, options);
    },
    buildParams: (requestModel, replayMode) =>
      buildParams(
        requestModel,
        context,
        options,
        resolveDeploymentName(model, options),
        replayMode,
      ),
  });

  return stream;
};

export const streamSimpleAzureOpenAIResponses: StreamFunction<
  "azure-openai-responses",
  SimpleStreamOptions
> = (model, context, options) => {
  const apiKey = requireApiKey(model.provider, options?.apiKey);

  const base = buildBaseOptions(model, options, apiKey);
  const authProfileId = (options as (SimpleStreamOptions & { authProfileId?: string }) | undefined)
    ?.authProfileId;
  return streamAzureOpenAIResponses(model, context, {
    ...base,
    authProfileId,
    reasoningEffort: resolveOpenAISimpleReasoningEffort(model, options?.reasoning),
  } satisfies AzureOpenAIResponsesOptions);
};

function normalizeAzureBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  const url = URL.parse(trimmed);
  if (!url) {
    throw new Error(`Invalid Azure OpenAI base URL: ${baseUrl}`);
  }

  const normalizedPath = url.pathname.replace(/\/+$/, "");

  // Ensure Azure hosts have /openai/v1 as base path so the AzureOpenAI SDK
  // can append /deployments/<model>/... and ?api-version=v1 correctly.
  if (
    isTraditionalAzureOpenAIHost(url.hostname) &&
    (normalizedPath === "" || normalizedPath === "/" || normalizedPath === "/openai")
  ) {
    url.pathname = "/openai/v1";
    url.search = "";
  }

  return url.toString().replace(/\/+$/, "");
}

function resolveAzureConfig(
  model: Model<"azure-openai-responses">,
  options?: AzureOpenAIResponsesOptions,
): { baseUrl: string; apiVersion: string } {
  const apiVersion =
    options?.azureApiVersion || process.env.AZURE_OPENAI_API_VERSION || DEFAULT_AZURE_API_VERSION;

  const baseUrl =
    options?.azureBaseUrl?.trim() || process.env.AZURE_OPENAI_BASE_URL?.trim() || undefined;
  const resourceName = options?.azureResourceName || process.env.AZURE_OPENAI_RESOURCE_NAME;

  const resolvedBaseUrl =
    baseUrl ||
    (resourceName ? `https://${resourceName}.openai.azure.com/openai/v1` : model.baseUrl);

  if (!resolvedBaseUrl) {
    throw new Error(
      "Azure OpenAI base URL is required. Set AZURE_OPENAI_BASE_URL or AZURE_OPENAI_RESOURCE_NAME, or pass azureBaseUrl, azureResourceName, or model.baseUrl.",
    );
  }

  return {
    baseUrl: normalizeAzureBaseUrl(resolvedBaseUrl),
    apiVersion,
  };
}

function createClient(
  model: Model<"azure-openai-responses">,
  apiKeyInput: string,
  options?: AzureOpenAIResponsesOptions,
) {
  const apiKey = apiKeyInput.trim();
  if (!apiKey) {
    throw new Error(
      "Azure OpenAI API key is required. Set AZURE_OPENAI_API_KEY environment variable or pass it as an argument.",
    );
  }

  const headers = { ...model.headers };
  if (options?.headers) {
    Object.assign(headers, options.headers);
  }
  const { baseUrl, apiVersion } = resolveAzureConfig(model, options);
  // Both OpenAI clients support custom fetch, so sentinels stay opaque until guarded egress.
  const clientOptions = {
    apiKey,
    dangerouslyAllowBrowser: true,
    defaultHeaders: headers,
    baseURL: baseUrl,
    fetch: getAiTransportHost().buildModelFetch({ ...model, baseUrl }),
    maxRetries: 0,
  };
  return isOpenAICompatibleAzureResponsesBaseUrl(baseUrl)
    ? new OpenAI(clientOptions)
    : new AzureOpenAI({ ...clientOptions, apiVersion });
}

function buildParams(
  model: Model<"azure-openai-responses">,
  context: Context,
  options: AzureOpenAIResponsesOptions | undefined,
  deploymentName: string,
  replayMode: OpenAIResponsesReplayMode,
) {
  const messages = convertResponsesMessages(model, context, AZURE_TOOL_CALL_PROVIDERS, {
    sessionId: options?.sessionId,
    authProfileId: options?.authProfileId,
    replayMode,
  });

  const params: ResponseCreateParamsStreaming & OpenAIResponsesRequestParams = {
    model: deploymentName,
    input: messages,
    stream: true,
    prompt_cache_key: resolvePromptCacheKey(options, options?.cacheRetention ?? "short"),
    store: false,
  };

  applyCommonResponsesParams(params, model, context, options);

  return params;
}
