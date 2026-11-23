import { getEventStreamCompletion } from "@openclaw/ai/internal/runtime";
import { collectErrorGraphCandidates, formatErrorMessage } from "../../infra/errors.js";
import type { AssistantMessage } from "../../llm/types.js";
import { createAssistantMessageEventStream } from "../../llm/utils/event-stream.js";
import { mapAssistantMessageStream } from "../../llm/utils/stream-wrapper.js";
import { runPluginStreamConsumer } from "../../plugins/plugin-instance-scope.js";
import { captureAsyncWorkTracker } from "../../shared/async-work-scope.js";
import type { AgentMessage, StreamFn } from "../runtime/index.js";
import { isThinkingLikeBlock } from "../thinking-block.js";
import { isAssistantMessageWithContent } from "../thinking-signatures.js";
import { log } from "./logger.js";
import { wrapStreamObjectSettlement } from "./run/stream-wrapper.js";
import { stripAllThinkingBlocks } from "./thinking-replay.js";
export {
  dropReasoningFromHistory,
  dropThinkingBlocks,
  shouldPreserveLatestAssistantThinking,
  stripInvalidThinkingSignatures,
  stripThinkingBlocksFromMessage,
} from "./thinking-replay.js";

type AssistantContentBlock = Extract<AgentMessage, { role: "assistant" }>["content"][number];
type RecoveryAssessment = "valid" | "incomplete-thinking" | "incomplete-text";
type RecoverySessionMeta = {
  id: string;
  recoveredAnthropicThinking?: boolean;
  onRecoveredAnthropicThinking?: () => void | Promise<void>;
};

type ThinkingRecoveryRequest = {
  sessionMeta: RecoverySessionMeta;
  retry: () => ReturnType<StreamFn>;
  notify: () => Promise<void>;
  trackRecovery: ReturnType<typeof captureAsyncWorkTracker>;
  readNotification: () => Promise<void> | undefined;
};

const THINKING_BLOCK_ERROR_PATTERN =
  /(?:thinking|redacted_thinking).*?\b(?:cannot be modified|signature|invalid|missing|empty|blank)\b|\b(?:signature|invalid|missing|empty|blank)\b.*?(?:thinking|redacted_thinking)/i;
function isSignedThinkingBlock(block: AssistantContentBlock): boolean {
  const record = block as {
    type?: unknown;
    signature?: unknown;
    thinkingSignature?: unknown;
    thought_signature?: unknown;
  };
  return (
    record.type === "redacted_thinking" ||
    record.signature != null ||
    record.thinkingSignature != null ||
    record.thought_signature != null
  );
}

export function assessLastAssistantMessage(message: AgentMessage): RecoveryAssessment {
  if (!isAssistantMessageWithContent(message)) {
    return "valid";
  }
  if (message.content.length === 0) {
    return "incomplete-thinking";
  }

  let hasSignedThinking = false;
  let hasNonThinkingContent = false;
  let hasEmptyTextBlock = false;

  for (const block of message.content) {
    if (!block || typeof block !== "object") {
      return "incomplete-thinking";
    }
    if (isThinkingLikeBlock(block)) {
      if (!isSignedThinkingBlock(block)) {
        return "incomplete-thinking";
      }
      hasSignedThinking = true;
      continue;
    }
    hasNonThinkingContent = true;
    if (block.type === "text" && (typeof block.text !== "string" || !block.text.trim())) {
      hasEmptyTextBlock = true;
    }
  }

  if (hasSignedThinking && (!hasNonThinkingContent || hasEmptyTextBlock)) {
    return "incomplete-text";
  }
  return "valid";
}

function beginAnthropicThinkingRecovery(
  error: unknown,
  sessionMeta: RecoverySessionMeta,
  stage: "request rejected" | "stream error" | "error during stream",
  yieldedOutput = false,
): boolean {
  // Provider detail survives genericization in different carriers across the
  // Anthropic SDK, failover wrapping, and terminal stream messages.
  const candidates = collectErrorGraphCandidates(error, (current) => [
    current.cause,
    current.error,
    current.rawError,
    current.errorMessage,
    current.errorBody,
    current.message,
  ]);
  if (
    !candidates.some(
      (candidate) =>
        typeof candidate === "string" &&
        shouldRecoverAnthropicThinkingErrorMessage(candidate, sessionMeta),
    )
  ) {
    return false;
  }
  if (yieldedOutput) {
    log.warn(
      `[session-recovery] Anthropic thinking error occurred after streaming began; skipping retry to avoid duplicate chunks: sessionId=${sessionMeta.id}`,
    );
    return false;
  }
  sessionMeta.recoveredAnthropicThinking = true;
  log.warn(
    `[session-recovery] Anthropic thinking ${stage}; retrying once without thinking blocks: sessionId=${sessionMeta.id}`,
  );
  return true;
}

function shouldRecoverAnthropicThinkingErrorMessage(
  message: string,
  sessionMeta: RecoverySessionMeta,
): boolean {
  if (!THINKING_BLOCK_ERROR_PATTERN.test(message)) {
    return false;
  }
  if (sessionMeta.recoveredAnthropicThinking) {
    log.warn(
      `[session-recovery] Anthropic thinking recovery already attempted: sessionId=${sessionMeta.id}`,
    );
    return false;
  }
  return true;
}

async function notifyRecoveredAnthropicThinking(sessionMeta: RecoverySessionMeta): Promise<void> {
  try {
    await sessionMeta.onRecoveredAnthropicThinking?.();
  } catch (error: unknown) {
    log.warn(
      `[session-recovery] Anthropic thinking transcript repair hook failed: sessionId=${sessionMeta.id} error=${formatErrorMessage(error)}`,
    );
  }
}

