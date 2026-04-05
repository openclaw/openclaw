import type { StreamFn } from "@mariozechner/pi-agent-core";
import { createAssistantMessageEventStream, streamSimple } from "@mariozechner/pi-ai";
import { buildStreamErrorAssistantMessage } from "../../stream-message-shared.js";

const UNHANDLED_STOP_REASON_RE = /^Unhandled stop reason:\s*(.+)$/i;
const NORMALIZED_UNHANDLED_STOP_REASON_RE =
  /^The model stopped because the provider returned an unhandled stop reason:\s*(.+?)\.\s*Please rephrase and try again\.\s*$/i;

type RefusedTurnLeafEntry =
  | {
      type?: string;
      parentId?: string | null;
      message?: {
        role?: string;
        errorMessage?: unknown;
      };
    }
  | null
  | undefined;

type RefusedTurnSessionManager = {
  getLeafEntry?: () => RefusedTurnLeafEntry;
  branch: (entryId: string) => void;
  resetLeaf: () => void;
  buildSessionContext: () => { messages: unknown[] };
};

type RefusedTurnActiveSession = {
  agent: {
    state: {
      messages: unknown[];
    };
  };
};

function formatUnhandledStopReasonErrorMessage(stopReason: string): string {
  return `The model stopped because the provider returned an unhandled stop reason: ${stopReason}. Please rephrase and try again.`;
}

export function extractUnhandledStopReason(message: unknown): string | undefined {
  if (typeof message !== "string") {
    return undefined;
  }
  const trimmed = message.trim();
  const match =
    trimmed.match(UNHANDLED_STOP_REASON_RE) ?? trimmed.match(NORMALIZED_UNHANDLED_STOP_REASON_RE);
  const stopReason = match?.[1]?.trim();
  if (!stopReason) {
    return undefined;
  }
  return stopReason.toLowerCase();
}

function normalizeUnhandledStopReasonMessage(message: unknown): string | undefined {
  const stopReason = extractUnhandledStopReason(message);
  if (!stopReason) {
    return undefined;
  }
  return formatUnhandledStopReasonErrorMessage(stopReason);
}

export function isAnthropicRefusalStopReasonMessage(message: unknown): boolean {
  const stopReason = extractUnhandledStopReason(message);
  return stopReason === "refusal" || stopReason === "sensitive";
}

function rewindRefusedTurnLeaf(
  sessionManager: RefusedTurnSessionManager,
  activeSession: RefusedTurnActiveSession,
  leafEntry: RefusedTurnLeafEntry,
): boolean {
  if (!leafEntry || leafEntry.type !== "message") {
    return false;
  }
  if (leafEntry.parentId) {
    sessionManager.branch(leafEntry.parentId);
  } else {
    sessionManager.resetLeaf();
  }
  activeSession.agent.state.messages = sessionManager.buildSessionContext().messages;
  return true;
}

export function rollbackAnthropicRefusedTurn(params: {
  activeSession: RefusedTurnActiveSession;
  sessionManager?: RefusedTurnSessionManager;
}): boolean {
  const sessionManager = params.sessionManager;
  if (!sessionManager?.getLeafEntry) {
    return false;
  }

  const assistantLeaf = sessionManager.getLeafEntry();
  if (
    assistantLeaf?.type !== "message" ||
    assistantLeaf.message?.role !== "assistant" ||
    !isAnthropicRefusalStopReasonMessage(assistantLeaf.message?.errorMessage)
  ) {
    return false;
  }

  const rewoundAssistant = rewindRefusedTurnLeaf(
    sessionManager,
    params.activeSession,
    assistantLeaf,
  );
  if (!rewoundAssistant) {
    return false;
  }

  const userLeaf = sessionManager.getLeafEntry();
  if (userLeaf?.type === "message" && userLeaf.message?.role === "user") {
    rewindRefusedTurnLeaf(sessionManager, params.activeSession, userLeaf);
  }
  return true;
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
): ReturnType<typeof streamSimple> {
  const stream = createAssistantMessageEventStream();
  queueMicrotask(() => {
    stream.push({
      type: "error",
      reason: "error",
      error: buildStreamErrorAssistantMessage({
        model: {
          api: model.api,
          provider: model.provider,
          id: model.id,
        },
        errorMessage,
      }),
    });
    stream.end();
  });
  return stream;
}

function wrapStreamHandleUnhandledStopReason(
  model: Parameters<StreamFn>[0],
  stream: ReturnType<typeof streamSimple>,
): ReturnType<typeof streamSimple> {
  const originalResult = stream.result.bind(stream);
  stream.result = async () => {
    try {
      const message = await originalResult();
      patchUnhandledStopReasonInAssistantMessage(message);
      return message;
    } catch (err) {
      const normalizedMessage = normalizeUnhandledStopReasonMessage(
        err instanceof Error ? err.message : String(err),
      );
      if (!normalizedMessage) {
        throw err;
      }
      return buildStreamErrorAssistantMessage({
        model: {
          api: model.api,
          provider: model.provider,
          id: model.id,
        },
        errorMessage: normalizedMessage,
      });
    }
  };

  const originalAsyncIterator = stream[Symbol.asyncIterator].bind(stream);
  (stream as { [Symbol.asyncIterator]: typeof originalAsyncIterator })[Symbol.asyncIterator] =
    function () {
      const iterator = originalAsyncIterator();
      let emittedSyntheticTerminal = false;
      return {
        async next() {
          if (emittedSyntheticTerminal) {
            return { done: true as const, value: undefined };
          }

          try {
            const result = await iterator.next();
            if (!result.done && result.value && typeof result.value === "object") {
              const event = result.value as { error?: unknown };
              patchUnhandledStopReasonInAssistantMessage(event.error);
            }
            return result;
          } catch (err) {
            const normalizedMessage = normalizeUnhandledStopReasonMessage(
              err instanceof Error ? err.message : String(err),
            );
            if (!normalizedMessage) {
              throw err;
            }
            emittedSyntheticTerminal = true;
            return {
              done: false as const,
              value: {
                type: "error" as const,
                reason: "error" as const,
                error: buildStreamErrorAssistantMessage({
                  model: {
                    api: model.api,
                    provider: model.provider,
                    id: model.id,
                  },
                  errorMessage: normalizedMessage,
                }),
              },
            };
          }
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

export function wrapStreamFnHandleSensitiveStopReason(baseFn: StreamFn): StreamFn {
  return (model, context, options) => {
    try {
      const maybeStream = baseFn(model, context, options);
      if (maybeStream && typeof maybeStream === "object" && "then" in maybeStream) {
        return Promise.resolve(maybeStream).then(
          (stream) => wrapStreamHandleUnhandledStopReason(model, stream),
          (err) => {
            const normalizedMessage = normalizeUnhandledStopReasonMessage(
              err instanceof Error ? err.message : String(err),
            );
            if (!normalizedMessage) {
              throw err;
            }
            return buildUnhandledStopReasonErrorStream(model, normalizedMessage);
          },
        );
      }
      return wrapStreamHandleUnhandledStopReason(model, maybeStream);
    } catch (err) {
      const normalizedMessage = normalizeUnhandledStopReasonMessage(
        err instanceof Error ? err.message : String(err),
      );
      if (!normalizedMessage) {
        throw err;
      }
      return buildUnhandledStopReasonErrorStream(model, normalizedMessage);
    }
  };
}
