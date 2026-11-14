import type {
  DecisionBatch,
  DecisionProviderV1,
  ProviderDecisionOutcome,
  ProviderFailureReason,
} from "openclaw/plugin-sdk/decisions";
import { buildTimeoutAbortSignal } from "openclaw/plugin-sdk/extension-shared";
import {
  responseWithRelease,
  shouldUseEnvHttpProxyForUrl,
  withTrustedEnvProxyGuardedFetchMode,
} from "openclaw/plugin-sdk/fetch-runtime";
import { readResponseWithLimit } from "openclaw/plugin-sdk/response-limit-runtime";
import { parseRetryAfterHeaderSeconds } from "openclaw/plugin-sdk/retry-runtime";
import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import {
  supportsSubQDecisionBatch,
  encodeSubQDecisionRequest,
  decodeSubQDecisionResult,
} from "./decision-codec.js";

const ENDPOINT = "https://api.subq.ai/v1/systemone";
// The shared Decision runtime admits at most 1 MiB. Also bound the vendor response.
const MAX_BYTES = 1024 * 1024;
type Context = Parameters<DecisionProviderV1["evaluate"]>[1];
const unavailable = (reason: ProviderFailureReason): ProviderDecisionOutcome => ({
  status: "unavailable",
  reason,
});

export async function evaluate(
  batch: DecisionBatch,
  context: Context,
  apiKey: string,
): Promise<ProviderDecisionOutcome> {
  context.signal.throwIfAborted();
  if (!supportsSubQDecisionBatch(batch, context.model)) {
    return unavailable("unsupported-input");
  }
  const body = encodeSubQDecisionRequest(batch, context.model);
  if (Buffer.byteLength(body) > MAX_BYTES) {
    return unavailable("unsupported-input");
  }
  return executeSubQDecision(batch, {
    body,
    apiKey,
    signal: context.signal,
    deadlineMonotonicMs: context.deadlineMonotonicMs,
    isAdmissible: context.isAdmissible,
  });
}

type SubQDecisionExecution = Pick<Context, "signal" | "deadlineMonotonicMs" | "isAdmissible"> & {
  readonly body: string;
  readonly apiKey: string;
};

async function executeSubQDecision(
  batch: DecisionBatch,
  execution: SubQDecisionExecution,
): Promise<ProviderDecisionOutcome> {
  const { body, apiKey } = execution;
  const remaining = execution.deadlineMonotonicMs - performance.now();
  if (remaining <= 0) {
    return unavailable("transport");
  }
  const { signal, cleanup } = buildTimeoutAbortSignal({
    signal: execution.signal,
    timeoutMs: Math.ceil(remaining),
    operation: "SubQ evaluation",
  });
  let authorityFailure: { error: unknown } | undefined;
  const assertActive = () => {
    signal?.throwIfAborted();
    let admitted: boolean | undefined;
    try {
      admitted = execution.isAdmissible?.();
    } catch (error) {
      authorityFailure = { error };
      throw error;
    }
    if (performance.now() >= execution.deadlineMonotonicMs || admitted === false) {
      throw new Error("SubQ evaluation is no longer admitted.");
    }
  };
  try {
    assertActive();
    const request = {
      url: ENDPOINT,
      requireHttps: true,
      maxRedirects: 0,
      signal,
      beforeRequest: assertActive,
      init: {
        method: "POST",
        headers: {
          Authorization: "Bearer " + apiKey,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body,
      },
    };
    const guarded = await fetchWithSsrFGuard(
      shouldUseEnvHttpProxyForUrl(ENDPOINT)
        ? withTrustedEnvProxyGuardedFetchMode(request)
        : request,
    );
    let releasePromise: Promise<void> | undefined;
    const release = () => (releasePromise ??= Promise.resolve().then(() => guarded.release()));
    try {
      const response = responseWithRelease(guarded.response, release);
      if (!response.ok) {
        // Error bodies can echo credentials/state; never read them or surface vendor diagnostics.
        await response.body?.cancel();
        if (response.status === 401 || response.status === 403) {
          return unavailable("authentication");
        }
        if (response.status === 429) {
          const seconds = parseRetryAfterHeaderSeconds(response.headers.get("retry-after"));
          return {
            status: "unavailable",
            reason: "rate-limited",
            ...(seconds === undefined ? {} : { retryAfterMs: seconds * 1000 }),
          };
        }
        return unavailable(
          [400, 413, 422].includes(response.status) ? "unsupported-input" : "transport",
        );
      }
      try {
        const bytes = await readResponseWithLimit(response, MAX_BYTES, { signal });
        execution.signal.throwIfAborted();
        const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        if (text.includes(apiKey)) {
          return unavailable("invalid-response");
        }
        return { status: "ok", result: decodeSubQDecisionResult(JSON.parse(text), batch) };
      } catch {
        execution.signal.throwIfAborted();
        return unavailable(signal?.aborted ? "transport" : "invalid-response");
      }
    } finally {
      await release();
    }
  } catch {
    execution.signal.throwIfAborted();
    if (authorityFailure) {
      throw authorityFailure.error;
    }
    return unavailable("transport");
  } finally {
    cleanup();
  }
}