function isSuccessfulRecoveryRetryResult(message: AssistantMessage): boolean {
  return message.stopReason !== "error" && message.stopReason !== "aborted";
}

function wrapRetryStreamWithRecoveryNotification(
  retryStream: ReturnType<StreamFn>,
  recovery: ThinkingRecoveryRequest,
): ReturnType<StreamFn> {
  return mapAssistantMessageStream(retryStream, (stream) => {
    const result = stream.result.bind(stream);
    let completion: Promise<AssistantMessage> | undefined;
    const finish = () => {
      completion ??= recovery.trackRecovery(() =>
        Promise.resolve().then(async () => {
          const message = await result();
          if (isSuccessfulRecoveryRetryResult(message)) {
            await recovery.notify();
          }
          return message;
        }),
      );
      void completion.catch(() => {});
      return completion;
    };
    return settleRecoveryStream(stream, finish, recovery.readNotification);
  });
}

function settleRecoveryStream(
  stream: Awaited<ReturnType<StreamFn>>,
  result: () => Promise<AssistantMessage>,
  readNotification: () => Promise<void> | undefined,
): Awaited<ReturnType<StreamFn>> {
  stream.result = result;
  const settle = () =>
    result().then(
      () => undefined,
      () => undefined,
    );
  let producerCompleted = false;
  const markProducerCompleted = () => {
    producerCompleted = true;
  };
  void getEventStreamCompletion(stream)?.then(markProducerCompleted, markProducerCompleted);
  // A partial-only consumer can close without waiting for ordinary provider work.
  // Completed producers may still be scheduling their admitted repair notification.
  return wrapStreamObjectSettlement(
    stream,
    settle,
    (event) => event.type === "done" || event.type === "error",
    () => readNotification() ?? (producerCompleted ? settle() : Promise.resolve()),
  );
}

async function retryStreamWithoutThinking(
  outer: ReturnType<typeof createAssistantMessageEventStream>,
  retry: () => ReturnType<StreamFn>,
  notify: () => Promise<void>,
): Promise<AssistantMessage> {
  const retryStream = retry();
  return await runPluginStreamConsumer(retryStream, async () => {
    const resolvedRetry = await retryStream;
    for await (const chunk of resolvedRetry) {
      outer.push(chunk);
    }
    const result = await resolvedRetry.result();
    if (isSuccessfulRecoveryRetryResult(result)) {
      await notify();
    }
    return result;
  });
}

async function pumpStreamWithRecovery(
  outer: ReturnType<typeof createAssistantMessageEventStream>,
  stream: ReturnType<StreamFn>,
  recovery: ThinkingRecoveryRequest,
): Promise<AssistantMessage> {
  const { sessionMeta, retry, notify } = recovery;
  let yieldedOutput = false;
  const recover = (error: unknown, stage: "stream error" | "error during stream") =>
    beginAnthropicThinkingRecovery(error, sessionMeta, stage, yieldedOutput)
      ? retryStreamWithoutThinking(outer, retry, notify)
      : undefined;
  try {
    return await runPluginStreamConsumer(stream, async () => {
      const resolved = await stream;
      for await (const chunk of resolved) {
        if (chunk.type === "error") {
          const recovered = recover(chunk.error, "stream error");
          if (recovered) {
            return recovered;
          }
        } else {
          yieldedOutput = true;
        }
        outer.push(chunk);
      }
      return await resolved.result();
    });
  } catch (error: unknown) {
    const recovered = recover(error, "error during stream");
    if (recovered) {
      return recovered;
    }
    throw error;
  }
}

function createRecoveryStream(
  stream: Awaited<ReturnType<StreamFn>>,
  recovery: ThinkingRecoveryRequest,
): Awaited<ReturnType<StreamFn>> {
  const outer = createAssistantMessageEventStream();
  const finalResultPromise = recovery.trackRecovery(() =>
    pumpStreamWithRecovery(outer, stream, recovery).finally(() => outer.end()),
  );
  void finalResultPromise.catch(() => {});
  return settleRecoveryStream(outer, () => finalResultPromise, recovery.readNotification);
}

export function wrapAnthropicStreamWithRecovery(
  innerStreamFn: StreamFn,
  sessionMeta: RecoverySessionMeta,
): StreamFn {
  return (model, context, options) => {
    const trackRecovery = captureAsyncWorkTracker();
    const requestMeta: RecoverySessionMeta = {
      id: sessionMeta.id,
      onRecoveredAnthropicThinking: sessionMeta.onRecoveredAnthropicThinking,
    };
    const originalMessages = context.messages;
    const retry = () => {
      const cleanedMessages = stripAllThinkingBlocks(originalMessages);
      const nextContext = {
        ...context,
        messages: cleanedMessages as typeof context.messages,
      };
      return innerStreamFn(model, nextContext, options);
    };
    let notification: Promise<void> | undefined;
    const readNotification = () => notification;
    const notify = () => {
      notification ??= trackRecovery(() =>
        Promise.resolve().then(() => notifyRecoveredAnthropicThinking(requestMeta)),
      );
      return notification;
    };

    const recovery = { sessionMeta: requestMeta, retry, notify, trackRecovery, readNotification };
    const stream = innerStreamFn(model, context, options);
    if (stream instanceof Promise) {
      return runPluginStreamConsumer(stream, () =>
        stream.then(
          (resolved) => createRecoveryStream(resolved, recovery),
          (error: unknown) => {
            if (!beginAnthropicThinkingRecovery(error, requestMeta, "request rejected")) {
              throw error;
            }
            return wrapRetryStreamWithRecoveryNotification(retry(), recovery);
          },
        ),
      ) as ReturnType<StreamFn>;
    }
    return createRecoveryStream(stream, recovery);
  };
}
