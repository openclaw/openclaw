import {
  collectErrorGraphCandidates,
  readErrorCauses,
} from "@openclaw/normalization-core/error-coercion";
import {
  MessageInjectionAcceptedUnconfirmedError,
  MessageInjectionWithdrawnError,
} from "../../../auto-reply/reply/message-injection-authority.js";
import { toErrorObject } from "../../../infra/errors.js";
import { hasPromptImageInput } from "../../../media/prompt-image-input.js";
import {
  cancelPendingAgentQuestionForSession,
  claimPendingAgentQuestionAnswer,
} from "../../harness/gateway-question.js";
import type { AgentSession } from "../../sessions/index.js";
import { retireQueuedUserMessage } from "../../sessions/queued-user-message-retirement.js";
import {
  getSteeringMessageIdentity,
  subscribeSteeringMessagePersistenceFailure,
} from "../../sessions/steering-message-identity.js";
import { log } from "../logger.js";
import type {
  EmbeddedAgentQueueMessageOptions,
  EmbeddedAgentQueueMessageResult,
} from "../run-state.js";

type EmbeddedAgentActiveSessionSteerTarget = {
  agent?: Partial<Pick<AgentSession["agent"], "cancelSteeringMessage">>;
  steer: AgentSession["steer"];
  subscribe(listener: (event: unknown) => void): () => void;
};

const DEFAULT_QUEUE_TRANSCRIPT_COMMIT_TIMEOUT_MS = 120_000;

class EmbeddedSteeringAcceptedUnconfirmedError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "EmbeddedSteeringAcceptedUnconfirmedError";
  }
}

function hasAcceptedSteeringCustody(error: unknown): boolean {
  return collectErrorGraphCandidates(error, readErrorCauses).some(
    (candidate) => candidate instanceof MessageInjectionAcceptedUnconfirmedError,
  );
}

function isQueuedUserMessageEnd(event: unknown, queueIdentity: string): boolean {
  if (!event || typeof event !== "object") {
    return false;
  }
  const record = event as { message?: unknown; type?: unknown };
  return (
    record.type === "message_end" && getSteeringMessageIdentity(record.message) === queueIdentity
  );
}

function getTerminalActiveSessionEvent(event: unknown): "settled" | "handoff" | undefined {
  if (!event || typeof event !== "object") {
    return undefined;
  }
  const type = (event as { type?: unknown }).type;
  if (type === "agent_settled") {
    return "settled";
  }
  return type === "agent_handoff" ? "handoff" : undefined;
}

/**
 * Removes one pending steered user message from both the runtime queue and its
 * exact identity-owned display entry.
 */
async function cancelQueuedSteeringMessage(
  activeSession: EmbeddedAgentActiveSessionSteerTarget,
  queueIdentity: string,
): Promise<boolean> {
  const cancelSteeringMessage = activeSession.agent?.cancelSteeringMessage;
  if (!cancelSteeringMessage) {
    return false;
  }
  const message = cancelSteeringMessage.call(
    activeSession.agent,
    (queuedMessage) => getSteeringMessageIdentity(queuedMessage) === queueIdentity,
  );
  if (!message) {
    return false;
  }
  try {
    if (!retireQueuedUserMessage(message)) {
      log.warn("failed to retire queued steering display entry during cancellation");
    }
  } catch (error) {
    // Runtime ownership is already retired; a display cleanup failure must not
    // leave the same user turn eligible for both the old queue and its replay.
    log.warn(`failed to retire queued steering display entry: ${String(error)}`);
  }
  return true;
}

/**
 * Tracks one steer until commit or terminal cleanup. Admission-only receipts
 * resolve after enqueue, but retain exact-message cleanup until the run ends.
 * Commit-waiting callers also retain their delivery deadline.
 */
