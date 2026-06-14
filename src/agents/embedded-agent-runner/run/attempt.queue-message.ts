/**
 * Steers active embedded sessions and waits for transcript commits when needed.
 */
import { log } from "../logger.js";

/**
 * Minimal active-session surface needed to steer a running attempt and observe
 * whether the queued user message reached the transcript.
 */
export type EmbeddedAgentActiveSessionSteerTarget = {
  agent?: unknown;
  getSteeringMessages?(): readonly string[];
  steer(text: string): Promise<void>;
  subscribe(listener: (event: unknown) => void): () => void;
};

/** Default wait for a steered user message to appear in the active transcript. */
export const DEFAULT_QUEUE_TRANSCRIPT_COMMIT_TIMEOUT_MS = 120_000;

function extractQueuedUserMessageText(message: unknown): string | undefined {
  if (!message || typeof message !== "object") {
    return undefined;
  }
  const record = message as { content?: unknown; role?: unknown };
  if (record.role !== "user") {
    return undefined;
  }
  if (typeof record.content === "string") {
    return record.content;
  }
  if (!Array.isArray(record.content)) {
    return undefined;
  }
  const text = record.content
    .map((block) => {
      if (!block || typeof block !== "object") {
        return undefined;
      }
      const typedBlock = block as { text?: unknown; type?: unknown };
      return typedBlock.type === "text" && typeof typedBlock.text === "string"
        ? typedBlock.text
        : undefined;
    })
    .filter((part): part is string => part !== undefined)
    .join("");
  return text || undefined;
}

function isQueuedUserMessageEnd(event: unknown, text: string): boolean {
  if (!event || typeof event !== "object") {
    return false;
  }
  const record = event as { message?: unknown; type?: unknown };
  return record.type === "message_end" && extractQueuedUserMessageText(record.message) === text;
}

function isTerminalActiveSessionEvent(event: unknown): boolean {
  return Boolean(
    event && typeof event === "object" && (event as { type?: unknown }).type === "agent_end",
  );
}

function isAssistantMessageEvent(event: unknown): boolean {
  if (!event || typeof event !== "object") {
    return false;
  }
  const record = event as { message?: unknown; type?: unknown };
  if (record.type !== "message_start" && record.type !== "message_end") {
    return false;
  }
  return Boolean(
    record.message &&
    typeof record.message === "object" &&
    (record.message as { role?: unknown }).role === "assistant",
  );
}

function isAutoRetryStartEvent(event: unknown): boolean {
  return Boolean(
    event && typeof event === "object" && (event as { type?: unknown }).type === "auto_retry_start",
  );
}

function isCompactionStartEvent(event: unknown): boolean {
  return Boolean(
    event && typeof event === "object" && (event as { type?: unknown }).type === "compaction_start",
  );
}

function getAgentSteeringQueueMessages(agent: unknown): unknown[] | undefined {
  if (!agent || typeof agent !== "object") {
    return undefined;
  }
  const queue = (agent as { steeringQueue?: unknown }).steeringQueue;
  if (!queue || typeof queue !== "object") {
    return undefined;
  }
  const messages = (queue as { messages?: unknown }).messages;
  return Array.isArray(messages) ? messages : undefined;
}

/**
 * Removes one pending steered user message from both the runtime queue and UI
 * steering list. This targets the exact text so unrelated queued messages keep
 * their payloads and ordering.
 */
export async function cancelQueuedSteeringMessage(
  activeSession: EmbeddedAgentActiveSessionSteerTarget,
  text: string,
): Promise<boolean> {
  const queuedMessages = getAgentSteeringQueueMessages(activeSession.agent);
  if (!queuedMessages) {
    return false;
  }
  // The session runtime exposes only all-queue clears publicly; mutate the exact pending message
  // so unrelated queued messages keep their full payloads.
  const queueIndex = queuedMessages.findIndex(
    (message) => extractQueuedUserMessageText(message) === text,
  );
  if (queueIndex === -1) {
    return false;
  }
  queuedMessages.splice(queueIndex, 1);
  const uiSteeringMessages = activeSession.getSteeringMessages?.();
  if (Array.isArray(uiSteeringMessages)) {
    const uiIndex = uiSteeringMessages.indexOf(text);
    if (uiIndex !== -1) {
      uiSteeringMessages.splice(uiIndex, 1);
    }
  }
  return true;
}

/**
 * Sends a steering message and waits until the matching user `message_end` is
 * durable. Completion handoffs can also require a following assistant response.
 */
