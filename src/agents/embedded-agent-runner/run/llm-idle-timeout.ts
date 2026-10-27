import {
  getEventStreamCompletion,
  getFirstStreamEventTimeoutMs,
  onLlmRequestActivity,
} from "@openclaw/ai/internal/runtime";
import { withProviderAcceptanceObserver } from "@openclaw/ai/transports";
import { isCloudModelRef } from "@openclaw/model-catalog-core/model-catalog-refs";
import { findNormalizedProviderValue } from "@openclaw/model-catalog-core/provider-id";
import {
  asPositiveFiniteNumber,
  finiteSecondsToTimerSafeMilliseconds,
  clampTimerTimeoutMs,
  MAX_TIMER_TIMEOUT_MS,
} from "@openclaw/normalization-core/number-coercion";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { areDiagnosticsEnabledForProcess } from "../../../infra/diagnostic-events.js";
import { toErrorObject } from "../../../infra/errors.js";
import type { AssistantMessageEvent } from "../../../llm/types.js";
import { markDiagnosticRunProgress } from "../../../logging/diagnostic-run-activity.js";
import { captureAsyncWorkTracker } from "../../../shared/async-work-scope.js";
import { getLastToolActivityMs, onToolActivity } from "../../../shared/tool-activity-heartbeat.js";
import { recordAgentCleanupFailure } from "../../run-cleanup-timeout.js";
import type { EmbeddedRunTrigger } from "../../run-trigger.js";
import type { StreamFn } from "../../runtime/index.js";
import type { MutableAssistantMessageEventStream } from "../../stream-compat.js";
import { createStreamIteratorWrapper } from "../../stream-iterator-wrapper.js";
import { abortable, createAbortableError } from "./abortable.js";

const DEFAULT_LLM_IDLE_TIMEOUT_MS = 120_000;
const SELF_HOSTED_LLM_IDLE_TIMEOUT_MS = 300_000;
const CLOUD_LLM_FIRST_EVENT_TIMEOUT_MS = DEFAULT_LLM_IDLE_TIMEOUT_MS;
const LOCAL_LLM_FIRST_EVENT_TIMEOUT_MS = 300_000;
// Cron has its own outer watchdog; stream stalls must fail early enough for
// the existing model fallback chain to try the next configured candidate.
const CRON_LLM_IDLE_TIMEOUT_MS = 60_000;
const LOCAL_PROVIDER_AUTH_MARKERS = new Set(["custom-local", "ollama-local"]);
const SELF_HOSTED_PROVIDER_ID_PREFIXES = ["ollama", "lmstudio", "vllm", "sglang", "llama-cpp"];
const EXPLICIT_LOCAL_HOSTNAMES = new Set([
  "docker.orb.internal",
  "host.docker.internal",
  "host.orb.internal",
]);

/**
 * Local endpoints can stay silent during prompt evaluation. Classify the URL
 * hostname without DNS on this hot path. IPv4-mapped IPv6 deliberately covers
 * loopback only, matching the cron model preflight policy.
 */
function isLocalProviderHostname(hostname: string): boolean {
  let host = hostname;
  if (host.startsWith("[") && host.endsWith("]")) {
    host = host.slice(1, -1);
  }
  if (
    host === "localhost" ||
    host === "0.0.0.0" ||
    host === "::1" ||
    host === "::ffff:7f00:1" ||
    host === "::ffff:127.0.0.1" ||
    host.endsWith(".local")
  ) {
    return true;
  }
  // Require a full first hextet: fc::1 expands to 00fc, outside fc00::/7.
  if (/^f[cd][0-9a-f]{2}:/.test(host) || /^fe[89ab][0-9a-f]:/.test(host)) {
    return true;
  }
  // parseInt alone would accept 10.0.0.5evil and disable its watchdog.
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
    return false;
  }
  const octets = host.split(".").map((part) => Number.parseInt(part, 10));
  if (octets.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) {
    return false;
  }
  const [a, b] = octets;
  // Include all of 127/8, RFC 1918, and shared CGNAT/Tailscale addresses.
  return (
    a === 127 ||
    a === 10 ||
    (a === 172 && b !== undefined && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b !== undefined && b >= 64 && b <= 127)
  );
}

