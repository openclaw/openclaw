import type {
  AcpRuntime,
  AcpRuntimeEvent,
  AcpRuntimeTurnInput,
} from "@openclaw/acp-core/runtime/types";
import { runWithAgentToolSourceExecutionScope } from "../../agents/agent-tool-source-execution-guard.js";
import type { SessionSourceAssertion } from "../../config/sessions/session-source-authority.js";
import { AcpRuntimeError } from "../runtime/errors.js";
import { normalizeAcpErrorCode } from "./manager.utils.js";
import { normalizeText } from "./runtime-options.js";

/** Mutable gate used to suppress late events after timeout/cancel races. */
type AcpTurnEventGate = {
  open: boolean;
  pendingDelivery?: Promise<void>;
};

type AcpTurnStreamOutcome = {
  sawOutput: boolean;
  terminalStatus?: "completed" | "cancelled";
};

async function consumeAcpTurnEvents(params: {
  events: AsyncIterable<AcpRuntimeEvent>;
  eventGate: AcpTurnEventGate;
  onEvent?: (event: AcpRuntimeEvent) => Promise<void> | void;
  onOutputEvent?: (
    event: Extract<AcpRuntimeEvent, { type: "text_delta" | "tool_call" }>,
  ) => Promise<void> | void;
}): Promise<AcpTurnStreamOutcome> {
  let streamError: AcpRuntimeError | null = null;
  let sawOutput = false;
  let terminalStatus: AcpTurnStreamOutcome["terminalStatus"];

  for await (const event of params.events) {
    if (!params.eventGate.open) {
      continue;
    }
    let forwardedEvent = event;
    if (event.type === "done") {
      // Legacy runTurn adapters may omit status but retain the cancellation reason.
      terminalStatus =
        event.status ??
        (event.stopReason === "cancel" ||
        event.stopReason === "cancelled" ||
        event.stopReason === "manual-cancel"
          ? "cancelled"
          : "completed");
      forwardedEvent = { ...event, status: terminalStatus };
    } else if (event.type === "error") {
      streamError = new AcpRuntimeError(
        normalizeAcpErrorCode(event.code),
        normalizeText(event.message) || "ACP turn failed before completion.",
        event.detailCode ? { detailCode: event.detailCode } : undefined,
      );
    }
    const outputEvent =
      event.type === "text_delta" || event.type === "tool_call" ? event : undefined;
    if (outputEvent) {
      sawOutput = true;
    }
    params.eventGate.pendingDelivery = Promise.resolve(
      outputEvent ? params.onOutputEvent?.(outputEvent) : undefined,
    ).then(() => params.onEvent?.(forwardedEvent));
    try {
      await params.eventGate.pendingDelivery;
    } finally {
      params.eventGate.pendingDelivery = undefined;
    }
  }

  if (params.eventGate.open && streamError) {
    throw streamError;
  }

  return {
    sawOutput,
    terminalStatus,
  };
}

function waitForQueuedEvents(): Promise<"pending"> {
  return new Promise((resolve) => {
    setTimeout(() => resolve("pending"), 0);
  });
}

/** A pre-submission cancellation has a normal terminal event, not a failed prompt. */
export async function emitCancelledAcpTurn(
  onEvent?: (event: AcpRuntimeEvent) => Promise<void> | void,
): Promise<AcpTurnStreamOutcome> {
  await onEvent?.({ type: "done", status: "cancelled", stopReason: "cancel" });
  return { sawOutput: false, terminalStatus: "cancelled" };
}

