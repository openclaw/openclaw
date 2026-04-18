import type { StreamFn } from "@mariozechner/pi-agent-core";
import { streamSimple } from "@mariozechner/pi-ai";

const MINIMAX_FAST_MODEL_IDS = new Map<string, string>([
  ["MiniMax-M2.7", "MiniMax-M2.7-highspeed"],
]);

function resolveMinimaxFastModelId(modelId: unknown): string | undefined {
  if (typeof modelId !== "string") {
    return undefined;
  }
  return MINIMAX_FAST_MODEL_IDS.get(modelId.trim());
}

function isMinimaxAnthropicMessagesModel(model: { api?: unknown; provider?: unknown }): boolean {
  return (
    model.api === "anthropic-messages" &&
    (model.provider === "minimax" || model.provider === "minimax-portal")
  );
}

/**
 * Detect MiniMax model IDs regardless of provider (e.g. `MiniMax-M2.7`,
 * `mlx-community/MiniMax-M2.7-4bit`, `MiniMaxAI/MiniMax-M2.7`). Used for the
 * openai-completions path where users may self-host MiniMax via an inference
 * server (exo, vLLM, Ollama) under an arbitrary provider name.
 */
function isMinimaxModelId(modelId: unknown): boolean {
  if (typeof modelId !== "string") {
    return false;
  }
  return /(^|[/_-])MiniMax-M\d/i.test(modelId);
}

function isMinimaxOpenAICompletionsModel(model: { api?: unknown; id?: unknown }): boolean {
  return model.api === "openai-completions" && isMinimaxModelId(model.id);
}

type MessageRecord = {
  content?: unknown;
  stopReason?: unknown;
};

type ContentBlock = {
  type?: unknown;
  text?: unknown;
  thinking?: unknown;
};

/**
 * Promote thinking-only final assistant messages into text so the chat UI
 * surfaces the reply. MiniMax models are an "interleaved thinking" family
 * (per MiniMaxAI/MiniMax-M2 docs) — they always emit `<think>...</think>`
 * before visible content. When served via openai-completions, exo and
 * similar backends stream those as `delta.reasoning_content` with empty
 * `delta.content`, so openclaw's transport parser routes the entire reply
 * into a `thinking` block. If the model's output budget is exhausted inside
 * `<think>` (or if the model emits only reasoning for this turn), the final
 * message carries no visible text and the runner surfaces a blank reply.
 *
 * Mirrors the Xiaomi/MiMo normalization pattern (#60304): only rewrites when
 * the message has a clean stop (`stop` / `length`), no renderable text, no
 * tool calls, and at least one renderable thinking block.
 */
function rewriteThinkingOnlyFinalAsText(message: unknown): void {
  if (!message || typeof message !== "object") {
    return;
  }

  const typedMessage = message as MessageRecord;
  if (typedMessage.stopReason !== "stop" && typedMessage.stopReason !== "length") {
    return;
  }

  const content = typedMessage.content;
  if (!Array.isArray(content) || content.length === 0) {
    return;
  }

  let hasRenderableText = false;
  let hasToolCalls = false;
  let hasRenderableThinking = false;
  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const typedBlock = block as ContentBlock;
    if (
      typedBlock.type === "text" &&
      typeof typedBlock.text === "string" &&
      typedBlock.text.trim()
    ) {
      hasRenderableText = true;
    }
    if (typedBlock.type === "toolCall") {
      hasToolCalls = true;
    }
    if (
      typedBlock.type === "thinking" &&
      typeof typedBlock.thinking === "string" &&
      typedBlock.thinking.trim()
    ) {
      hasRenderableThinking = true;
    }
  }

  if (hasRenderableText || hasToolCalls || !hasRenderableThinking) {
    return;
  }

  let changed = false;
  const nextContent = content.map((block) => {
    if (!block || typeof block !== "object") {
      return block;
    }
    const typedBlock = block as ContentBlock;
    if (
      typedBlock.type !== "thinking" ||
      typeof typedBlock.thinking !== "string" ||
      !typedBlock.thinking.trim()
    ) {
      return block;
    }
    changed = true;
    return {
      type: "text" as const,
      text: typedBlock.thinking,
    };
  });

  if (changed) {
    typedMessage.content = nextContent;
  }
}

