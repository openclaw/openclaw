import { asRecord } from "@openclaw/normalization-core/record-coerce";
import {
  PROVIDER_CONTEXT_HANDOFF,
  PROVIDER_MODEL_INPUT,
  type ProviderStreamOptions,
} from "../provider-types.js";
import { createAssistantOutput } from "../transports/assistant-output.js";
import type { SimpleStreamOptions, StreamFunction } from "../types.js";
import { AssistantMessageEventStream } from "../utils/event-stream.js";
import {
  normalizeGoogleInteractionsToolChoice,
  type GoogleInteractionsOptions,
} from "./google-interactions-request.js";
import {
  resolveGoogleInteractionsApiKey,
  runGoogleInteractionsLifecycle,
} from "./google-interactions-shared.js";
import { buildGoogleInteractionsSimpleThinking } from "./google-shared.js";
import { buildBaseOptions } from "./simple-options.js";

let toolCallCounter = 0;

export const streamGoogleInteractions: StreamFunction<
  "google-interactions",
  GoogleInteractionsOptions
> = (model, context, options) => {
  const stream = new AssistantMessageEventStream();
  const output = createAssistantOutput(model, "google-interactions");

  void runGoogleInteractionsLifecycle({
    stream,
    model,
    output,
    options,
    context,
    nextToolCallId: (name) => `${name}_${Date.now()}_${++toolCallCounter}`,
  });

  return stream;
};

export const streamSimpleGoogleInteractions: StreamFunction<
  "google-interactions",
  SimpleStreamOptions
> = (model, context, options) => {
  const apiKey = resolveGoogleInteractionsApiKey(model, options);
  if (!apiKey) {
    throw new Error(`No API key for provider: ${model.provider}`);
  }

  const base = buildBaseOptions(model, options, apiKey);
  const providerOptions: ProviderStreamOptions | undefined = options;
  const record = asRecord(options);
  const toolChoice = normalizeGoogleInteractionsToolChoice(record.toolChoice);
  const videoMetadata = record.videoMetadata ?? record.video_metadata;
  return streamGoogleInteractions(model, context, {
    ...base,
    ...(typeof record.topP === "number" ? { topP: record.topP } : {}),
    [PROVIDER_MODEL_INPUT]: providerOptions?.[PROVIDER_MODEL_INPUT],
    [PROVIDER_CONTEXT_HANDOFF]: providerOptions?.[PROVIDER_CONTEXT_HANDOFF],
    thinking: buildGoogleInteractionsSimpleThinking(model, options),
    ...(toolChoice ? { toolChoice } : {}),
    ...(videoMetadata !== undefined ? { videoMetadata } : {}),
  });
};
