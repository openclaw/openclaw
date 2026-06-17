// Opencode Go stream termination wrapper aborts stalled OpenAI-compatible
// SSE streams at the provider-owned raw boundary, before the shared runtime
// stuck-session recovery kicks in.
import type {
  AssistantMessage,
  AssistantMessageEvent,
} from "openclaw/plugin-sdk/llm";
import { createAssistantMessageEventStream } from "openclaw/plugin-sdk/llm";
import type { ProviderWrapStreamFnContext } from "openclaw/plugin-sdk/plugin-entry";

type ProviderStreamFn = NonNullable<ProviderWrapStreamFnContext["streamFn"]>;

export interface OpencodeGoStalledStreamWrapperOptions {
  /**
   * Provider id this wrapper applies to. Calls whose model.provider does not
   * match are forwarded untouched so the wrapper stays provider-scoped.
   */
  provider: string;
  /**
   * Maximum idle window between two stream events before the wrapper treats
   * the underlying SSE as stalled and aborts it. Must be > 0.
   */
  idleTimeoutMs: number;
}

/**
 * Default idle window used in production. Matches the runtime's shared
 * `DEFAULT_LLM_IDLE_TIMEOUT_MS` (120s) so non-cron interactive runs see
 * no behavior change versus the existing watchdog, while cron runs — for
 * which the runtime disables its idle watchdog entirely
 * (`resolveLlmIdleTimeoutMs` returns 0 when `trigger === "cron"` and no
 * explicit timeout is set) — finally get a provider-owned termination
 * well before the ~622s stuck-session recovery kicks in.
 */
export const OPENCODE_GO_STREAM_IDLE_TIMEOUT_MS_DEFAULT = 120_000;

function isOpencodeGoModel(model: unknown, providerId: string): boolean {
  return Boolean(model) && typeof model === "object"
    ? (model as { provider?: unknown }).provider === providerId
    : false;
}

function combineAbortSignals(signals: (AbortSignal | undefined)[]): AbortSignal {
  const present = signals.filter((signal): signal is AbortSignal => Boolean(signal));
  if (present.length === 0) {
    return new AbortController().signal;
  }
  if (present.length === 1) {
    return present[0];
  }
  // Prefer the platform combiner when available; otherwise subscribe manually.
  const anyFn = (AbortSignal as unknown as {
    any?: (signals: AbortSignal[]) => AbortSignal;
  }).any;
  if (typeof anyFn === "function") {
    return anyFn(present);
  }
  const controller = new AbortController();
  const alreadyAborted = present.find((signal) => signal.aborted);
  if (alreadyAborted) {
    controller.abort((alreadyAborted as { reason?: unknown }).reason);
    return controller.signal;
  }
  const unsubscribe: Array<() => void> = [];
  for (const signal of present) {
    const onAbort = () => controller.abort((signal as { reason?: unknown }).reason);
    signal.addEventListener("abort", onAbort, { once: true });
    unsubscribe.push(() => signal.removeEventListener("abort", onAbort));
  }
  return controller.signal;
}

function buildAbortedErrorEvent(partial: AssistantMessage | undefined): AssistantMessageEvent {
  if (partial) {
    return {
      type: "error",
      reason: "aborted",
      error: {
        ...partial,
        stopReason: "aborted",
        errorMessage: "opencode-go stream stalled; aborted at provider-owned SSE boundary",
      },
    };
  }
  return {
    type: "error",
    reason: "aborted",
    error: synthesizeMinimalAssistantMessage(
      "opencode-go stream stalled; aborted at provider-owned SSE boundary",
      "aborted",
    ),
  };
}

function buildUnterminatedErrorEvent(
  partial: AssistantMessage | undefined,
): AssistantMessageEvent {
  if (partial) {
    return {
      type: "error",
      reason: "error",
      error: {
        ...partial,
        stopReason: "error",
        errorMessage: "opencode-go stream ended without a terminal event",
      },
    };
  }
  return {
    type: "error",
    reason: "error",
    error: synthesizeMinimalAssistantMessage(
      "opencode-go stream ended without a terminal event",
      "error",
    ),
  };
}

function buildCaughtErrorEvent(
  partial: AssistantMessage | undefined,
  error: unknown,
): AssistantMessageEvent {
  const message = error instanceof Error ? error.message : String(error);
  if (partial) {
    return {
      type: "error",
      reason: "error",
      error: {
        ...partial,
        stopReason: "error",
        errorMessage: message,
      },
    };
  }
  return {
    type: "error",
    reason: "error",
    error: synthesizeMinimalAssistantMessage(message, "error"),
  };
}

function synthesizeMinimalAssistantMessage(
  errorMessage: string,
  stopReason: AssistantMessage["stopReason"],
): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: "openai-completions",
    provider: "opencode-go",
    model: "",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason,
    errorMessage,
    timestamp: Date.now(),
  };
}

