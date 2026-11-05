import type { DecisionBatchV2, ProviderDecisionOutcomeV2 } from "openclaw/plugin-sdk/decisions";
import { buildTimeoutAbortSignal } from "openclaw/plugin-sdk/extension-shared";
import {
  shouldUseEnvHttpProxyForUrl,
  withTrustedEnvProxyGuardedFetchMode,
} from "openclaw/plugin-sdk/fetch-runtime";
import {
  assertOkOrThrowProviderError,
  createProviderOperationDeadline,
  createProviderOperationTimeoutResolver,
  ProviderHttpError,
  readProviderJsonResponse,
  type resolveProviderHttpRequestConfig,
} from "openclaw/plugin-sdk/provider-http";
import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import { racePromiseWithAbortSignal } from "openclaw/plugin-sdk/time-runtime";
import {
  decodeSageDecisionResult,
  encodeSageDecisionRequest,
  type encodeSageDecisionInput,
} from "./decision-codec.js";
import {
  parseSageBatchResponse,
  parseSageResponse,
  validateSageImage,
  type SageImageProbe,
} from "./sage-validation.js";
import type { SageRequest } from "./sage-wire.js";

class SageRequestError extends Error {
  constructor() {
    super("Invalid Sage request");
  }
}
class SageResponseError extends Error {
  constructor() {
    super("Sage: invalid or oversized response");
  }
}

type SageDecisionExecution = {
  readonly input: NonNullable<ReturnType<typeof encodeSageDecisionInput>>;
  readonly modelId: string;
  readonly capabilities: Parameters<typeof decodeSageDecisionResult>[4];
  readonly reasoning: SageRequest["reasoning"];
  readonly signal: AbortSignal;
  readonly deadlineMonotonicMs: number;
  readonly isAdmissible: () => boolean;
  readonly probeImage: SageImageProbe;
  readonly prepareRoute: () => ReturnType<typeof resolveProviderHttpRequestConfig>;
};