async function steerWithTranscriptLifecycle(
  activeSession: EmbeddedAgentActiveSessionSteerTarget,
  text: string,
  options: EmbeddedAgentQueueMessageOptions,
  canInject?: () => boolean,
  prepareInjection?: () => Promise<void>,
): Promise<void> {
  const {
    abortSignal,
    onQueueAccepted,
    onQueueSettled,
    waitForTranscriptCommit,
    images,
    userTurnTranscriptRecorder,
    media,
    imageOrder,
    currentInboundContext,
    queueIdentity = crypto.randomUUID(),
  } = options;
  const timeoutMs = options.deliveryTimeoutMs ?? DEFAULT_QUEUE_TRANSCRIPT_COMMIT_TIMEOUT_MS;
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let accepted = false;
    let abortRequested = abortSignal?.aborted === true;
    let acceptanceReported = false;
    let cancellation: Promise<boolean> | undefined;
    let acceptanceOpen = true;
    const observerErrors: unknown[] = [];
    const notifyObserver = (callback: (() => void) | undefined) => {
      try {
        callback?.();
      } catch (error) {
        observerErrors.push(error);
      }
    };
    const reportAcceptance = (value: boolean) => {
      if (acceptanceReported) {
        return;
      }
      acceptanceReported = true;
      notifyObserver(() => onQueueAccepted?.(value));
    };
    const finish = (err?: unknown) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      notifyObserver(unsubscribe);
      notifyObserver(unsubscribePersistenceFailure);
      abortSignal?.removeEventListener("abort", onAbort);
      notifyObserver(onQueueSettled);
      const errors = err === undefined ? observerErrors : [err, ...observerErrors];
      if (errors.length > 0) {
        const failure =
          errors.length === 1
            ? errors[0]
            : new AggregateError(errors, "Steering completion observers failed", {
                cause: err === undefined ? errors[0] : err,
              });
        reject(
          accepted &&
            observerErrors.length > 0 &&
            !hasAcceptedSteeringCustody(err) &&
            !(err instanceof MessageInjectionWithdrawnError)
            ? new EmbeddedSteeringAcceptedUnconfirmedError(
                "Queued steering was accepted but its completion observer failed",
                { cause: failure },
              )
            : toErrorObject(failure, "Non-Error rejection"),
        );
        return;
      }
      resolve();
    };
    const rejectAfterCancellation = (message: string) => {
      acceptanceOpen = false;
      // Cancellation is best-effort but must finish before rejecting so callers
      // do not return while a stale queued message can leak into the next turn.
      cancellation ??= cancelQueuedSteeringMessage(activeSession, queueIdentity).then(
        async (removed) => {
          if (!removed) {
            // Queue installation precedes admission cleanup. A missing message
            // cannot prove withdrawal until that independent admission settles.
            await steering.catch((error: unknown) => {
              accepted ||= hasAcceptedSteeringCustody(error);
            });
          }
          if (!removed && accepted) {
            log.warn("failed to find queued steering message for cancellation");
            throw new EmbeddedSteeringAcceptedUnconfirmedError(message);
          }
          return removed;
        },
      );
      void cancellation.then(
        (removed) => {
          if (!accepted) {
            reportAcceptance(false);
          }
          finish(removed ? new MessageInjectionWithdrawnError(message) : new Error(message));
        },
        (error: unknown) => {
          if (!(error instanceof EmbeddedSteeringAcceptedUnconfirmedError)) {
            log.warn(`failed to cancel queued steering message: ${String(error)}`);
          }
          if (!accepted) {
            reportAcceptance(false);
          }
          finish(
            error instanceof EmbeddedSteeringAcceptedUnconfirmedError
              ? error
              : accepted
                ? new EmbeddedSteeringAcceptedUnconfirmedError(message, { cause: error })
                : new Error(message, { cause: error }),
          );
        },
      );
    };
    const rejectBeforeAcceptance = (message: string) => {
      acceptanceOpen = false;
      reportAcceptance(false);
      finish(new Error(message));
    };
    const timer = setTimeout(
      () => {
        const message =
          "queued steering message was not committed to the transcript before timeout";
        rejectAfterCancellation(message);
      },
      Math.max(1, timeoutMs),
    );
    timer.unref?.();
    const unsubscribe: (() => void) | undefined = activeSession.subscribe((event) => {
      if (isQueuedUserMessageEnd(event, queueIdentity)) {
        accepted = true;
        finish();
        return;
      }
      const terminalEvent = getTerminalActiveSessionEvent(event);
      if (terminalEvent) {
        const handedOff = terminalEvent === "handoff";
        const message = `active session ${handedOff ? "handed off" : "ended"} before queued steering message was committed to the transcript`;
        // Terminal state closes admission and owns exact queue cleanup even when
        // steer() enqueued synchronously but its Promise has not settled yet.
        rejectAfterCancellation(message);
      }
    });
    const unsubscribePersistenceFailure = subscribeSteeringMessagePersistenceFailure(
      queueIdentity,
      (error) => {
        acceptanceOpen = false;
        void steering.then(
          () => {
            if (settled) {
              return;
            }
            accepted = true;
            reportAcceptance(true);
            finish(error);
          },
          (admissionError: unknown) => {
            if (settled) {
              return;
            }
            accepted ||=
              hasAcceptedSteeringCustody(admissionError) || hasAcceptedSteeringCustody(error);
            if (!accepted) {
              reportAcceptance(false);
            }
            finish(
              new AggregateError(
                [error, admissionError],
                toErrorObject(error, "Steering persistence failed").message,
                { cause: error },
              ),
            );
          },
        );
      },
    );
    if (abortRequested) {
      rejectBeforeAcceptance("queued steering message was cancelled before acceptance");
      return;
    }
    const steering = activeSession.steer(
      text,
      images,
      userTurnTranscriptRecorder,
      media,
      imageOrder,
      queueIdentity,
      () => acceptanceOpen && (canInject?.() ?? true),
      currentInboundContext,
      prepareInjection,
    );
    void steering.then(
      () => {
        accepted = true;
        if (!acceptanceOpen) {
          return;
        }
        reportAcceptance(true);
        if (observerErrors.length > 0) {
          finish();
          return;
        }
        if (abortRequested) {
          rejectAfterCancellation("queued steering message was cancelled before delivery");
        } else if (waitForTranscriptCommit !== true && acceptanceOpen) {
          // The caller now owns an admission receipt. Only the receiving run
          // owns later consumption or withdrawal; do not retain a global failure
          // listener or the completed caller's abort signal after this point.
          clearTimeout(timer);
          unsubscribePersistenceFailure();
          abortSignal?.removeEventListener("abort", onAbort);
          resolve();
        }
      },
      (err: unknown) => {
        accepted ||= hasAcceptedSteeringCustody(err);
        if (!acceptanceOpen) {
          return;
        }
        if (!accepted) {
          reportAcceptance(false);
        }
        finish(err);
      },
    );
    function onAbort() {
      abortRequested = true;
      rejectAfterCancellation(
        accepted
          ? "queued steering message was cancelled before delivery"
          : "queued steering message was cancelled before acceptance",
      );
    }
    abortSignal?.addEventListener("abort", onAbort, { once: true });
  });
}

