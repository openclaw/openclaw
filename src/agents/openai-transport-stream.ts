/**
 * Public OpenAI transport surface.
 *
 * Responses and Chat Completions own independent streaming implementations. This facade keeps the
 * established imports stable while sharing only transport-neutral primitives between them.
 */
import type { Context } from "../llm/types.js";
import {
  buildOpenAICompletionsParams as buildOpenAICompletionsParamsImpl,
  completionsTesting,
  parseTransportChunkUsage as parseTransportChunkUsageImpl,
} from "./openai-completions-transport.js";
import {
  buildOpenAIResponsesParams as buildOpenAIResponsesParamsImpl,
  resolveAzureOpenAIApiVersion as resolveAzureOpenAIApiVersionImpl,
  responsesTesting,
} from "./openai-responses-transport.js";
import type { OpenAICompletionsOptions, OpenAIModeModel } from "./openai-transport-shared.js";

export { createOpenAICompletionsTransportStreamFn } from "./openai-completions-transport.js";
export {
  createAzureOpenAIResponsesTransportStreamFn,
  createOpenAIResponsesTransportStreamFn,
} from "./openai-responses-transport.js";
export { sanitizeTransportPayloadText } from "./transport-stream-shared.js";

export function parseTransportChunkUsage(
  ...args: Parameters<typeof parseTransportChunkUsageImpl>
): ReturnType<typeof parseTransportChunkUsageImpl> {
  return parseTransportChunkUsageImpl(...args);
}

export function buildOpenAIResponsesParams(
  ...args: Parameters<typeof buildOpenAIResponsesParamsImpl>
): ReturnType<typeof buildOpenAIResponsesParamsImpl> {
  return buildOpenAIResponsesParamsImpl(...args);
}

export function resolveAzureOpenAIApiVersion(env = process.env): string {
  return resolveAzureOpenAIApiVersionImpl(env);
}

// Keep this SDK-exported declaration anchored to the long-lived facade while the
// completions implementation remains independently owned.
export function buildOpenAICompletionsParams(
  model: OpenAIModeModel,
  context: Context,
  options: OpenAICompletionsOptions | undefined,
): Record<string, unknown> {
  return buildOpenAICompletionsParamsImpl(model, context, options);
}

export const testing = {
  ...responsesTesting,
  ...completionsTesting,
};
export { testing as __testing };