function isBareProviderHostname(hostname: string): boolean {
  return /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(hostname);
}

function isSelfHostedProviderId(provider: string | undefined): boolean {
  const normalized = provider?.trim().toLowerCase();
  if (!normalized || normalized === "ollama-cloud") {
    return false;
  }
  return SELF_HOSTED_PROVIDER_ID_PREFIXES.some(
    (prefix) => normalized === prefix || normalized.startsWith(`${prefix}-`),
  );
}

function findConfiguredProviderConfig(
  cfg: OpenClawConfig | undefined,
  provider: string | undefined,
) {
  const normalizedProvider = provider?.trim().toLowerCase();
  if (!normalizedProvider) {
    return undefined;
  }
  const providers = cfg?.models?.providers;
  return (
    providers?.[normalizedProvider] || findNormalizedProviderValue(providers, normalizedProvider)
  );
}

function hasLocalProviderAuthMarker(apiKey: unknown): boolean {
  return typeof apiKey === "string" && LOCAL_PROVIDER_AUTH_MARKERS.has(apiKey.trim().toLowerCase());
}

function hasConfiguredLocalProviderSignal(params: {
  cfg: OpenClawConfig | undefined;
  provider: string | undefined;
}): boolean {
  const providerConfig = findConfiguredProviderConfig(params.cfg, params.provider);
  return Boolean(
    providerConfig?.localService || hasLocalProviderAuthMarker(providerConfig?.apiKey),
  );
}

type LlmTimeoutParams = {
  cfg?: OpenClawConfig;
  runTimeoutMs?: number;
  modelRequestTimeoutMs?: number;
  model?: { baseUrl?: string; id?: string; provider?: string };
};

/**
 * Classifies the model endpoint locality shared by the idle and first-event
 * watchdogs. Ollama `*:cloud` models stay "cloud" even behind a local proxy.
 */
function resolveRuntimeModelLocality(params?: LlmTimeoutParams) {
  const baseUrl = params?.model?.baseUrl;
  const hostname =
    typeof baseUrl === "string" ? URL.parse(baseUrl)?.hostname.toLowerCase() : undefined;
  const notCloudModel = !isCloudModelRef(params?.model?.id);
  return {
    isLocalRuntimeModel: Boolean(hostname && isLocalProviderHostname(hostname) && notCloudModel),
    isSelfHostedRuntimeModel:
      notCloudModel &&
      (isSelfHostedProviderId(params?.model?.provider) ||
        Boolean(
          hostname &&
          (EXPLICIT_LOCAL_HOSTNAMES.has(hostname) ||
            (isBareProviderHostname(hostname) &&
              hasConfiguredLocalProviderSignal({
                cfg: params?.cfg,
                provider: params?.model?.provider,
              }))),
        )),
  };
}

function resolveLlmTimeoutBounds(params?: LlmTimeoutParams) {
  const runTimeoutMs = asPositiveFiniteNumber(params?.runTimeoutMs);
  const agentTimeoutMs = finiteSecondsToTimerSafeMilliseconds(
    params?.cfg?.agents?.defaults?.timeoutSeconds,
  );
  const hasExplicitRunTimeout = runTimeoutMs !== undefined;
  // Unlimited runs omit the sentinel but still retain provider liveness defaults.
  const boundedRunTimeoutMs =
    hasExplicitRunTimeout && runTimeoutMs < MAX_TIMER_TIMEOUT_MS ? runTimeoutMs : undefined;
  const timeoutBounds = [
    boundedRunTimeoutMs,
    hasExplicitRunTimeout ? undefined : agentTimeoutMs,
  ].filter((value): value is number => value !== undefined && value < MAX_TIMER_TIMEOUT_MS);
  return { boundedRunTimeoutMs, agentTimeoutMs, timeoutBounds };
}

