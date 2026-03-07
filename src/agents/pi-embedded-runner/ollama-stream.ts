import type { StreamFn } from "@mariozechner/pi-agent-core";
import type { Api, Model } from "@mariozechner/pi-ai";
import {
  completeSimple,
  createAssistantMessageEventStream,
  streamSimple,
} from "@mariozechner/pi-ai";

import type { OpenClawConfig } from "../../config/config.js";
import { log } from "./logger.js";

/**
 * Check if a provider is Ollama-based by examining the baseUrl.
 * Ollama typically runs on port 11434.
 */
export function isOllamaProvider(model: Model<Api>): boolean {
  const baseUrl = model.baseUrl ?? "";
  return (
    baseUrl.includes(":11434") ||
    baseUrl.includes("localhost:11434") ||
    baseUrl.includes("127.0.0.1:11434") ||
    model.provider === "ollama"
  );
}

/**
 * Check if the provider has streamToolCalls disabled in config.
 */
export function shouldDisableStreamingForTools(params: {
  cfg: OpenClawConfig | undefined;
  provider: string;
}): boolean {
  const providerConfig = params.cfg?.models?.providers?.[params.provider];
  if (!providerConfig) {
    return false;
  }
  // Explicit false means disable streaming for tool calls
  return providerConfig.streamToolCalls === false;
}

/**
 * Check if the context contains any tools.
 */
function contextHasTools(context: { tools?: unknown[] }): boolean {
  return Array.isArray(context.tools) && context.tools.length > 0;
}

/**
 * Create a StreamFn that uses non-streaming `complete()` when:
 * 1. The provider has `streamToolCalls: false` in config
 * 2. Tools are present in the context
 *
 * This works around Ollama and other local models that don't properly
 * emit tool call deltas in streaming mode.
 */
export function createOllamaAwareStreamFn(params: {
  cfg: OpenClawConfig | undefined;
  provider: string;
  baseStreamFn?: StreamFn;
}): StreamFn {
  const underlying = params.baseStreamFn ?? streamSimple;
  const disableStreamingForTools = shouldDisableStreamingForTools({
    cfg: params.cfg,
    provider: params.provider,
  });

  if (!disableStreamingForTools) {
    // No special handling needed, use the underlying stream function
    return underlying;
  }

  const wrappedStreamFn: StreamFn = (model, context, options) => {
    // Only use non-streaming when tools are present
    if (!contextHasTools(context)) {
      return underlying(model, context, options);
    }

    log.debug(
      `using non-streaming complete() for ${model.provider}/${model.id} due to streamToolCalls: false`,
    );

    // Create a stream that will be populated with the complete() result
    const stream = createAssistantMessageEventStream();

    // Call complete() and emit the result as a stream event
    void (async () => {
      try {
        // Pass through all options to completeSimple() - it accepts SimpleStreamOptions like streamSimple()
        const message = await completeSimple(model, context, options);

        // Emit the complete message as a stream event
        // Map stopReason to valid "done" event reasons (stop, length, toolUse)
        const validDoneReasons = ["stop", "length", "toolUse"] as const;
        type DoneReason = (typeof validDoneReasons)[number];
        const reason: DoneReason = validDoneReasons.includes(message.stopReason as DoneReason)
          ? (message.stopReason as DoneReason)
          : "stop";
        stream.push({
          type: "done",
          reason,
          message,
        });
        stream.end(message);
      } catch (error) {
        // For errors, emit an error event and end the stream
        const errorMessage = error instanceof Error ? error.message : String(error);
        log.error(`completeSimple() failed for ${model.provider}/${model.id}: ${errorMessage}`);
        // Create an error assistant message to signal the failure
        const errorAssistantMessage = {
          role: "assistant" as const,
          content: [],
          stopReason: "error" as const,
          errorMessage,
          api: model.api,
          provider: model.provider,
          model: model.id,
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          timestamp: Date.now(),
        };
        stream.push({
          type: "error",
          reason: "error",
          error: errorAssistantMessage,
        });
        stream.end(errorAssistantMessage);
      }
    })();

    return stream;
  };

  return wrappedStreamFn;
}