export async function executeSageDecision(
  batch: DecisionBatchV2,
  execution: SageDecisionExecution,
): Promise<ProviderDecisionOutcomeV2> {
  const { nativeContent, questions } = execution.input;
  const remainingBudgetMs = execution.deadlineMonotonicMs - performance.now();
  if (remainingBudgetMs <= 0) {
    return { status: "unavailable", reason: "transport" };
  }
  const request = encodeSageDecisionRequest(nativeContent, questions, execution.reasoning);
  if (!request) {
    return { status: "unavailable", reason: "unsupported-input" };
  }
  let admissionError: { error: unknown } | undefined;
  try {
    const route = execution.prepareRoute();
    const budget = execution.deadlineMonotonicMs - performance.now();
    if (budget <= 0) {
      return { status: "unavailable", reason: "transport" };
    }
    const deadline = createProviderOperationDeadline({
      label: "Sage decision",
      timeoutMs: budget,
    });
    const beforeRequest = () => {
      let admitted: boolean;
      try {
        admitted = execution.isAdmissible();
      } catch (error) {
        // Host authority failures must not become a retryable provider failure.
        admissionError = { error };
        throw error;
      }
      if (!admitted) {
        throw new Error("Sage evaluation is no longer admitted.");
      }
    };
    const response = await (async () => {
      // A finite deadline is mandatory. Never silently substitute the SDK's 60-second timeout.
      if (!Number.isFinite(deadline.deadlineAtMs)) {
        throw new Error("Sage requires a finite operation deadline");
      }
      const remaining = createProviderOperationTimeoutResolver({
        deadline,
        defaultTimeoutMs: 2_147_483_647,
      });
      execution.signal?.throwIfAborted();
      remaining();
      if (typeof nativeContent !== "string" && nativeContent.kind === "image") {
        const media = nativeContent.media;
        const validation = buildTimeoutAbortSignal({
          signal: execution.signal,
          timeoutMs: remaining(),
          operation: "Sage input validation",
        });
        const signal = validation.signal;
        try {
          // The probe may await native media work; cancellation must prevent a later POST.
          await racePromiseWithAbortSignal(
            () => validateSageImage(media, execution.probeImage),
            signal,
          );
          signal?.throwIfAborted();
        } catch {
          execution.signal?.throwIfAborted();
          signal?.throwIfAborted();
          remaining();
          throw new SageRequestError();
        } finally {
          validation.cleanup();
        }
      }
      execution.signal?.throwIfAborted();
      remaining();
      const base = new URL(route.baseUrl);
      if (
        !["https:", "http:"].includes(base.protocol) ||
        base.username ||
        base.password ||
        base.search ||
        base.hash
      ) {
        throw new Error("Invalid Sage base URL");
      }
      // Append to a configured prefix; an absolute /decide would silently escape it.
      base.pathname =
        base.pathname.replace(/\/+$/, "") + ("requests" in request ? "/decide/batch" : "/decide");
      const headers = new Headers(route.headers);
      headers.set("content-type", "application/json");
      const guardedRequest = {
        url: base.href,
        init: { method: "POST", headers, body: JSON.stringify(request) },
        timeoutMs: remaining(),
        signal: execution.signal,
        fetchImpl: globalThis.fetch,
        dispatcherPolicy: route.dispatcherPolicy,
        policy: route.allowPrivateNetwork ? { allowPrivateNetwork: true } : undefined,
        auditContext: "levanto-sage",
        // Recheck the owner after image validation and DNS, before each HTTP effect.
        beforeRequest,
      };
      // Preserve the provider HTTP helper's implicit proxy policy without retrying a billable POST.
      const result = await fetchWithSsrFGuard(
        !route.dispatcherPolicy && shouldUseEnvHttpProxyForUrl(base.href)
          ? withTrustedEnvProxyGuardedFetchMode(guardedRequest)
          : guardedRequest,
      );
      try {
        await assertOkOrThrowProviderError(result.response, "Sage request failed", {
          signal: execution.signal,
          bodyTimeoutMs: remaining,
          requestHeaders: headers,
        });
        try {
          const payload = await readProviderJsonResponse<unknown>(result.response, "Sage", {
            signal: execution.signal,
            timeoutMs: remaining,
            requestHeaders: headers,
          });
          const parsed =
            "requests" in request
              ? parseSageBatchResponse(payload, request)
              : parseSageResponse(payload, request.question, request.content);
          // Include decode and validation in the caller's total budget, not just response headers.
          execution.signal?.throwIfAborted();
          remaining();
          return parsed;
        } catch {
          execution.signal?.throwIfAborted();
          remaining();
          throw new SageResponseError();
        }
      } finally {
        await result.release();
      }
    })();
    execution.signal.throwIfAborted();
    if (performance.now() >= execution.deadlineMonotonicMs) {
      return { status: "unavailable", reason: "transport" };
    }
    return decodeSageDecisionResult(
      batch,
      questions,
      response,
      execution.modelId,
      execution.capabilities,
    );
  } catch (error) {
    if (admissionError) {
      throw admissionError.error;
    }
    execution.signal.throwIfAborted();
    if (error instanceof ProviderHttpError) {
      const reason =
        error.status === 401 || error.status === 403
          ? "authentication"
          : error.status === 429
            ? "rate-limited"
            : error.status === 400 || error.status === 413 || error.status === 422
              ? "unsupported-input"
              : "transport";
      return {
        status: "unavailable",
        reason,
        ...(error.retryAfterMs === undefined ? {} : { retryAfterMs: error.retryAfterMs }),
      };
    }
    return {
      status: "unavailable",
      reason:
        error instanceof SageRequestError
          ? "unsupported-input"
          : error instanceof SageResponseError
            ? "invalid-response"
            : "transport",
    };
  }
}
