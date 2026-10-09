import { clampThinkingLevel } from "../model-utils.js";
import type { OpenAICompletionsOptions } from "../provider-options.js";
import { streamOpenAICompletionsRequest } from "../transports/openai-completions-transport.js";
import type { SimpleStreamOptions, StreamFunction } from "../types.js";
import { requireApiKey } from "../utils/required-api-key.js";
import { buildBaseOptions } from "./simple-options.js";

export type { OpenAICompletionsOptions } from "../provider-options.js";
export { convertMessages } from "../openai-completions-messages.js";

type OpenAIThinkingProvenanceOptions = {
  openclawThinkingExplicit?: boolean;
};

export const streamOpenAICompletions: StreamFunction<
  "openai-completions",
  OpenAICompletionsOptions
> = (model, context, options) => streamOpenAICompletionsRequest(model, context, options, "direct");

export const streamSimpleOpenAICompletions: StreamFunction<
  "openai-completions",
  SimpleStreamOptions
> = (model, context, options) => {
  const apiKey = requireApiKey(model.provider, options?.apiKey);

  const base = buildBaseOptions(model, options, apiKey);
  const clampedReasoning = options?.reasoning
    ? clampThinkingLevel(model, options.reasoning)
    : undefined;
  const toolChoice = (options as OpenAICompletionsOptions | undefined)?.toolChoice;
  const openclawThinkingExplicit =
    // SAFETY: The host adds only an optional runtime bit; omitted values preserve legacy behavior.
    (options as (OpenAICompletionsOptions & OpenAIThinkingProvenanceOptions) | undefined)
      ?.openclawThinkingExplicit;

  const completionsOptions = {
    ...base,
    reasoningEffort: clampedReasoning,
    toolChoice,
    ...(openclawThinkingExplicit !== undefined ? { openclawThinkingExplicit } : {}),
  };
  return streamOpenAICompletions(model, context, completionsOptions);
};
