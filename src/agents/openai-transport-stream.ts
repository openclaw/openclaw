/**
 * Public OpenAI transport surface.
 *
 * Responses and Chat Completions own independent streaming implementations. This facade keeps the
 * established imports stable while sharing only transport-neutral primitives between them.
 */
import type { Context } from "../llm/types.js";
import { buildOpenAICompletionsParams as buildOpenAICompletionsParamsImpl } from "../../packages/ai/src/transports/openai-completions-transport.js";
import type { OpenAICompletionsOptions, OpenAIModeModel } from "../../packages/ai/src/transports/openai-transport-shared.js";

export { createOpenAICompletionsTransportStreamFn } from "../../packages/ai/src/transports/openai-completions-transport.js";
export {
  createAzureOpenAIResponsesTransportStreamFn,
  createOpenAIResponsesTransportStreamFn,
} from "../../packages/ai/src/transports/openai-responses-transport.js";

// Keep this SDK-exported declaration anchored to the long-lived facade while the
// completions implementation remains independently owned.
export function buildOpenAICompletionsParams(
  model: OpenAIModeModel,
  context: Context,
  options: OpenAICompletionsOptions | undefined,
): Record<string, unknown> {
  return buildOpenAICompletionsParamsImpl(model, context, options);
}
