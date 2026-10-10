// Opencode Go stream termination wrapper aborts stalled OpenAI-compatible
// SSE streams at the provider-owned raw boundary, before the shared runtime
// stuck-session recovery kicks in.
import type { AssistantMessage, AssistantMessageEvent } from "openclaw/plugin-sdk/llm";
import { createAssistantMessageEventStream } from "openclaw/plugin-sdk/llm";
import { asPositiveFiniteNumber as validTimeoutMs } from "openclaw/plugin-sdk/number-runtime";
import type { ProviderWrapStreamFnContext } from "openclaw/plugin-sdk/plugin-entry";
import { createEmptyTransportUsage } from "openclaw/plugin-sdk/provider-transport-runtime";

type ProviderStreamFn = NonNullable<ProviderWrapStreamFnContext["streamFn"]>;

/**
 * Default idle window used in production. Matches the runtime's shared
 * `DEFAULT_LLM_IDLE_TIMEOUT_MS` (120s) so non-cron interactive runs see
 * no behavior change versus the existing watchdog, while cron runs — for
 * which the runtime disables its idle watchdog entirely
 * (`resolveLlmIdleTimeoutMs` returns 0 when `trigger === "cron"` and no
 * explicit timeout is set) — finally get a provider-owned termination
 * well before the ~622s stuck-session recovery kicks in.
 */
const OPENCODE_GO_STREAM_IDLE_TIMEOUT_MS = 120_000;

const OPENCODE_GO_STREAM_FIRST_EVENT_TIMEOUT_MS = 300_000;

function resolveTimeoutMs(model: unknown, fallbackMs: number): number {
  return validTimeoutMs((model as { requestTimeoutMs?: unknown })?.requestTimeoutMs) ?? fallbackMs;
}

function isProviderProgressEvent(event: AssistantMessageEvent): boolean {
  return (
    event.type === "text_delta" ||
    event.type === "thinking_delta" ||
    event.type === "toolcall_delta" ||
    event.type === "text_end" ||
    event.type === "thinking_end" ||
    event.type === "toolcall_start" ||
    event.type === "toolcall_end"
  );
}

const STALLED_STREAM_ERROR_MESSAGE =
  "opencode-go stream timed out after provider-owned SSE boundary stalled";

function buildStreamErrorEvent(
  partial: AssistantMessage | undefined,
  model: Parameters<ProviderStreamFn>[0],
  errorMessage: string,
): AssistantMessageEvent {
  return {
    type: "error",
    reason: "error",
    error: {
      ...(partial ?? {
        role: "assistant",
        content: [],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: createEmptyTransportUsage(),
        timestamp: Date.now(),
      }),
      stopReason: "error",
      errorMessage,
    },
  };
}

// Abort at the provider-owned SSE boundary; the shared recovery watchdog fires later.
export function createOpencodeGoStalledStreamWrapper(
  underlying: ProviderStreamFn,
): ProviderStreamFn {
  return (model, context, callOptions) => {
    if (model.provider !== "opencode-go") {
      return underlying(model, context, callOptions);
    }

    const output = createAssistantMessageEventStream();
    const idleTimeoutMs = resolveTimeoutMs(model, OPENCODE_GO_STREAM_IDLE_TIMEOUT_MS);
    const firstEventTimeoutMs = resolveTimeoutMs(model, OPENCODE_GO_STREAM_FIRST_EVENT_TIMEOUT_MS);
    const controller = new AbortController();
    const callerSignal = callOptions?.signal;
    const signal = callerSignal
      ? AbortSignal.any([callerSignal, controller.signal])
      : controller.signal;
    const wrappedOptions = {
      ...callOptions,
      // This provider owns the raw SSE stall policy. Preserve that longer first
      // event window when delegating to OpenAI-compatible streams so the generic
      // embedded-runner default cannot shorten opencode-go prompt evaluation.
      firstEventTimeoutMs,
      signal,
    };
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    let lastSeenPartial: AssistantMessage | undefined;
    let settled = false;
    let baseIterator: AsyncIterator<AssistantMessageEvent> | undefined;

    const clearIdleTimer = () => {
      if (idleTimer !== undefined) {
        clearTimeout(idleTimer);
        idleTimer = undefined;
      }
    };

    const releaseBaseStream = () => {
      if (baseIterator?.return) {
        void Promise.resolve(baseIterator.return()).catch(() => undefined);
      }
    };

    const finishWith = (event: AssistantMessageEvent) => {
      if (settled) {
        return;
      }
      settled = true;
      clearIdleTimer();
      output.push(event);
      output.end(event.type === "done" ? event.message : undefined);
    };

    const abortStalledStream = () => {
      if (settled) {
        return;
      }
      settled = true;
      clearIdleTimer();
      controller.abort(new Error("opencode-go stream stalled"));
      releaseBaseStream();
      output.push(buildStreamErrorEvent(lastSeenPartial, model, STALLED_STREAM_ERROR_MESSAGE));
      output.end();
    };

    const armTimer = (timeoutMs: number) => {
      clearIdleTimer();
      idleTimer = setTimeout(abortStalledStream, timeoutMs);
      idleTimer.unref?.();
    };

    const trackPartial = (event: AssistantMessageEvent) => {
      const partial =
        (event as { partial?: AssistantMessage; message?: AssistantMessage }).partial ??
        (event as { message?: AssistantMessage }).message;
      if (partial) {
        lastSeenPartial = partial;
      }
    };

    armTimer(firstEventTimeoutMs);
    let baseStreamResult: ReturnType<ProviderStreamFn>;
    try {
      baseStreamResult = underlying(model, context, wrappedOptions);
    } catch (error) {
      clearIdleTimer();
      throw error;
    }

    void (async () => {
      try {
        const baseStream = await baseStreamResult;
        baseIterator = baseStream[Symbol.asyncIterator]();
        if (settled) {
          releaseBaseStream();
          return;
        }
        for (;;) {
          const result = await baseIterator.next();
          if (settled) {
            return;
          }
          if (result.done) {
            finishWith(
              buildStreamErrorEvent(
                lastSeenPartial,
                model,
                "opencode-go stream ended without a terminal event",
              ),
            );
            return;
          }
          const event = result.value;
          if (event.type === "done" || event.type === "error") {
            trackPartial(event);
            finishWith(event);
            return;
          }
          trackPartial(event);
          output.push(event);
          if (isProviderProgressEvent(event)) {
            armTimer(idleTimeoutMs);
          }
        }
      } catch (error) {
        if (!settled) {
          finishWith(
            buildStreamErrorEvent(
              lastSeenPartial,
              model,
              error instanceof Error ? error.message : String(error),
            ),
          );
        }
      } finally {
        clearIdleTimer();
      }
    })();

    return output;
  };
}