export async function steerAndWaitForTranscriptCommit(
  activeSession: EmbeddedAgentActiveSessionSteerTarget,
  text: string,
  timeoutMs: number,
  options: { waitForAssistantResponseAfterTranscriptCommit?: boolean } = {},
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let committed = false;
    let terminalTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = (err?: unknown) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer) {
        clearTimeout(timer);
      }
      if (terminalTimer) {
        clearTimeout(terminalTimer);
      }
      unsubscribe?.();
      if (err) {
        reject(toLintErrorObject(err, "Non-Error rejection"));
        return;
      }
      resolve();
    };
    const rejectWithoutCancellation = (message: string) => {
      finish(new Error(message));
    };
    const rejectAfterCancellation = (message: string) => {
      // Cancellation is best-effort but must finish before rejecting so callers
      // do not return while a stale queued message can leak into the next turn.
      void cancelQueuedSteeringMessage(activeSession, text)
        .then((removed) => {
          if (!removed) {
            log.warn("failed to find queued steering message for cancellation");
          }
        })
        .catch((err: unknown) => {
          log.warn(`failed to cancel queued steering message: ${String(err)}`);
        })
        .finally(() => {
          finish(new Error(message));
        });
    };
    const rejectForCurrentState = (beforeCommit: string, afterCommit: string) => {
      if (committed) {
        rejectWithoutCancellation(afterCommit);
        return;
      }
      rejectAfterCancellation(beforeCommit);
    };
    const scheduleTerminalCancellation = () => {
      if (terminalTimer) {
        return;
      }
      terminalTimer = setTimeout(() => {
        terminalTimer = undefined;
        rejectForCurrentState(
          "active session ended before queued steering message was committed to the transcript",
          "active session ended before queued steering message was consumed",
        );
      }, 0);
      terminalTimer.unref?.();
    };
    const timer: ReturnType<typeof setTimeout> | undefined = setTimeout(
      () => {
        rejectForCurrentState(
          "queued steering message was not committed to the transcript before timeout",
          "queued steering message was committed to the transcript but not consumed before timeout",
        );
      },
      Math.max(1, timeoutMs),
    );
    timer.unref?.();
    const unsubscribe: (() => void) | undefined = activeSession.subscribe((event) => {
      if (isAutoRetryStartEvent(event) || isCompactionStartEvent(event)) {
        // Continuation events prove the run is still alive under a new attempt,
        // so keep waiting for the queued user message to drain.
        if (terminalTimer) {
          clearTimeout(terminalTimer);
          terminalTimer = undefined;
        }
        return;
      }
      if (committed && isAssistantMessageEvent(event)) {
        finish();
        return;
      }
      if (isQueuedUserMessageEnd(event, text)) {
        committed = true;
        if (options.waitForAssistantResponseAfterTranscriptCommit !== true) {
          finish();
        }
        return;
      }
      if (isTerminalActiveSessionEvent(event)) {
        // AgentSession emits agent_end before announcing auto-retry or
        // auto-compaction continuations. Defer cancellation one tick so those
        // continuation events can keep draining this message.
        scheduleTerminalCancellation();
      }
    });
    activeSession.steer(text).catch((err: unknown) => {
      finish(err);
    });
  });
}

/**
 * Steers the active session directly or waits for transcript commitment when a
 * caller needs delivery proof before returning.
 */
export async function steerActiveSessionWithOptionalDeliveryWait(
  activeSession: EmbeddedAgentActiveSessionSteerTarget,
  text: string,
  options:
    | {
        deliveryTimeoutMs?: number;
        waitForTranscriptCommit?: boolean;
        waitForAssistantResponseAfterTranscriptCommit?: boolean;
      }
    | undefined,
): Promise<void> {
  if (options?.waitForTranscriptCommit !== true) {
    await activeSession.steer(text);
    return;
  }
  await steerAndWaitForTranscriptCommit(
    activeSession,
    text,
    options.deliveryTimeoutMs ?? DEFAULT_QUEUE_TRANSCRIPT_COMMIT_TIMEOUT_MS,
    {
      waitForAssistantResponseAfterTranscriptCommit:
        options.waitForAssistantResponseAfterTranscriptCommit,
    },
  );
}

function toLintErrorObject(value: unknown, fallbackMessage: string): Error {
  if (value instanceof Error) {
    return value;
  }
  if (typeof value === "string") {
    return new Error(value);
  }
  const error = new Error(fallbackMessage, { cause: value });
  if ((typeof value === "object" && value !== null) || typeof value === "function") {
    Object.assign(error, value);
  }
  return error;
}
