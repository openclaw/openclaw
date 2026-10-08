import { getEventStreamCompletion } from "@openclaw/ai/internal/runtime";
import { collectErrorGraphCandidates, formatErrorMessage } from "../../infra/errors.js";
import type { AssistantMessageEvent } from "../../llm/types.js";
import { createAssistantMessageEventStream } from "../../llm/utils/event-stream.js";
import { runPluginStreamConsumer } from "../../plugins/plugin-instance-scope.js";
import { captureAsyncWorkTracker } from "../../shared/async-work-scope.js";
import type { AgentMessage, StreamFn } from "../runtime/index.js";
import { isAssistantMessageWithContent, isThinkingBlock } from "../thinking-signatures.js";
import { log } from "./logger.js";
import { wrapStreamObjectSettlement } from "./run/stream-wrapper.js";

type AssistantContentBlock = Extract<AgentMessage, { role: "assistant" }>["content"][number];
type AssistantMessage = Extract<AgentMessage, { role: "assistant" }>;
type RecoveryAssessment = "valid" | "incomplete-thinking" | "incomplete-text";
type AnthropicThinkingRecovery = {
  originalMessages: AgentMessage[];
  cleanedMessages: AgentMessage[];
};
type RecoverySessionMeta = {
  id: string;
  recoveredAnthropicThinking?: boolean;
  onRecoveredAnthropicThinking?: (recovery: AnthropicThinkingRecovery) => void | Promise<void>;
};

const THINKING_BLOCK_ERROR_PATTERN =
  /(?:thinking|redacted_thinking).*?\b(?:cannot be modified|signature|invalid|missing|empty|blank)\b|\b(?:signature|invalid|missing|empty|blank)\b.*?(?:thinking|redacted_thinking)/i;
const OMITTED_ASSISTANT_REASONING_TEXT = "[assistant reasoning omitted]";

function isToolCallBlock(block: AssistantContentBlock): boolean {
  if (!block || typeof block !== "object") {
    return false;
  }
  const type = (block as { type?: unknown }).type;
  return type === "toolCall" || type === "tool_use" || type === "function_call";
}

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

function mapAssistantMessages(
  messages: AgentMessage[],
  transform: (message: AssistantMessage, index: number) => AgentMessage,
): AgentMessage[] {
  let touched = false;
  const out: AgentMessage[] = [];
  for (const [index, message] of messages.entries()) {
    const next = isAssistantMessageWithContent(message) ? transform(message, index) : message;
    touched ||= next !== message;
    out.push(next);
  }
  return touched ? out : messages;
}

function filterAssistantContent(
  message: AssistantMessage,
  keepBlock: (block: AssistantContentBlock) => boolean,
): AssistantMessage {
  const content = message.content.filter(keepBlock);
  return content.length === message.content.length
    ? message
    : {
        ...message,
        // Provider converters drop blank blocks; preserve the assistant turn with nonempty text.
        content:
          content.length > 0 ? content : [{ type: "text", text: OMITTED_ASSISTANT_REASONING_TEXT }],
      };
}

function hasReplayableThinkingSignature(block: AssistantContentBlock): boolean {
  const record = block as {
    data?: unknown;
    signature?: unknown;
    thinkingSignature?: unknown;
    thought_signature?: unknown;
  };
  const candidates =
    (block as { type?: unknown }).type === "redacted_thinking"
      ? [record.data, record.signature, record.thinkingSignature, record.thought_signature]
      : [record.signature, record.thinkingSignature, record.thought_signature];
  return candidates.some(
    (signature) => typeof signature === "string" && signature.trim().length > 0,
  );
}

/**
 * Providers decide opaque signature validity; only missing or blank signatures are stripped.
 * Preserve the latest assistant turn for provider recovery unless the caller appends a user turn.
 */
export function stripInvalidThinkingSignatures(
  messages: AgentMessage[],
  options: { preserveLatestAssistant?: boolean } = {},
): AgentMessage[] {
  const latestAssistantIndex =
    (options.preserveLatestAssistant ?? true)
      ? messages.findLastIndex(isAssistantMessageWithContent)
      : -1;
  return mapAssistantMessages(messages, (message, index) =>
    index === latestAssistantIndex
      ? message
      : filterAssistantContent(
          message,
          (block) => !isThinkingBlock(block) || hasReplayableThinkingSignature(block),
        ),
  );
}

/**
 * Keep the latest turn's replay signatures and preserve empty turns with placeholder text.
 * Unchanged history retains its original array identity.
 */
export function dropThinkingBlocks(messages: AgentMessage[]): AgentMessage[] {
  const latestAssistantIndex = messages.findLastIndex(isAssistantMessageWithContent);
  return mapAssistantMessages(messages, (message, index) =>
    index === latestAssistantIndex ? message : stripThinkingBlocksFromMessage(message),
  );
}

