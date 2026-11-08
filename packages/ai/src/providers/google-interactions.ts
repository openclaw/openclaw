import { asRecord } from "@openclaw/normalization-core/record-coerce";
import { createAssistantOutput } from "../transports/assistant-output.js";
import type { SimpleStreamOptions, StreamFunction } from "../types.js";
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

let toolCallCounter = 0;

export const streamGoogleInteractions: StreamFunction<
  "google-interactions",
  GoogleProviderOptions
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
  const topP = asRecord(options).topP;
  return streamGoogleInteractions(model, context, {
    ...base,
    ...(typeof topP === "number" ? { topP } : {}),
    thinking: buildGoogleInteractionsSimpleThinking(model, options),
  } satisfies GoogleProviderOptions);
};