const clampTimeoutMs = (valueMs: number) => clampTimerTimeoutMs(valueMs) ?? 1;

function resolveLlmTimeoutMs(
  phase: "idle" | "first-event",
  params?: LlmTimeoutParams & { trigger?: EmbeddedRunTrigger },
): number {
  const { boundedRunTimeoutMs, agentTimeoutMs, timeoutBounds } = resolveLlmTimeoutBounds(params);
  const { isLocalRuntimeModel, isSelfHostedRuntimeModel } = resolveRuntimeModelLocality(params);
  const modelRequestTimeoutMs = asPositiveFiniteNumber(params?.modelRequestTimeoutMs);
  // Provider opt-ins can exceed class defaults, while finite run/agent budgets still win.
  // An unlimited run does not disable this independent request-liveness budget.
  if (modelRequestTimeoutMs !== undefined) {
    return clampTimeoutMs(Math.min(modelRequestTimeoutMs, ...timeoutBounds));
  }
  if (phase === "first-event") {
    const defaultTimeoutMs =
      isLocalRuntimeModel || isSelfHostedRuntimeModel
        ? LOCAL_LLM_FIRST_EVENT_TIMEOUT_MS
        : CLOUD_LLM_FIRST_EVENT_TIMEOUT_MS;
    return clampTimeoutMs(Math.min(defaultTimeoutMs, ...timeoutBounds));
  }

  const classIdleTimeoutMs = isSelfHostedRuntimeModel
    ? SELF_HOSTED_LLM_IDLE_TIMEOUT_MS
    : DEFAULT_LLM_IDLE_TIMEOUT_MS;
  const budgetMs = boundedRunTimeoutMs ?? agentTimeoutMs;
  if (budgetMs === undefined) {
    return isLocalRuntimeModel ? 0 : classIdleTimeoutMs;
  }
  const boundedCron = boundedRunTimeoutMs !== undefined && params?.trigger === "cron";
  // Local endpoints have no idle ceiling. Explicit cron budgets also own
  // self-hosted stalls; ordinary self-hosted runs retain their 300s tolerance.
  if (isLocalRuntimeModel || (boundedCron && isSelfHostedRuntimeModel)) {
    return clampTimeoutMs(budgetMs);
  }
  return clampTimeoutMs(
    Math.min(budgetMs, boundedCron ? CRON_LLM_IDLE_TIMEOUT_MS : classIdleTimeoutMs),
  );
}

export function resolveLlmIdleTimeoutMs(
  params?: LlmTimeoutParams & { trigger?: EmbeddedRunTrigger },
): number {
  return resolveLlmTimeoutMs("idle", params);
}

export function resolveLlmFirstEventTimeoutMs(params?: LlmTimeoutParams): number {
  return resolveLlmTimeoutMs("first-event", params);
}

/**
 * Wraps a stream function with idle timeout detection for both stream creation
 * and iterator progress. Each successful `next()` resets the timer; a timeout
 * aborts the provider request and surfaces the same Error to the caller.
 * Creation ends at provider acceptance or stream activity, not when a producer
 * returns its stream object. `scope: "creation-only"` leaves local providers
 * free of gap policing after that boundary.
 *
 * When `runId` is provided, run-scoped tool activity can reset the active wait
 * and recent activity before stream creation bridges into the first wait.
 */