function findCurrentToolTurnAssistantIndex(messages: AgentMessage[]): number {
  const latestUserIndex = messages.findLastIndex((message) => message?.role === "user");
  // Even an assistant without content ends the first-assistant eligibility window.
  const index = messages.findIndex(
    (message, candidateIndex) => candidateIndex > latestUserIndex && message?.role === "assistant",
  );
  const message = messages[index];
  return message &&
    isAssistantMessageWithContent(message) &&
    message.content.some(isToolCallBlock) &&
    messages.some(
      (next, nextIndex) =>
        nextIndex > index && next && typeof next === "object" && next.role === "toolResult",
    )
    ? index
    : -1;
}

export function shouldPreserveLatestAssistantThinking(messages: AgentMessage[]): boolean {
  const latestAssistantIndex = messages.findLastIndex(isAssistantMessageWithContent);
  return (
    latestAssistantIndex >= 0 &&
    (latestAssistantIndex === messages.length - 1 ||
      latestAssistantIndex === findCurrentToolTurnAssistantIndex(messages))
  );
}

export function stripThinkingBlocksFromMessage(message: AgentMessage): AgentMessage {
  if (!isAssistantMessageWithContent(message)) {
    return message;
  }
  return filterAssistantContent(message, (block) => !isThinkingBlock(block));
}

function stripAllThinkingBlocks(messages: AgentMessage[]): AgentMessage[] {
  return mapAssistantMessages(messages, stripThinkingBlocksFromMessage);
}

export function dropReasoningFromHistory(messages: AgentMessage[]): AgentMessage[] {
  const currentToolTurnAssistantIndex = findCurrentToolTurnAssistantIndex(messages);
  return mapAssistantMessages(messages, (message, index) =>
    index === currentToolTurnAssistantIndex ? message : stripThinkingBlocksFromMessage(message),
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
  let hasUnsignedThinking = false;
  let hasNonThinkingContent = false;
  let hasEmptyTextBlock = false;

  for (const block of message.content) {
    if (!block || typeof block !== "object") {
      return "incomplete-thinking";
    }
    if (isThinkingBlock(block)) {
      if (isSignedThinkingBlock(block)) {
        hasSignedThinking = true;
      } else {
        hasUnsignedThinking = true;
      }
      continue;
    }
    hasNonThinkingContent = true;
    if (block.type === "text" && (typeof block.text !== "string" || !block.text.trim())) {
      hasEmptyTextBlock = true;
    }
  }

  if (hasUnsignedThinking) {
    return "incomplete-thinking";
  }
  if (hasSignedThinking && (!hasNonThinkingContent || hasEmptyTextBlock)) {
    return "incomplete-text";
  }
  return "valid";
}

function shouldRecoverAnthropicThinkingError(
  error: unknown,
  sessionMeta: RecoverySessionMeta,
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
  return candidates.some(
    (candidate) =>
      typeof candidate === "string" &&
      shouldRecoverAnthropicThinkingErrorMessage(candidate, sessionMeta),
  );
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

function isAssistantMessageErrorEvent(
  event: unknown,
): event is Extract<AssistantMessageEvent, { type: "error" }> {
  return (
    Boolean(event) && typeof event === "object" && (event as { type?: unknown }).type === "error"
  );
}

async function notifyRecoveredAnthropicThinking(
  sessionMeta: RecoverySessionMeta,
  recovery: AnthropicThinkingRecovery,
): Promise<void> {
  try {
    await sessionMeta.onRecoveredAnthropicThinking?.(recovery);
  } catch (error: unknown) {
    log.warn(
      `[session-recovery] Anthropic thinking transcript repair hook failed: sessionId=${sessionMeta.id} error=${formatErrorMessage(error)}`,
    );
  }
}

function isSuccessfulRecoveryRetryResult(message: AssistantMessage | undefined): boolean {
  if (!message) {
    return false;
  }
  return message.stopReason !== "error" && message.stopReason !== "aborted";
}

function wrapRetryStreamWithRecoveryNotification(
  retryStream: ReturnType<StreamFn>,
  notify: () => Promise<void>,
  trackRecovery: ReturnType<typeof captureAsyncWorkTracker>,
  readNotification: () => Promise<void> | undefined,
): ReturnType<StreamFn> {
  if (retryStream instanceof Promise) {
    return retryStream.then((resolved) =>
      wrapRetryStreamWithRecoveryNotification(
        resolved as ReturnType<StreamFn>,
        notify,
        trackRecovery,
        readNotification,
      ),
    ) as ReturnType<StreamFn>;
  }
  const resultMethod = Reflect.get(retryStream, "result");
  if (typeof resultMethod !== "function") {
    return retryStream;
  }
  const result = resultMethod.bind(retryStream) as () => Promise<AssistantMessage>;
  let completion: Promise<AssistantMessage> | undefined;
  const finish = () => {
    completion ??= trackRecovery(() =>
      Promise.resolve().then(async () => {
        const message = await result();
        if (isSuccessfulRecoveryRetryResult(message)) {
          await notify();
        }
        return message;
      }),
    );
    void completion.catch(() => {});
    return completion;
  };
  return settleRecoveryStream(retryStream, finish, readNotification);
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
  void getEventStreamCompletion(stream)?.then(
    () => {
      producerCompleted = true;
    },
    () => {
      producerCompleted = true;
    },
  );
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
    for await (const chunk of resolvedRetry as AsyncIterable<unknown>) {
      outer.push(chunk as Parameters<typeof outer.push>[0]);
    }
    const result = await (resolvedRetry as { result?: () => Promise<AssistantMessage> }).result?.();
    if (isSuccessfulRecoveryRetryResult(result)) {
      await notify();
    }
    return result as AssistantMessage;
  });
}

