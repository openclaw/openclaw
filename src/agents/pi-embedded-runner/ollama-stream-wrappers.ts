import type { StreamFn } from "@mariozechner/pi-agent-core";
import { streamSimple } from "@mariozechner/pi-ai";
import { log } from "./logger.js";
import { streamWithPayloadPatch } from "./stream-payload-utils.js";

/**
 * Ollama models (e.g. Qwen 3.5) support thinking via `chat_template_kwargs`.
 * pi-ai's openai-completions provider only sets `enable_thinking` when both
 * `compat.thinkingFormat` is "qwen"/"qwen-chat-template" AND `model.reasoning`
 * is truthy. For Ollama models that default to thinkingFormat "openai" or lack
 * the `reasoning` flag, thinking is never explicitly disabled — the model
 * thinks by default.
 *
 * This wrapper ensures that when the user explicitly disables thinking
 * (thinkingLevel === "off"), the Ollama payload includes
 * `chat_template_kwargs: { enable_thinking: false }` to suppress thinking.
 */

function shouldApplyOllamaThinkingOffCompat(params: {
  provider?: string;
  thinkingLevel?: string;
}): boolean {
  return params.provider === "ollama" && params.thinkingLevel === "off";
}

/**
 * Returns a stream function wrapper that patches Ollama payloads to
 * disable thinking when thinkingLevel is "off".
 *
 * Ollama's OpenAI-compatible endpoint accepts `chat_template_kwargs` in the
 * request body. Setting `enable_thinking: false` tells the model template
 * (e.g. Qwen 3.5's chat template) to skip the thinking block.
 */
export function createOllamaThinkingDisabledWrapper(
  baseStreamFn: StreamFn | undefined,
): StreamFn {
  const underlying = baseStreamFn ?? streamSimple;
  return (model, context, options) =>
    streamWithPayloadPatch(underlying, model, context, options, (payloadObj) => {
      // chat_template_kwargs controls thinking in Ollama's chat completions endpoint.
      // Only set it if not already present (don't override explicit user config).
      if (payloadObj.chat_template_kwargs === undefined) {
        payloadObj.chat_template_kwargs = { enable_thinking: false };
      } else if (
        typeof payloadObj.chat_template_kwargs === "object" &&
        payloadObj.chat_template_kwargs !== null
      ) {
        // Merge into existing kwargs without overwriting other keys.
        if (!("enable_thinking" in payloadObj.chat_template_kwargs)) {
          (payloadObj.chat_template_kwargs as Record<string, unknown>).enable_thinking = false;
        }
      }
    });
}

export { shouldApplyOllamaThinkingOffCompat };
