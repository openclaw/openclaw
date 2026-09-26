import { GoogleGenAI } from "@google/genai";
import { getEnvApiKey } from "../env-api-keys.js";
import { getAiTransportHost, resolveAiTransportHeaderSentinels } from "../host.js";
import { createAssistantOutput } from "../transports/assistant-output.js";
import { resolveOpencodeSessionHeaders } from "../transports/session-affinity.js";
import { mergeTransportHeaders } from "../transports/transport-stream-shared.js";
import type { Context, Model, SimpleStreamOptions, StreamFunction } from "../types.js";
import { AssistantMessageEventStream } from "../utils/event-stream.js";
import {
  buildGoogleGenerateContentParams,
  buildGoogleSimpleThinking,
  type GoogleProviderOptions,
  runGoogleGenerateContentLifecycle,
} from "./google-shared.js";
import { buildBaseOptions } from "./simple-options.js";

type GoogleOptions = GoogleProviderOptions;

let toolCallCounter = 0;

export const streamGoogle: StreamFunction<"google-generative-ai", GoogleOptions> = (
  model: Model<"google-generative-ai">,
  context: Context,
  options?: GoogleOptions,
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
  model: Model<"google-generative-ai">,
  context: Context,
  options?: SimpleStreamOptions,
) => {
  const apiKey = options?.apiKey || getEnvApiKey(model.provider);
  if (!apiKey) {
    throw new Error(`No API key for provider: ${model.provider}`);
  }

  const base = buildBaseOptions(model, options, apiKey);
  return streamGoogle(model, context, {
    ...base,
    thinking: buildGoogleSimpleThinking(model, options),
  } satisfies GoogleOptions);
};

function createClient(
  model: Model<"google-generative-ai">,
  apiKey?: string,
  optionsHeaders?: Record<string, string>,
): GoogleGenAI {
  const httpOptions: { baseUrl?: string; apiVersion?: string; headers?: Record<string, string> } =
    {};
  if (model.baseUrl) {
    httpOptions.baseUrl = model.baseUrl;
    httpOptions.apiVersion = ""; // baseUrl already includes version path, don't append
  }
  if (model.headers || optionsHeaders) {
    httpOptions.headers = resolveAiTransportHeaderSentinels(
      mergeTransportHeaders(model.headers, optionsHeaders),
    );
  }

  // @google/genai exposes RequestInit options but no custom fetch; unwrap at construction.
  const resolvedApiKey = apiKey ? getAiTransportHost().resolveSecretSentinel(apiKey) : undefined;
  return new GoogleGenAI({
    apiKey: resolvedApiKey,
    httpOptions: Object.keys(httpOptions).length > 0 ? httpOptions : undefined,
  });
}