async function pumpStreamWithRecovery(
  outer: ReturnType<typeof createAssistantMessageEventStream>,
  stream: ReturnType<StreamFn>,
  sessionMeta: RecoverySessionMeta,
  retry: () => ReturnType<StreamFn>,
  notify: () => Promise<void>,
): Promise<AssistantMessage> {
  let yieldedOutput = false;
  const recover = (error: unknown, stage: "stream error" | "error during stream") => {
    if (!shouldRecoverAnthropicThinkingError(error, sessionMeta)) {
      return undefined;
    }
    if (yieldedOutput) {
      log.warn(
        `[session-recovery] Anthropic thinking error occurred after streaming began; skipping retry to avoid duplicate chunks: sessionId=${sessionMeta.id}`,
      );
      return undefined;
    }
    sessionMeta.recoveredAnthropicThinking = true;
    log.warn(
      `[session-recovery] Anthropic thinking ${stage}; retrying once without thinking blocks: sessionId=${sessionMeta.id}`,
    );
    return retryStreamWithoutThinking(outer, retry, notify);
  };
  try {
    return await runPluginStreamConsumer(stream, async () => {
      const resolved = await stream;
      for await (const chunk of resolved as AsyncIterable<unknown>) {
        if (isAssistantMessageErrorEvent(chunk)) {
          const recovered = recover(chunk.error, "stream error");
          if (recovered) {
            return recovered;
          }
        } else {
          yieldedOutput = true;
        }
        outer.push(chunk as Parameters<typeof outer.push>[0]);
      }
      const result = await (resolved as { result?: () => Promise<AssistantMessage> }).result?.();
      return result as AssistantMessage;
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
  sessionMeta: RecoverySessionMeta,
  retry: () => ReturnType<StreamFn>,
  notify: () => Promise<void>,
  trackRecovery: ReturnType<typeof captureAsyncWorkTracker>,
  readNotification: () => Promise<void> | undefined,
): Awaited<ReturnType<StreamFn>> {
  const outer = createAssistantMessageEventStream();
  const finalResultPromise = trackRecovery(() =>
    pumpStreamWithRecovery(outer, stream, sessionMeta, retry, notify).finally(() => outer.end()),
  );
  void finalResultPromise.catch(() => {});
  return settleRecoveryStream(outer, () => finalResultPromise, readNotification);
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
    const originalMessages = Array.isArray(context.messages)
      ? (context.messages as AgentMessage[])
      : [];
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
        Promise.resolve().then(() =>
          notifyRecoveredAnthropicThinking(requestMeta, {
            originalMessages,
            cleanedMessages: stripAllThinkingBlocks(originalMessages),
          }),
        ),
      );
      return notification;
    };

    const stream = innerStreamFn(model, context, options);
    if (stream instanceof Promise) {
      return runPluginStreamConsumer(stream, () =>
        stream.then(
          (resolved) =>
            createRecoveryStream(
              resolved,
              requestMeta,
              retry,
              notify,
              trackRecovery,
              readNotification,
            ),
          (error: unknown) => {
            if (!shouldRecoverAnthropicThinkingError(error, requestMeta)) {
              throw error;
            }
            requestMeta.recoveredAnthropicThinking = true;
            log.warn(
              `[session-recovery] Anthropic thinking request rejected; retrying once without thinking blocks: sessionId=${requestMeta.id}`,
            );
            return wrapRetryStreamWithRecoveryNotification(
              retry(),
              notify,
              trackRecovery,
              readNotification,
            );
          },
        ),
      ) as ReturnType<StreamFn>;
    }
    return createRecoveryStream(
      stream,
      requestMeta,
      retry,
      notify,
      trackRecovery,
      readNotification,
    );
  };
}
