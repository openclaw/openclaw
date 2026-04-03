import type { StreamFn } from "@mariozechner/pi-agent-core";
import { streamSimple } from "@mariozechner/pi-ai";

const XIAOMI_REASONING_AS_TEXT_MODEL_IDS = new Set(["mimo-v2-pro", "mimo-v2-omni"]);

function normalizeString(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

type XiaomiRuntimeModel = {
  provider?: unknown;
  id?: unknown;
};

type XiaomiMessageRecord = {
  content?: unknown;
  stopReason?: unknown;
};

type XiaomiContentBlock = {
  type?: unknown;
  text?: unknown;
  thinking?: unknown;
};

export function shouldNormalizeXiaomiReasoningContentAsTextModel(
  model: XiaomiRuntimeModel | undefined,
): boolean {
  return (
    normalizeString(model?.provider) === "xiaomi" &&
    XIAOMI_REASONING_AS_TEXT_MODEL_IDS.has(normalizeString(model?.id))
  );
}

function rewriteXiaomiReasoningContentAsTextInMessage(message: unknown): void {
  if (!message || typeof message !== "object") {
    return;
  }

  const typedMessage = message as XiaomiMessageRecord;
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
    const typedBlock = block as XiaomiContentBlock;
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
    const typedBlock = block as XiaomiContentBlock;
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

function wrapXiaomiReasoningContentTextStream(
  stream: ReturnType<typeof streamSimple>,
): ReturnType<typeof streamSimple> {
  const originalResult = stream.result.bind(stream);
  stream.result = async () => {
    const message = await originalResult();
    rewriteXiaomiReasoningContentAsTextInMessage(message);
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
            rewriteXiaomiReasoningContentAsTextInMessage(event.message);
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

export function createXiaomiReasoningContentTextWrapper(
  baseStreamFn: StreamFn | undefined,
): StreamFn {
  const underlying = baseStreamFn ?? streamSimple;
  return (model, context, options) => {
    const maybeStream = underlying(model, context, options);
    if (maybeStream && typeof maybeStream === "object" && "then" in maybeStream) {
      return Promise.resolve(maybeStream).then((stream) =>
        wrapXiaomiReasoningContentTextStream(stream),
      );
    }
    return wrapXiaomiReasoningContentTextStream(maybeStream);
  };
}
