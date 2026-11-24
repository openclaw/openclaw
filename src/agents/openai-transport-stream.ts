import { buildOpenAICompletionsParams as buildOpenAICompletionsParamsImpl } from "@openclaw/ai/transports";
import type { OpenAICompletionsOptions, OpenAIModeModel } from "@openclaw/ai/transports";
/**
 * Public OpenAI transport surface.
 *
 * Responses and Chat Completions own independent streaming implementations. This facade keeps the
 * established imports stable while sharing only transport-neutral primitives between them.
 */
import type { Context } from "../llm/types.js";
import { configureAiTransportRuntimeHost } from "./ai-transport-runtime-host.js";

export { createOpenAIResponsesTransportStreamFn } from "@openclaw/ai/transports";

// Keep this SDK-exported declaration anchored to the long-lived facade while the
// completions implementation remains independently owned.
export function buildOpenAICompletionsParams(
  model: OpenAIModeModel,
  context: Context,
  options: OpenAICompletionsOptions | undefined,
): Record<string, unknown> {
  configureAiTransportRuntimeHost();
  return buildOpenAICompletionsParamsImpl(model, context, options);
}
