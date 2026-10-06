import { getEventStreamCompletion, onLlmRequestActivity } from "@openclaw/ai/internal/runtime";
import { isCloudModelRef } from "@openclaw/model-catalog-core/model-catalog-refs";
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
import { abortable } from "./abortable.js";

const DEFAULT_LLM_IDLE_TIMEOUT_MS = 120_000;
const SELF_HOSTED_LLM_IDLE_TIMEOUT_MS = 300_000;
const CLOUD_LLM_FIRST_EVENT_TIMEOUT_MS = DEFAULT_LLM_IDLE_TIMEOUT_MS;
const LOCAL_LLM_FIRST_EVENT_TIMEOUT_MS = 300_000;
// Cron has its own outer watchdog; stream stalls must fail early enough for
// the existing model fallback chain to try the next configured candidate.
const CRON_LLM_IDLE_TIMEOUT_MS = 60_000;
const LOCAL_PROVIDER_AUTH_MARKERS = new Set(["custom-local", "ollama-local"]);
const SELF_HOSTED_PROVIDER_ID_PREFIXES = ["ollama", "lmstudio", "vllm", "sglang", "llama-cpp"];

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

function isExplicitLocalHostname(hostname: string): boolean {
  return (
    hostname === "docker.orb.internal" ||
    hostname === "host.docker.internal" ||
    hostname === "host.orb.internal"
  );
}

