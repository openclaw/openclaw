import type { AssistantMessage, Model } from "@openclaw/llm-core";
import type { AgentEvent, AgentMessage } from "./types.js";

/** Canonical empty aborted/error assistant recorded when a run ends without output. */
export function createFailureMessage(
  model: Model,
  error: unknown,
  aborted: boolean,
): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text: "" }],
    api: model.api,
    provider: model.provider,
    model: model.id,
    stopReason: aborted ? "aborted" : "error",
    errorMessage: error instanceof Error ? error.message : String(error),
    timestamp: Date.now(),
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
}

// Not re-exported from the package barrel on purpose: these helpers are
// internal loop/harness plumbing, not public agent-core API surface.
const INTERRUPTED_TURN_GUIDANCE = `<turn_aborted>
The previous turn was interrupted. Any running background processes may still be active. If any tools or commands were aborted, they may have partially executed.
</turn_aborted>`;

/**
 * Aborts that end a turn as an intentional handoff (e.g. yield-style tools)
 * mark it with an abort reason carrying `turnHandoff: true`. Interruption
 * guidance is skipped for them: the next turn would otherwise be told tools
 * may have partially executed after a clean, deliberate stop.
 */
export function isTurnHandoffAbort(signal: AbortSignal | undefined): boolean {
  if (!signal?.aborted) {
    return false;
  }
  const reason: unknown = signal.reason;
  return (
    typeof reason === "object" &&
    reason !== null &&
    (reason as { turnHandoff?: unknown }).turnHandoff === true
  );
}

// Signals that carry agent-core's admission of a tool batch before a turn handoff.
const toolBatchSignals = new WeakSet<AbortSignal>();
const handoffTolerantSignals = new WeakMap<AbortSignal, AbortSignal>();

/** Follows `signal`, except that a turn-handoff abort is not forwarded. */
function ignoreTurnHandoffAbort(signal: AbortSignal): AbortSignal {
  const cached = handoffTolerantSignals.get(signal);
  if (cached) {
    return cached;
  }
  const controller = new AbortController();
  const forward = () => {
    if (!isTurnHandoffAbort(signal)) {
      controller.abort(signal.reason);
    }
  };
  if (signal.aborted) {
    forward();
  } else {
    signal.addEventListener("abort", forward, { once: true });
  }
  toolBatchSignals.add(controller.signal);
  handoffTolerantSignals.set(signal, controller.signal);
  return controller.signal;
}

/**
 * Signal for the tool calls of one assistant message. A turn handoff ends the
 * turn, but calls the model dispatched beside it belong to that turn: they keep
 * running until they settle. Every other abort still cancels them, and a batch
 * that starts after the handoff starts aborted.
 */
export function createToolBatchSignal(signal: AbortSignal | undefined): AbortSignal | undefined {
  return signal && !signal.aborted ? ignoreTurnHandoffAbort(signal) : signal;
}

/**
 * Combines a tool call's signal with a run-owned signal. When the call signal
 * comes from a batch admitted before a turn handoff, the run's handoff abort is
 * not forwarded to it; any other caller or abort reason combines as usual. The
 * result carries the same admission, so nested tool wrappers agree.
 */
export function combineToolCallAbortSignal(
  callSignal: AbortSignal | undefined,
  runSignal: AbortSignal,
): AbortSignal {
  if (!callSignal) {
    return runSignal;
  }
  if (!toolBatchSignals.has(callSignal)) {
    return AbortSignal.any([callSignal, runSignal]);
  }
  const combined = AbortSignal.any([callSignal, ignoreTurnHandoffAbort(runSignal)]);
  toolBatchSignals.add(combined);
  return combined;
}

export async function appendInterruptedTurnMessage(
  messages: AgentMessage[],
  emit: (event: AgentEvent) => Promise<void> | void,
): Promise<void> {
  const interruption: AgentMessage = {
    role: "custom",
    customType: "openclaw:turn-aborted",
    content: INTERRUPTED_TURN_GUIDANCE,
    display: false,
    timestamp: Date.now(),
  };
  messages.push(interruption);
  await emit({ type: "message_start", message: interruption });
  await emit({ type: "message_end", message: interruption });
}

export function normalizeCoreContextMessages(messages: AgentMessage[]): AgentMessage[] {
  return messages.map((message) => {
    if (message.role !== "custom" || message.customType !== "openclaw:turn-aborted") {
      return message;
    }
    return {
      role: "user",
      content:
        typeof message.content === "string"
          ? [{ type: "text", text: message.content }]
          : message.content,
      timestamp: message.timestamp,
    };
  });
}