export function streamWithIdleTimeout(
  baseFn: StreamFn,
  timeoutMs: number,
  onIdleTimeout?: (error: Error) => void,
  opts?: { runId?: string; scope?: "creation-and-gaps" | "creation-only" },
): StreamFn {
  const guardIterationGaps = opts?.scope !== "creation-only";
  const runId = opts?.runId;
  return (model, context, options) => {
    let progressTimeoutMs = clampTimeoutMs(timeoutMs * 2);
    const trackCleanup = captureAsyncWorkTracker();
    const streamAbortController = new AbortController();
    const firstEventTimeoutMs = clampTimeoutMs(getFirstStreamEventTimeoutMs(options) ?? timeoutMs);
    const startTimer = (
      delay: number,
      reject: (error: Error) => void,
      budget = timeoutMs,
      reason = "no response from model",
      name = "LlmIdleTimeoutError",
    ) => {
      return setTimeout(() => {
        if (requestDeadline?.reject === reject) {
          requestTimedOut = true;
        }
        clearRequestDeadline();
        const error = Object.assign(
          new Error(`LLM idle timeout (${Math.floor(budget / 1000)}s): ${reason}`),
          { name },
        );
        streamAbortController.abort(error);
        onIdleTimeout?.(error);
        reject(error);
      }, delay).unref();
    };
    let requestDeadline:
      | { timer: NodeJS.Timeout; reject: (error: Error) => void; accepted: boolean }
      | undefined;
    let iterationWatchdogActive = false;
    let requestTimedOut = false;
    let requestTimeout: Promise<never> | undefined = new Promise<never>((_, reject) => {
      requestDeadline = {
        timer: startTimer(firstEventTimeoutMs, reject, firstEventTimeoutMs),
        reject,
        accepted: false,
      };
    });
    // A synchronous producer can time out before a consumer starts iterating.
    void requestTimeout.catch(() => {});
    const clearRequestDeadline = () => {
      clearTimeout(requestDeadline?.timer);
      requestDeadline = undefined;
      if (!requestTimedOut) {
        requestTimeout = undefined;
      }
      unsubscribeCreationActivity();
    };
    const finishCreation = () => {
      if (!requestDeadline || requestDeadline.accepted) {
        return;
      }
      requestDeadline.accepted = true;
      unsubscribeCreationActivity();
      // Acceptance can precede factory resolution and iterator admission.
      if (guardIterationGaps && !iterationWatchdogActive) {
        if (firstEventTimeoutMs === timeoutMs) {
          requestDeadline.timer.refresh();
        } else {
          clearTimeout(requestDeadline.timer);
          requestDeadline.timer = startTimer(timeoutMs, requestDeadline.reject);
        }
      } else {
        clearRequestDeadline();
      }
    };
    let producerReportsActivity = false;
    const recordActivity = (reportedProgressTimeoutMs?: number) => {
      producerReportsActivity = true;
      if (reportedProgressTimeoutMs !== undefined) {
        progressTimeoutMs = clampTimeoutMs(Math.max(timeoutMs, reportedProgressTimeoutMs));
      }
    };
    const unsubscribeCreationActivity = onLlmRequestActivity(
      streamAbortController.signal,
      (_progress, reportedProgressTimeoutMs) => {
        recordActivity(reportedProgressTimeoutMs);
        finishCreation();
      },
    );
    const sourceSignal = options?.signal;
    const abortFromSourceSignal = () => {
      clearRequestDeadline();
      streamAbortController.abort(sourceSignal?.reason);
    };
    // Mirror caller cancellation into the provider request while still allowing
    // this wrapper to abort independently on idle timeout.
    if (sourceSignal?.aborted) {
      abortFromSourceSignal();
    } else {
      sourceSignal?.addEventListener("abort", abortFromSourceSignal, { once: true });
    }
    const cleanupSourceSignal = () => {
      clearRequestDeadline();
      sourceSignal?.removeEventListener("abort", abortFromSourceSignal);
    };
    const withSourceAbort = <T>(promise: Promise<T>) =>
      sourceSignal ? abortable(sourceSignal, promise) : promise;
    const withRequestTimeout = <T>(promise: Promise<T>) =>
      requestTimeout ? Promise.race([promise, requestTimeout]) : promise;

    let maybeStream: ReturnType<StreamFn>;
    try {
      maybeStream = baseFn(
        model,
        context,
        withProviderAcceptanceObserver(
          { ...options, signal: streamAbortController.signal },
          finishCreation,
        ),
      );
    } catch (error) {
      cleanupSourceSignal();
      throw error;
    }

    const wrapStream = (stream: MutableAssistantMessageEventStream) => {
      const producerCompletion = getEventStreamCompletion(stream);
      void producerCompletion?.then(cleanupSourceSignal, cleanupSourceSignal);
      const originalAsyncIterator = stream[Symbol.asyncIterator].bind(stream);
      stream[Symbol.asyncIterator] = function () {
        const iterator = originalAsyncIterator();
        let returning: Promise<IteratorResult<AssistantMessageEvent>> | undefined;
        const returnIterator = (value?: unknown) => {
          // Defer invocation until the promise is stored: plugin return hooks
          // can reenter cleanup synchronously.
          returning ??= trackCleanup(() =>
            Promise.resolve().then(
              () => iterator.return?.(value) ?? { done: true as const, value: undefined },
            ),
          );
          void returning.catch(() => recordAgentCleanupFailure());
          return returning;
        };
        let idleTimer: NodeJS.Timeout | undefined;
        let idleTimerDelay = 0;
        let progressTimer: NodeJS.Timeout | undefined;
        let progressTimerDelay = 0;
        let progressTimerBudget = 0;
        let lastProgressAt = Date.now();
        let rejectIdleTimeout: ((error: Error) => void) | undefined;
        const pendingAborts = new Set<(error: Error) => void>();
        const abortIteration = () => {
          if (sourceSignal) {
            for (const reject of pendingAborts) {
              reject(createAbortableError(sourceSignal));
            }
          }
        };
        sourceSignal?.addEventListener("abort", abortIteration, { once: true });
        // Consume pre-stream tool activity once; reusing it shortens later chunk budgets.
        let streamFirstArmDone = false;
        // Police parked consumers until the native producer settles. Content-free
        // activity resets only connection liveness.
        let settled = false;

        const clearTimers = () => {
          clearTimeout(idleTimer);
          clearTimeout(progressTimer);
          idleTimer = progressTimer = undefined;
        };
        const rejectTimeout = (error: Error) => {
          clearTimers();
          rejectIdleTimeout?.(error);
        };
        const armTimer = (progress = true) => {
          if (!guardIterationGaps || settled || (!producerCompletion && !rejectIdleTimeout)) {
            clearTimers();
            return;
          }
          const now = Date.now();
          let effectiveTimeout = timeoutMs;
          if (!streamFirstArmDone) {
            const activeToolMs = runId ? getLastToolActivityMs(runId) : 0;
            if (activeToolMs > 0 && now - activeToolMs < timeoutMs) {
              effectiveTimeout = Math.max(1, timeoutMs - Math.max(0, now - activeToolMs));
            }
            streamFirstArmDone = true;
          }
          if (idleTimer && idleTimerDelay === effectiveTimeout) {
            idleTimer.refresh();
          } else {
            clearTimeout(idleTimer);
            idleTimer = startTimer(effectiveTimeout, rejectTimeout);
            idleTimerDelay = effectiveTimeout;
          }
          iterationWatchdogActive = true;
          if (requestDeadline?.accepted) {
            clearRequestDeadline();
          }
          if (progress) {
            lastProgressAt = now;
          }
          // Heartbeats preserve the progress deadline; only real progress resets it.
          if (
            progress &&
            progressTimer &&
            progressTimerDelay === progressTimeoutMs &&
            progressTimerBudget === progressTimeoutMs
          ) {
            progressTimer.refresh();
          } else if (progress || !progressTimer || progressTimerBudget !== progressTimeoutMs) {
            clearTimeout(progressTimer);
            progressTimerBudget = progressTimeoutMs;
            progressTimerDelay = Math.max(1, progressTimeoutMs - (now - lastProgressAt));
            progressTimer = startTimer(
              progressTimerDelay,
              rejectTimeout,
              progressTimeoutMs,
              "no model progress",
              "LlmNoProgressError",
            );
          }
        };
        const unsubscribeLlmActivity = onLlmRequestActivity(
          streamAbortController.signal,
          (progress, reportedProgressTimeoutMs) => {
            recordActivity(reportedProgressTimeoutMs);
            armTimer(progress);
            if (progress && runId && areDiagnosticsEnabledForProcess()) {
              markDiagnosticRunProgress({ runId, reason: "model_call:stream_progress" });
            }
          },
        );
        const unsubscribeStreamToolActivity = runId ? onToolActivity(runId, armTimer) : undefined;
        const settle = () => {
          if (settled) {
            return;
          }
          settled = true;
          rejectIdleTimeout = undefined;
          clearTimers();
          unsubscribeLlmActivity();
          unsubscribeStreamToolActivity?.();
          cleanupSourceSignal();
        };
        // Producer completion must not invoke result() decorators: they may
        // clear repair state that queued events still need when consumed.
        // Without native completion, preserve structural streams' historical
        // pending-next guard: a parked consumer cannot prove producer silence.
        void producerCompletion?.then(settle, settle);
        let iteratorFinished = false;
        const releaseAbortListener = () => {
          if (iteratorFinished && pendingAborts.size === 0) {
            sourceSignal?.removeEventListener("abort", abortIteration);
          }
        };
        const finishIterator = () => {
          settle();
          iteratorFinished = true;
          releaseAbortListener();
        };

        return createStreamIteratorWrapper({
          iterator,
          next: async (streamIterator) => {
            let pendingNext: ReturnType<typeof streamIterator.next> | undefined;
            let rejectAbort: ((error: Error) => void) | undefined;
            try {
              const waiting = new Promise<IteratorResult<AssistantMessageEvent>>(
                (resolve, reject) => {
                  rejectIdleTimeout = reject;
                  rejectAbort = reject;
                  if (sourceSignal) {
                    pendingAborts.add(reject);
                  }
                  armTimer(false);
                  // Cancellation rejects this wait synchronously, before a provider's
                  // mirrored-signal rejection can replace the caller's abort reason.
                  pendingNext = streamIterator.next();
                  void pendingNext.then(resolve, reject);
                  if (sourceSignal?.aborted) {
                    reject(createAbortableError(sourceSignal));
                  }
                },
              );
              const result = await withRequestTimeout(waiting);
              finishCreation();

              if (result.done) {
                finishIterator();
                return result;
              }

              rejectIdleTimeout = undefined;
              // Native producer completion lets us safely police parked consumers.
              // Structural streams retain their pending-next-only guard.
              // A notifying producer owns progress, including content-free events.
              // Structural streams without notifications retain the yield fallback.
              armTimer(!producerReportsActivity);
              return result;
            } catch (error) {
              finishIterator();
              // The caller's race can finish before the iterator's admitted
              // work. Its owner retains both operations through settlement.
              void trackCleanup(() => Promise.allSettled([pendingNext, returnIterator()])).catch(
                () => recordAgentCleanupFailure(),
              );
              throw sourceSignal ? toErrorObject(error, "Non-Error rejection") : error;
            } finally {
              if (rejectAbort) {
                pendingAborts.delete(rejectAbort);
              }
              releaseAbortListener();
            }
          },
          onReturn(_streamIterator, value) {
            finishIterator();
            return returnIterator(value);
          },
          onThrow(streamIterator, error) {
            finishIterator();
            return (
              streamIterator.throw?.(error) ??
              Promise.reject(toErrorObject(error, "Non-Error rejection"))
            );
          },
        });
      };

      return stream;
    };

    if (maybeStream && typeof maybeStream === "object" && "then" in maybeStream) {
      const source = Promise.resolve(maybeStream);
      const streamPromise = withSourceAbort(withRequestTimeout(source));
      return streamPromise.then(wrapStream, (error: unknown) => {
        cleanupSourceSignal();
        // Cancellation can win before an iterator exists. Retain late setup
        // and close its eventual stream through the same captured work owner.
        void trackCleanup(async () => {
          const late = await source.catch(() => undefined);
          if (late) {
            await late[Symbol.asyncIterator]().return?.();
          }
        }).catch(() => recordAgentCleanupFailure());
        throw error;
      });
    }
    return wrapStream(maybeStream);
  };
}
