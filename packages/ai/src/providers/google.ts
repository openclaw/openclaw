import { GoogleGenAI, type HttpOptions } from "@google/genai";
import { getEnvApiKey } from "../env-api-keys.js";
import { getAiTransportHost, resolveAiTransportHeaderSentinels } from "../host.js";
import { createAssistantOutput } from "../transports/assistant-output.js";
import { buildManagedModelFetch } from "../transports/host-policy.js";
import { resolveOpencodeSessionHeaders } from "../transports/session-affinity.js";
import { mergeTransportHeaders } from "../transports/transport-stream-shared.js";
import type { Model, SimpleStreamOptions, StreamFunction } from "../types.js";
import { AssistantMessageEventStream } from "../utils/event-stream.js";
import { requireApiKey } from "../utils/required-api-key.js";
import {
  buildGoogleGenerateContentParams,
  buildGoogleSimpleThinking,
  type GoogleProviderOptions,
  runGoogleGenerateContentLifecycle,
} from "./google-shared.js";
import { buildBaseOptions } from "./simple-options.js";

let toolCallCounter = 0;

export const streamGoogle: StreamFunction<"google-generative-ai", GoogleProviderOptions> = (
  model,
  context,
  options,
) => {
  const stream = new AssistantMessageEventStream();
  const output = createAssistantOutput(model, "google-generative-ai");

  void runGoogleGenerateContentLifecycle({
    stream,
    model,
    output,
    options,
    createClient: () => {
      const apiKey = options?.apiKey || getEnvApiKey(model.provider) || "";
      return createClient(model, apiKey, resolveOpencodeSessionHeaders(model, options));
    },
    buildParams: () => buildGoogleGenerateContentParams(model, context, options),
    nextToolCallId: (name) => `${name}_${Date.now()}_${++toolCallCounter}`,
  });

  return stream;
};

export const streamSimpleGoogle: StreamFunction<"google-generative-ai", SimpleStreamOptions> = (
  model,
  context,
  options,
) => {
  const apiKey = requireApiKey(model.provider, options?.apiKey);
  const base = buildBaseOptions(model, options, apiKey);
  return streamGoogle(model, context, {
    ...base,
    thinking: buildGoogleSimpleThinking(model, options),
  } satisfies GoogleProviderOptions);
};

function createClient(
  model: Model<"google-generative-ai">,
  apiKey?: string,
  optionsHeaders?: Record<string, string>,
): GoogleGenAI {
  const httpOptions: HttpOptions = {};
  const fetcher = buildManagedModelFetch(model);
  if (fetcher) {
    httpOptions.fetch = fetcher;
  }
  if (model.baseUrl) {
    httpOptions.baseUrl = model.baseUrl;
    httpOptions.apiVersion = ""; // baseUrl already includes version path, don't append
  }
  if (model.headers || optionsHeaders) {
    httpOptions.headers = resolveAiTransportHeaderSentinels(
      mergeTransportHeaders(model.headers, optionsHeaders),
    );
  }

  // Authentication is resolved before construction; the SDK also retains the host fetch policy.
  const resolvedApiKey = apiKey ? getAiTransportHost().resolveSecretSentinel(apiKey) : undefined;
  return new GoogleGenAI({
    apiKey: resolvedApiKey,
    httpOptions: Object.keys(httpOptions).length > 0 ? httpOptions : undefined,
  });
}