function wrapMinimaxReasoningContentTextStream(
  stream: ReturnType<typeof streamSimple>,
): ReturnType<typeof streamSimple> {
  const originalResult = stream.result.bind(stream);
  stream.result = async () => {
    const message = await originalResult();
    rewriteThinkingOnlyFinalAsText(message);
    return message;
  };

  const originalAsyncIterator = stream[Symbol.asyncIterator].bind(stream);
  (stream as { [Symbol.asyncIterator]: typeof originalAsyncIterator })[Symbol.asyncIterator] =
    function () {
      const iterator = originalAsyncIterator();
      return {
        async next() {
          const result = await iterator.next();
          if (!result.done && result.value && typeof result.value === "object") {
            const event = result.value as { message?: unknown };
            rewriteThinkingOnlyFinalAsText(event.message);
          }
          return result;
        },
        async return(value?: unknown) {
          return iterator.return?.(value) ?? { done: true as const, value: undefined };
        },
        async throw(error?: unknown) {
          return iterator.throw?.(error) ?? { done: true as const, value: undefined };
        },
        [Symbol.asyncIterator]() {
          return this;
        },
      };
    };

  return stream;
}

/**
 * Wrapper that promotes thinking-only final assistant messages to text on the
 * openai-completions path for MiniMax-M2.* models (any provider — covers
 * self-hosted via exo-explore, vLLM, Ollama, etc.). See
 * `rewriteThinkingOnlyFinalAsText` for the normalization contract.
 */
export function createMinimaxReasoningContentTextWrapper(
  baseStreamFn: StreamFn | undefined,
): StreamFn {
  const underlying = baseStreamFn ?? streamSimple;
  return (model, context, options) => {
    if (!isMinimaxOpenAICompletionsModel(model)) {
      return underlying(model, context, options);
    }
    const maybeStream = underlying(model, context, options);
    if (maybeStream && typeof maybeStream === "object" && "then" in maybeStream) {
      return Promise.resolve(maybeStream).then((stream) =>
        wrapMinimaxReasoningContentTextStream(stream),
      );
    }
    return wrapMinimaxReasoningContentTextStream(maybeStream);
  };
}

export function createMinimaxFastModeWrapper(
  baseStreamFn: StreamFn | undefined,
  fastMode: boolean,
): StreamFn {
  const underlying = baseStreamFn ?? streamSimple;
  return (model, context, options) => {
    if (
      !fastMode ||
      model.api !== "anthropic-messages" ||
      (model.provider !== "minimax" && model.provider !== "minimax-portal")
    ) {
      return underlying(model, context, options);
    }

    const fastModelId = resolveMinimaxFastModelId(model.id);
    if (!fastModelId) {
      return underlying(model, context, options);
    }

    return underlying({ ...model, id: fastModelId }, context, options);
  };
}

/**
 * MiniMax's Anthropic-compatible streaming endpoint returns reasoning_content
 * in OpenAI-style delta chunks ({delta: {content: "", reasoning_content: "..."}})
 * rather than the native Anthropic thinking block format. Pi-ai's Anthropic
 * provider cannot process this format and leaks the reasoning text as visible
 * content. Disable thinking in the outgoing payload so MiniMax does not produce
 * reasoning_content deltas during streaming.
 *
 * Scope note: this intentionally targets the `anthropic-messages` path only.
 * On openai-completions, MiniMax-M2 is a documented "interleaved thinking
 * model" (see MiniMaxAI/MiniMax-M2 model card) — suppressing `<think>` there
 * degrades output quality. For that path, see
 * `createMinimaxReasoningContentTextWrapper` instead, which lets the model
 * think but rewrites thinking-only final messages into visible text.
 */
export function createMinimaxThinkingDisabledWrapper(baseStreamFn: StreamFn | undefined): StreamFn {
  const underlying = baseStreamFn ?? streamSimple;
  return (model, context, options) => {
    if (!isMinimaxAnthropicMessagesModel(model)) {
      return underlying(model, context, options);
    }

    const originalOnPayload = options?.onPayload;
    return underlying(model, context, {
      ...options,
      onPayload: (payload) => {
        if (payload && typeof payload === "object") {
          const payloadObj = payload as Record<string, unknown>;
          // Only inject if thinking is not already explicitly set.
          // This preserves any intentional override from other wrappers.
          if (payloadObj.thinking === undefined) {
            payloadObj.thinking = { type: "disabled" };
          }
        }
        return originalOnPayload?.(payload, model);
      },
    });
  };
}