/**
 * Wraps an opencode-go provider stream function so that an SSE socket that
 * produces tokens and then silently stalls is aborted at the provider-owned
 * raw boundary via the injected AbortSignal, instead of waiting for the much
 * later shared runtime stuck-session recovery.
 *
 * Behavior:
 * - Provider-scoped: only applies when `model.provider === options.provider`.
 * - Idle-based: every event forwarded from the underlying stream refreshes
 *   the idle timer; if no event arrives within `idleTimeoutMs`, the wrapper
 *   calls `controller.abort()` on the AbortSignal injected into the
 *   underlying call (so the OpenAI SDK request is genuinely interrupted, not
 *   just the iterator) and pushes a terminal `error` event downstream.
 * - Terminal-safe: when the underlying stream emits `done` or `error`, the
 *   wrapper forwards the event, clears all timers, and ends the stream.
 *
 * The wrapper never shortens the natural end of a normal completion, because
 * every event (including delayed usage-only deltas) refreshes the idle timer
 * and a terminal event cancels it entirely.
 */
export function createOpencodeGoStalledStreamWrapper(
  underlying: ProviderStreamFn,
  options: OpencodeGoStalledStreamWrapperOptions,
): ProviderStreamFn {
  if (!options || options.idleTimeoutMs <= 0) {
    throw new Error(
      "createOpencodeGoStalledStreamWrapper requires idleTimeoutMs > 0",
    );
  }
  const providerId = options.provider;
  const idleTimeoutMs = options.idleTimeoutMs;

  return (model, context, callOptions) => {
    if (!isOpencodeGoModel(model, providerId)) {
      return underlying(model, context, callOptions);
    }

    const controller = new AbortController();
    const injectedSignal = combineAbortSignals([
      (callOptions as { signal?: AbortSignal } | undefined)?.signal,
      controller.signal,
    ]);
    const wrappedOptions = {
      ...callOptions,
      signal: injectedSignal,
    };

    const baseStreamResult = underlying(model, context, wrappedOptions);

    const attach = (baseStream: AsyncIterable<AssistantMessageEvent>) => {
      const output = createAssistantMessageEventStream();
      let idleTimer: ReturnType<typeof setTimeout> | undefined;
      let lastSeenPartial: AssistantMessage | undefined;
      let settled = false;
      let underlyingDone = false;

      const clearIdleTimer = () => {
        if (idleTimer !== undefined) {
          clearTimeout(idleTimer);
          idleTimer = undefined;
        }
      };

      const armIdleTimer = () => {
        clearIdleTimer();
        idleTimer = setTimeout(() => {
          if (settled) {
            return;
          }
          settled = true;
          clearIdleTimer();
          try {
            controller.abort(new Error("opencode-go stream stalled"));
          } catch {
            // AbortController.abort never throws in spec; ignore defensively.
          }
          output.push(buildAbortedErrorEvent(lastSeenPartial));
          output.end();
        }, idleTimeoutMs);
      };

      const finishWith = (event: AssistantMessageEvent) => {
        if (settled) {
          return;
        }
        settled = true;
        clearIdleTimer();
        output.push(event);
        output.end(event.type === "done" ? (event as { message: AssistantMessage }).message : undefined);
      };

      const trackPartial = (event: AssistantMessageEvent) => {
        const partial = (event as { partial?: AssistantMessage; message?: AssistantMessage }).partial
          ?? (event as { message?: AssistantMessage }).message;
        if (partial) {
          lastSeenPartial = partial;
        }
      };

      void (async () => {
        try {
          // Arm the idle timer only AFTER the first upstream event. The
          // reported bug is a stall AFTER provider progress, and arming
          // earlier would abort slow time-to-first-byte requests that the
          // runtime deliberately leaves uncapped for cron runs
          // (`resolveLlmIdleTimeoutMs` returns 0 for cron without explicit
          // timeout). The runtime's own first-event timeout governs the
          // pre-progress window.
          for await (const event of baseStream) {
            if (event.type === "done" || event.type === "error") {
              trackPartial(event);
              underlyingDone = true;
              finishWith(event);
              return;
            }
            trackPartial(event);
            output.push(event);
            // Refresh the idle window: any forward-progress (text delta,
            // tool delta, thinking delta, usage-only chunk, etc.) means the
            // underlying SSE is still alive.
            armIdleTimer();
          }
          if (!underlyingDone && !settled) {
            // Underlying iterator ended without an explicit terminal event.
            // Surface it as an error so downstream consumers do not hang.
            finishWith(buildUnterminatedErrorEvent(lastSeenPartial));
          }
        } catch (error) {
          if (!settled) {
            finishWith(buildCaughtErrorEvent(lastSeenPartial, error));
          }
        } finally {
          clearIdleTimer();
        }
      })();

      return output;
    };

    if (
      baseStreamResult &&
      typeof baseStreamResult === "object" &&
      "then" in baseStreamResult
    ) {
      return Promise.resolve(baseStreamResult).then(attach) as ReturnType<ProviderStreamFn>;
    }
    return attach(baseStreamResult as AsyncIterable<AssistantMessageEvent>);
  };
}