function isBareProviderHostname(hostname: string): boolean {
  if (hostname.includes(".") || hostname.includes(":")) {
    return false;
  }
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
  const exact = providers?.[normalizedProvider];
  if (exact) {
    return exact;
  }
  return Object.entries(providers ?? {}).find(
    ([key]) => key.trim().toLowerCase() === normalizedProvider,
  )?.[1];
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
          (isExplicitLocalHostname(hostname) ||
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

/**
 * Resolves the stream-idle watchdog timeout for one embedded run. Explicit
 * provider request timeouts and bounded run/agent timeouts cap the watchdog;
 * local provider base URLs disable the implicit cloud-provider default.
 */
export function resolveLlmIdleTimeoutMs(
  params?: LlmTimeoutParams & { trigger?: EmbeddedRunTrigger },
): number {
  const { boundedRunTimeoutMs, agentTimeoutMs, timeoutBounds } = resolveLlmTimeoutBounds(params);
  const { isLocalRuntimeModel, isSelfHostedRuntimeModel } = resolveRuntimeModelLocality(params);

  // Run/agent budgets bound idle from below the provider-class ceiling; they
  // must not shrink class tolerance (local has no ceiling, self-hosted 300s).
  // Clamping every class to the cloud default reopened #85826-style kills for
  // self-hosted users with explicit budgets above 120s.
  const clampToClassIdleCeiling = (budgetMs: number): number => {
    if (isLocalRuntimeModel) {
      return clampTimeoutMs(budgetMs);
    }
    const classIdleTimeoutMs = isSelfHostedRuntimeModel
      ? SELF_HOSTED_LLM_IDLE_TIMEOUT_MS
      : DEFAULT_LLM_IDLE_TIMEOUT_MS;
    return clampTimeoutMs(Math.min(budgetMs, classIdleTimeoutMs));
  };

  // Explicit per-model idle timeout (`models.providers.<id>.timeoutSeconds`) wins
  // over the NO_TIMEOUT_MS sentinel that runTimeoutMs may carry when the caller
  // declared "run is unlimited". The two are independent: an unlimited run does
  // not imply opting out of chunk-level hang detection.
  const modelRequestTimeoutMs = asPositiveFiniteNumber(params?.modelRequestTimeoutMs);
  if (modelRequestTimeoutMs !== undefined) {
    // Provider opt-ins may exceed the cloud ceiling; shorter run budgets still win.
    const boundedTimeoutMs = Math.min(modelRequestTimeoutMs, ...timeoutBounds);
    return clampTimeoutMs(boundedTimeoutMs);
  }

  // Unlimited run budget bounds total cost, not stream liveness. Only finite
  // explicit run budgets cap the idle watchdog.
  if (boundedRunTimeoutMs !== undefined) {
    if (params?.trigger === "cron") {
      if (isLocalRuntimeModel || isSelfHostedRuntimeModel) {
        return clampTimeoutMs(boundedRunTimeoutMs);
      }
      return clampTimeoutMs(Math.min(boundedRunTimeoutMs, CRON_LLM_IDLE_TIMEOUT_MS));
    }
    return clampToClassIdleCeiling(boundedRunTimeoutMs);
  }

  if (agentTimeoutMs !== undefined) {
    return clampToClassIdleCeiling(agentTimeoutMs);
  }

  // Local models have no implicit idle cap; proxied Ollama cloud models still do.
  if (isLocalRuntimeModel) {
    return 0;
  }

  return isSelfHostedRuntimeModel ? SELF_HOSTED_LLM_IDLE_TIMEOUT_MS : DEFAULT_LLM_IDLE_TIMEOUT_MS;
}

export function resolveLlmFirstEventTimeoutMs(params?: LlmTimeoutParams): number {
  const { timeoutBounds } = resolveLlmTimeoutBounds(params);
  const { isLocalRuntimeModel, isSelfHostedRuntimeModel } = resolveRuntimeModelLocality(params);

  const modelRequestTimeoutMs = asPositiveFiniteNumber(params?.modelRequestTimeoutMs);
  if (modelRequestTimeoutMs !== undefined) {
    return clampTimeoutMs(Math.min(modelRequestTimeoutMs, ...timeoutBounds));
  }

  const defaultTimeoutMs =
    isLocalRuntimeModel || isSelfHostedRuntimeModel
      ? LOCAL_LLM_FIRST_EVENT_TIMEOUT_MS
      : CLOUD_LLM_FIRST_EVENT_TIMEOUT_MS;
  return clampTimeoutMs(Math.min(defaultTimeoutMs, ...timeoutBounds));
}

/**
 * Wraps a stream function with idle timeout detection for both stream creation
 * and iterator progress. Each successful `next()` resets the timer; a timeout
 * aborts the provider request and surfaces the same Error to the caller.
 * `scope: "creation-only"` bounds only the creation phase: local providers opt
 * out of gap policing, but a request whose headers never arrive must still fail
 * instead of wedging the turn until the run budget.
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
  const progressTimeoutMs = clampTimeoutMs(timeoutMs * 2);
  return (model, context, options) => {
    const trackCleanup = captureAsyncWorkTracker();
    const streamAbortController = new AbortController();
    const sourceSignal = options?.signal;
    const abortStream = (reason?: unknown) => {
      if (!streamAbortController.signal.aborted) {
        streamAbortController.abort(reason);
      }
    };
    const abortFromSourceSignal = () => abortStream(sourceSignal?.reason);
    // Mirror caller cancellation into the provider request while still allowing
    // this wrapper to abort independently on idle timeout.
    if (sourceSignal?.aborted) {
      abortFromSourceSignal();
    } else {
      sourceSignal?.addEventListener("abort", abortFromSourceSignal, { once: true });
    }
    const cleanupSourceSignal = () => {
      sourceSignal?.removeEventListener("abort", abortFromSourceSignal);
    };
    const withSourceAbort = <T>(promise: Promise<T>) =>
      sourceSignal ? abortable(sourceSignal, promise) : promise;
    const startTimer = (delay: number, reject: (error: Error) => void, progress = false) => {
      const timer = setTimeout(() => {
        const budget = progress ? progressTimeoutMs : timeoutMs;
        const reason = progress ? "no model progress" : "no response from model";
        const error = new Error(`LLM idle timeout (${Math.floor(budget / 1000)}s): ${reason}`);
        abortStream(error);
        onIdleTimeout?.(error);
        reject(error);
      }, delay);
      timer.unref?.();
      return timer;
    };

    let maybeStream: ReturnType<StreamFn>;
    try {
      maybeStream = baseFn(model, context, { ...options, signal: streamAbortController.signal });
    } catch (error) {
      cleanupSourceSignal();
      throw error;
    }

    const wrapStream = (stream: MutableAssistantMessageEventStream) => {
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
        const producerCompletion = getEventStreamCompletion(stream);
        let idleTimer: NodeJS.Timeout | undefined;
        let progressTimer: NodeJS.Timeout | undefined;
        let rejectIdleTimeout: ((error: Error) => void) | undefined;
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
          clearTimeout(idleTimer);
          if (!guardIterationGaps || settled || (!producerCompletion && !rejectIdleTimeout)) {
            clearTimers();
            return;
          }
          const activeToolMs = runId ? getLastToolActivityMs(runId) : 0;
          const recentActivity = activeToolMs > 0 && Date.now() - activeToolMs < timeoutMs;
          const isFirstStreamArm = !streamFirstArmDone;
          const effectiveTimeout =
            isFirstStreamArm && recentActivity
              ? Math.max(1, timeoutMs - Math.max(0, Date.now() - activeToolMs))
              : timeoutMs;
          streamFirstArmDone = true;
          idleTimer = startTimer(effectiveTimeout, rejectTimeout);
          if (progress || !progressTimer) {
            clearTimeout(progressTimer);
            progressTimer = startTimer(progressTimeoutMs, rejectTimeout, true);
          }
        };
        const unsubscribeLlmActivity = onLlmRequestActivity(
          streamAbortController.signal,
          (progress) => {
            armTimer(progress);
            if (runId && areDiagnosticsEnabledForProcess()) {
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

        return createStreamIteratorWrapper({
          iterator,
          next: async (streamIterator) => {
            let pendingNext: ReturnType<typeof streamIterator.next> | undefined;
            try {
              const timeoutPromise = new Promise<never>((_, reject) => {
                rejectIdleTimeout = reject;
                armTimer(false);
              });
              // Providers may ignore their mirrored abort signal, so caller
              // cancellation must also settle this exact iterator wait.
              pendingNext = streamIterator.next();
              const result = await withSourceAbort(Promise.race([pendingNext, timeoutPromise]));

              if (result.done) {
                settle();
                return result;
              }

              rejectIdleTimeout = undefined;
              // Native producer completion lets us safely police parked consumers.
              // Structural streams retain their pending-next-only guard.
              armTimer();
              return result;
            } catch (error) {
              settle();
              // The caller's race can finish before the iterator's admitted
              // work. Its owner retains both operations through settlement.
              void trackCleanup(() => Promise.allSettled([pendingNext, returnIterator()])).catch(
                () => recordAgentCleanupFailure(),
              );
              throw error;
            }
          },
          onReturn(_streamIterator, value) {
            settle();
            return returnIterator(value);
          },
          onThrow(streamIterator, error) {
            settle();
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
      let streamPromiseTimer: NodeJS.Timeout | undefined;

      // Some providers return a pending Promise before the stream object exists;
      // protect that creation phase with the same idle watchdog.
      const timeoutPromise = new Promise<never>((_, reject) => {
        streamPromiseTimer = startTimer(timeoutMs, reject);
      });
      const streamPromise = withSourceAbort(Promise.race([source, timeoutPromise]));
      return streamPromise.then(
        (stream) => {
          clearTimeout(streamPromiseTimer);
          return wrapStream(stream);
        },
        (error: unknown) => {
          clearTimeout(streamPromiseTimer);
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
        },
      );
    }
    return wrapStream(maybeStream);
  };
}