export async function consumeAcpTurnStream(params: {
  runtime: AcpRuntime;
  source?: SessionSourceAssertion;
  turn: AcpRuntimeTurnInput;
  eventGate: AcpTurnEventGate;
  onBeforePrompt?: () => Promise<void> | void;
  onCancellation?: () => Promise<void>;
  onPromptStarted?: (params: { authoritative: boolean }) => Promise<void> | void;
  onEvent?: (event: AcpRuntimeEvent) => Promise<void> | void;
  onOutputEvent?: (
    event: Extract<AcpRuntimeEvent, { type: "text_delta" | "tool_call" }>,
  ) => Promise<void> | void;
}): Promise<AcpTurnStreamOutcome> {
  if (params.turn.signal?.aborted) {
    await params.onCancellation?.();
    return await emitCancelledAcpTurn(params.onEvent);
  }
  // Gateway admission can still close while runtime preparation is awaited.
  if (params.onBeforePrompt) {
    await params.onBeforePrompt();
  }
  // The admission fence is asynchronous. Recheck after it, before calling the backend.
  if (params.turn.signal?.aborted) {
    await params.onCancellation?.();
    return await emitCancelledAcpTurn(params.onEvent);
  }
  if (params.runtime.startTurn) {
    // Submission readiness and terminal cleanup are independent backend-owned turn boundaries.
    const startTurn = params.runtime.startTurn.bind(params.runtime);
    const { turn } = await runWithAgentToolSourceExecutionScope(params.source, async () => {
      params.source?.();
      return { turn: startTurn(params.turn) };
    });
    let promptReadinessOpen = true;
    let promptNotificationStarted = false;
    const readinessPromise = turn.promptStarted?.then(
      async () => {
        if (!promptReadinessOpen || !params.eventGate.open) {
          return { kind: "prompt-start-closed" as const };
        }
        promptNotificationStarted = true;
        try {
          await params.onPromptStarted?.({ authoritative: true });
        } catch (error) {
          return { kind: "prompt-start-error" as const, error };
        }
        return { kind: "prompt-started" as const };
      },
      (error: unknown) => ({ kind: "prompt-start-error" as const, error }),
    );
    const resultPromise = turn.result.then(
      async (result) => {
        promptReadinessOpen = false;
        if (promptNotificationStarted) {
          await readinessPromise;
        }
        return { kind: "result" as const, result };
      },
      async (error: unknown) => {
        promptReadinessOpen = false;
        if (promptNotificationStarted) {
          await readinessPromise;
        }
        return { kind: "result-error" as const, error };
      },
    );
    const eventsPromise = consumeAcpTurnEvents({
      events: turn.events,
      eventGate: params.eventGate,
      onEvent: params.onEvent,
      onOutputEvent: params.onOutputEvent,
    }).then(
      (outcome) => ({ kind: "events" as const, outcome }),
      async (error: unknown) => {
        // Event delivery can fail before prompt readiness. Cancel its producer
        // immediately, then retain the actor until backend cleanup completes.
        await turn.cancel({ reason: "turn-events-error" }).catch(() => {});
        await turn.closeStream({ reason: "turn-events-error" }).catch(() => {});
        await resultPromise;
        return { kind: "event-error" as const, error };
      },
    );

    if (readinessPromise) {
      const readiness = await Promise.race([readinessPromise, resultPromise]);
      if (readiness.kind === "prompt-start-error") {
        await turn.closeStream({ reason: "turn-prompt-start-error" }).catch(() => {});
        // The canonical result settles only after backend persistence and client cleanup finish.
        const terminalOutcome = await resultPromise;
        if (terminalOutcome.kind === "result" && terminalOutcome.result.status === "completed") {
          throw readiness.error;
        }
      }
    } else {
      // Third-party adapters predating readiness retain their existing output-based replay rules.
      await params.onPromptStarted?.({ authoritative: false });
    }

    const firstOutcome = await Promise.race([eventsPromise, resultPromise]);
    if (firstOutcome.kind === "event-error") {
      throw firstOutcome.error;
    }
    const terminalOutcome = firstOutcome.kind === "events" ? await resultPromise : firstOutcome;
    if (terminalOutcome.kind === "result-error") {
      await turn.closeStream({ reason: "turn-result-error" }).catch(() => {});
      throw terminalOutcome.error;
    }
    const result = terminalOutcome.result;

    let eventOutcome = firstOutcome.kind === "events" ? firstOutcome.outcome : null;
    let closedTerminalStream = false;
    while (!eventOutcome) {
      // Channel delivery can outlive the backend result. Only an idle event
      // iterator may be closed; closeStream discards queued ACPX output.
      await params.eventGate.pendingDelivery?.catch(() => {});
      let eventsOutcome = await Promise.race([eventsPromise, waitForQueuedEvents()]);
      if (eventsOutcome === "pending") {
        if (params.eventGate.pendingDelivery) {
          continue;
        }
        await turn.closeStream({ reason: `turn-result-${result.status}` }).catch(() => {});
        closedTerminalStream = true;
        eventsOutcome = await eventsPromise;
      }
      if (eventsOutcome.kind === "event-error") {
        throw eventsOutcome.error;
      }
      eventOutcome = eventsOutcome.outcome;
    }
    if (result.status !== "completed" && !closedTerminalStream) {
      await turn.closeStream({ reason: `turn-result-${result.status}` }).catch(() => {});
    }
    const { eventGate, onEvent } = params;
    if (eventGate.open) {
      if (result.status === "completed" || result.status === "cancelled") {
        await onEvent?.({
          type: "done",
          status: result.status,
          ...(result.stopReason ? { stopReason: result.stopReason } : {}),
        });
      } else {
        await onEvent?.({
          type: "error",
          code: normalizeAcpErrorCode(result.error.code),
          ...(result.error.detailCode ? { detailCode: result.error.detailCode } : {}),
          message: normalizeText(result.error.message) || "ACP turn failed before completion.",
          ...(result.error.retryable === undefined ? {} : { retryable: result.error.retryable }),
        });
      }
    }
    if (result.status === "failed") {
      throw new AcpRuntimeError(
        normalizeAcpErrorCode(result.error.code),
        normalizeText(result.error.message) || "ACP turn failed before completion.",
        result.error.detailCode ? { detailCode: result.error.detailCode } : undefined,
      );
    }
    return {
      sawOutput: eventOutcome.sawOutput,
      terminalStatus: result.status,
    };
  }

  const events = startLegacyTurnEvents(params.runtime, params.turn, params.source);
  await params.onPromptStarted?.({ authoritative: false });
  return await consumeAcpTurnEvents({
    events,
    eventGate: params.eventGate,
    onEvent: params.onEvent,
    onOutputEvent: params.onOutputEvent,
  });
}

async function* startLegacyTurnEvents(
  runtime: AcpRuntime,
  turn: AcpRuntimeTurnInput,
  source: SessionSourceAssertion | undefined,
): AsyncGenerator<AcpRuntimeEvent> {
  let iterator: AsyncIterator<AcpRuntimeEvent> | undefined;
  try {
    const started = await runWithAgentToolSourceExecutionScope(source, async () => {
      source?.();
      const current = runtime.runTurn(turn)[Symbol.asyncIterator]();
      iterator = current;
      return { iterator: current, next: await current.next() };
    });
    let next = started.next;
    while (!next.done) {
      yield next.value;
      next = await started.iterator.next();
    }
    iterator = undefined;
  } finally {
    await iterator?.return?.();
  }
}