function resolveQuestionAuthority(
  canInject: (() => boolean) | undefined,
  authority: Parameters<typeof claimPendingAgentQuestionAnswer>[0]["authority"],
) {
  return (
    authority ??
    (canInject
      ? {
          kind: "run" as const,
          assertCurrent: () => {
            if (!canInject()) {
              throw new Error("active session is finalizing");
            }
          },
        }
      : undefined)
  );
}

export async function steerActiveSessionWithOptionalDeliveryWait(
  activeSession: EmbeddedAgentActiveSessionSteerTarget,
  text: string,
  options: EmbeddedAgentQueueMessageOptions | undefined,
  sessionKey?: string,
  canInject?: () => boolean,
  authority?: Parameters<typeof claimPendingAgentQuestionAnswer>[0]["authority"],
  prepareInjection?: () => Promise<void>,
): Promise<void | EmbeddedAgentQueueMessageResult> {
  const isInboundUserMessage = options?.isInboundUserMessage === true;
  const isPlainTextAnswer = !hasPromptImageInput(options);
  if (isInboundUserMessage && !isPlainTextAnswer) {
    try {
      await cancelPendingAgentQuestionForSession({
        sessionKey,
        resolvedBy: "image-reply",
        authority: resolveQuestionAuthority(canInject, authority),
      });
    } catch (error) {
      if (canInject && !canInject()) {
        throw error;
      }
      if (error instanceof Error && error.name === "QuestionDispatchRefusedError") {
        throw error;
      }
      log.warn(`failed to cancel ask_user before image steering: ${String(error)}`);
    }
  }
  // Non-user steering must install its transcript listener synchronously; an
  // unnecessary await here lets callers emit before subscribe() runs.
  if (
    isInboundUserMessage &&
    isPlainTextAnswer &&
    (await claimEmbeddedPendingUserInputAnswer(text, options, sessionKey, canInject, authority))
  ) {
    options?.onQueueAccepted?.(true);
    options?.onQueueSettled?.();
    return;
  }
  if (!options || (options.waitForTranscriptCommit === undefined && !options.onQueueSettled)) {
    let steered = false;
    try {
      await activeSession.steer(
        text,
        options?.images,
        options?.userTurnTranscriptRecorder,
        options?.media,
        options?.imageOrder,
        options?.queueIdentity,
        canInject,
        options?.currentInboundContext,
        prepareInjection,
      );
      steered = true;
      options?.onQueueAccepted?.(true);
    } catch (error) {
      if (steered) {
        throw new MessageInjectionAcceptedUnconfirmedError({ cause: error });
      }
      if (!hasAcceptedSteeringCustody(error)) {
        let observerFailure: { error: unknown } | undefined;
        try {
          options?.onQueueAccepted?.(false);
        } catch (observerError) {
          observerFailure = { error: observerError };
        }
        if (observerFailure) {
          throw new AggregateError(
            [error, observerFailure.error],
            "Steering rejection observer failed",
            {
              cause: error,
            },
          );
        }
      }
      throw error;
    }
    return;
  }
  try {
    await steerWithTranscriptLifecycle(activeSession, text, options, canInject, prepareInjection);
  } catch (error) {
    if (error instanceof EmbeddedSteeringAcceptedUnconfirmedError) {
      return { transcriptCommit: "unconfirmed", errorMessage: error.message };
    }
    throw error;
  }
}

// Attempt claims allow legacy steering and preserve supplied run or source-bound authority.
export async function claimEmbeddedPendingUserInputAnswer(
  text: string,
  options: EmbeddedAgentQueueMessageOptions | undefined,
  sessionKey?: string,
  canInject?: () => boolean,
  authority?: Parameters<typeof claimPendingAgentQuestionAnswer>[0]["authority"],
): Promise<boolean> {
  if (options?.isInboundUserMessage !== true || hasPromptImageInput(options)) {
    return false;
  }
  return await claimPendingAgentQuestionAnswer({
    sessionKey,
    text,
    authority: resolveQuestionAuthority(canInject, authority),
    sourceRecorder: options.userTurnTranscriptRecorder,
  });
}
