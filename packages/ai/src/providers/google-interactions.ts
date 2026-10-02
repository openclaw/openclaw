// Google Interactions provider adapts Gemini Interactions API streams and tools to the agent runtime.
import { createAssistantOutput } from "../transports/assistant-output.js";
import type { Context, Model, SimpleStreamOptions, StreamFunction } from "../types.js";
import { AssistantMessageEventStream } from "../utils/event-stream.js";
import {
  resolveGoogleInteractionsApiKey,
  runGoogleInteractionsLifecycle,
} from "./google-interactions-shared.js";
import {
  buildGoogleInteractionsSimpleThinking,
  type GoogleProviderOptions,
} from "./google-shared.js";
import { buildBaseOptions } from "./simple-options.js";

export type GoogleInteractionsOptions = GoogleProviderOptions;

// Counter for generating unique tool call IDs
let toolCallCounter = 0;

export const streamGoogleInteractions: StreamFunction<
  "google-interactions",
  GoogleInteractionsOptions
> = (
  model: Model<"google-interactions">,
  context: Context,
  options?: GoogleInteractionsOptions,
) => {
  const stream = new AssistantMessageEventStream();
  const output = createAssistantOutput(model, "google-interactions");

  void runGoogleInteractionsLifecycle({
    stream,
    model,
    output,
    options,
    context,
    nextToolCallId: (name) => `${name}_${Date.now()}_${++toolCallCounter}`,
    apiKey: resolveGoogleInteractionsApiKey(model, options),
  });

  return stream;
};

export const streamSimpleGoogleInteractions: StreamFunction<
  "google-interactions",
  SimpleStreamOptions
> = (model: Model<"google-interactions">, context: Context, options?: SimpleStreamOptions) => {
  const apiKey = resolveGoogleInteractionsApiKey(model, options);
  if (!apiKey) {
    throw new Error(`No API key for provider: ${model.provider}`);
  }

  const base = buildBaseOptions(model, options, apiKey);
  return streamGoogleInteractions(model, context, {
    ...base,
    thinking: buildGoogleInteractionsSimpleThinking(model, options),
  } satisfies GoogleInteractionsOptions);
};
