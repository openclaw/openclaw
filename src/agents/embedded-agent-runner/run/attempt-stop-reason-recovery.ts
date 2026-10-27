import { formatErrorMessage } from "../../../infra/errors.js";
import { createAssistantMessageEventStream } from "../../../llm/utils/event-stream.js";
import type { StreamFn } from "../../runtime/index.js";
import type { MutableAssistantMessageEventStream } from "../../stream-compat.js";
import { createStreamIteratorWrapper } from "../../stream-iterator-wrapper.js";
import { buildStreamErrorAssistantMessage } from "../../stream-message-shared.js";

const UNHANDLED_STOP_REASON_RE = /^Unhandled stop reason:\s*(.+)$/i;

function normalizeUnhandledStopReasonMessage(message: unknown): string | undefined {
  if (typeof message !== "string") {
    return undefined;
  }
  const stopReason = message.trim().match(UNHANDLED_STOP_REASON_RE)?.[1]?.trim();
  return stopReason
    ? `The model stopped because the provider returned an unhandled stop reason: ${stopReason}. Please rephrase and try again.`
    : undefined;
}

function normalizeUnhandledStopReasonError(error: unknown): string {
  const message = normalizeUnhandledStopReasonMessage(formatErrorMessage(error));
  if (!message) {
    throw error;
  }
  return message;
}

function patchUnhandledStopReasonInAssistantMessage(message: unknown): void {
  if (!message || typeof message !== "object") {
    return;
  }

  const assistant = message as { errorMessage?: unknown; stopReason?: unknown };
  const normalizedMessage = normalizeUnhandledStopReasonMessage(assistant.errorMessage);
  if (!normalizedMessage) {
    return;
  }

  assistant.stopReason = "error";
  assistant.errorMessage = normalizedMessage;
}

function buildUnhandledStopReasonErrorStream(
  model: Parameters<StreamFn>[0],
  errorMessage: string,
): MutableAssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  queueMicrotask(() => {
    stream.push({
      type: "error",
      reason: "error",
      error: buildStreamErrorAssistantMessage({
        model,
        errorMessage,
      }),
    });
    stream.end();
  });
  return stream;
}

function wrapStreamHandleUnhandledStopReason(
  model: Parameters<StreamFn>[0],
  stream: MutableAssistantMessageEventStream,
): MutableAssistantMessageEventStream {
  const originalResult = stream.result.bind(stream);
  stream.result = async () => {
    try {
      const message = await originalResult();
      patchUnhandledStopReasonInAssistantMessage(message);
      return message;
    } catch (err) {
      return buildStreamErrorAssistantMessage({
        model,
        errorMessage: normalizeUnhandledStopReasonError(err),
      });
    }
  };

  const originalAsyncIterator = stream[Symbol.asyncIterator].bind(stream);
  stream[Symbol.asyncIterator] = function () {
    const iterator = originalAsyncIterator();
    let emittedSyntheticTerminal = false;
    // Reuse continuations for the stream instead of suspending an async function per chunk.
    const observe = (result: Awaited<ReturnType<typeof iterator.next>>) => {
      try {
        if (!result.done && result.value.type === "error") {
          patchUnhandledStopReasonInAssistantMessage(result.value.error);
        }
        return result;
      } catch (err) {
        return recover(err);
      }
    };
    const recover = (err: unknown) => {
      const normalizedMessage = normalizeUnhandledStopReasonError(err);
      // Emit one synthetic terminal for a provider failure before its terminal event.
      emittedSyntheticTerminal = true;
      return {
        done: false as const,
        value: {
          type: "error" as const,
          reason: "error" as const,
          error: buildStreamErrorAssistantMessage({ model, errorMessage: normalizedMessage }),
        },
      };
    };
    return createStreamIteratorWrapper({
      iterator,
      next: (streamIterator) => {
        if (emittedSyntheticTerminal) {
          return Promise.resolve({ done: true as const, value: undefined });
        }
        try {
          return Promise.resolve(streamIterator.next()).then(observe, recover);
        } catch (err) {
          // Mark the terminal before a second read; reject if recovery itself throws.
          return new Promise((resolve) => {
            resolve(recover(err));
          });
        }
      },
    });
  };

  return stream;
}

/**
 * Wraps provider streams so raw "Unhandled stop reason" failures are rewritten
 * into stable error messages. Recovery covers synchronous creation failures,
 * async stream creation failures, iterator errors, and `result()` errors.
 */
export function wrapStreamFnHandleSensitiveStopReason(baseFn: StreamFn): StreamFn {
  return (model, context, options) => {
    try {
      const maybeStream = baseFn(model, context, options);
      if (maybeStream && typeof maybeStream === "object" && "then" in maybeStream) {
        return Promise.resolve(maybeStream).then(
          (stream) => wrapStreamHandleUnhandledStopReason(model, stream),
          (err: unknown) =>
            buildUnhandledStopReasonErrorStream(model, normalizeUnhandledStopReasonError(err)),
        );
      }
      return wrapStreamHandleUnhandledStopReason(model, maybeStream);
    } catch (err) {
      return buildUnhandledStopReasonErrorStream(model, normalizeUnhandledStopReasonError(err));
    }
  };
}
