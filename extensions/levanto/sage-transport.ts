import { buildTimeoutAbortSignal } from "openclaw/plugin-sdk/extension-shared";
import {
  shouldUseEnvHttpProxyForUrl,
  withTrustedEnvProxyGuardedFetchMode,
} from "openclaw/plugin-sdk/fetch-runtime";
import {
  assertOkOrThrowProviderError,
  createProviderOperationTimeoutResolver,
  readProviderJsonResponse,
  type postJsonRequest,
  type ProviderOperationDeadline,
} from "openclaw/plugin-sdk/provider-http";
import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import { racePromiseWithAbortSignal } from "openclaw/plugin-sdk/time-runtime";
import {
  parseSageBatchResponse,
  parseSageResponse,
  validateSageRequest,
  type SageImageProbe,
} from "./sage-validation.js";
import type {
  SageBatchRequest,
  SageBatchResponse,
  SageRequest,
  SageResponse,
} from "./sage-wire.js";

export class SageRequestError extends Error {
  constructor() {
    super("Invalid Sage request");
  }
}
export class SageResponseError extends Error {
  constructor() {
    super("Sage: invalid or oversized response");
  }
}

type PostOptions = Parameters<typeof postJsonRequest>[0];
// Prepared by the common provider owner: no auth, catalog, proxy or trust discovery here.
type SageTransport = Pick<
  PostOptions,
  "headers" | "dispatcherPolicy" | "ssrfPolicy" | "allowPrivateNetwork" | "mode" | "fetchFn"
> & {
  baseUrl: string;
  deadline: ProviderOperationDeadline;
  signal?: AbortSignal;
  probeImage?: SageImageProbe;
  beforeRequest: () => void;
};

export function executeSageRequest(
  request: SageRequest,
  transport: SageTransport,
): Promise<SageResponse>;
export function executeSageRequest(
  request: SageBatchRequest,
  transport: SageTransport,
): Promise<SageBatchResponse>;
export async function executeSageRequest(
  request: SageRequest | SageBatchRequest,
  transport: SageTransport,
): Promise<SageResponse | SageBatchResponse> {
  // A finite deadline is mandatory. Never silently substitute the SDK's 60-second timeout.
  if (!Number.isFinite(transport.deadline.deadlineAtMs)) {
    throw new Error("Sage requires a finite operation deadline");
  }
  const remaining = createProviderOperationTimeoutResolver({
    deadline: transport.deadline,
    defaultTimeoutMs: 2_147_483_647,
  });
  transport.signal?.throwIfAborted();
  remaining();
  const validation = buildTimeoutAbortSignal({
    signal: transport.signal,
    timeoutMs: remaining(),
    operation: "Sage input validation",
  });
  const signal = validation.signal;
  try {
    // The normal media owner retains its read-only probe; cancellation must not
    // leave this request waiting for it or allow a later HTTP effect.
    await racePromiseWithAbortSignal(
      () => validateSageRequest(request, transport.probeImage),
      signal,
    );
    signal?.throwIfAborted();
  } catch {
    transport.signal?.throwIfAborted();
    signal?.throwIfAborted();
    remaining();
    throw new SageRequestError();
  } finally {
    validation.cleanup();
  }
  transport.signal?.throwIfAborted();
  remaining();
  const base = new URL(transport.baseUrl);
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
  const headers = new Headers(transport.headers);
  headers.set("content-type", "application/json");
  const guardedRequest = {
    url: base.href,
    init: { method: "POST", headers, body: JSON.stringify(request) },
    timeoutMs: remaining(),
    signal: transport.signal,
    fetchImpl: transport.fetchFn,
    dispatcherPolicy: transport.dispatcherPolicy,
    policy: transport.allowPrivateNetwork
      ? { ...transport.ssrfPolicy, allowPrivateNetwork: true }
      : transport.ssrfPolicy,
    mode: transport.mode,
    auditContext: "levanto-sage",
    // Recheck the owner after image validation and DNS, before each HTTP effect.
    beforeRequest: transport.beforeRequest,
  };
  // Preserve the provider HTTP helper's implicit proxy policy without retrying a billable POST.
  const result = await fetchWithSsrFGuard(
    transport.mode === undefined &&
      !transport.dispatcherPolicy &&
      shouldUseEnvHttpProxyForUrl(base.href)
      ? withTrustedEnvProxyGuardedFetchMode(guardedRequest)
      : guardedRequest,
  );
  try {
    await assertOkOrThrowProviderError(result.response, "Sage request failed", {
      signal: transport.signal,
      bodyTimeoutMs: remaining,
      requestHeaders: headers,
    });
    try {
      const payload = await readProviderJsonResponse<unknown>(result.response, "Sage", {
        signal: transport.signal,
        timeoutMs: remaining,
        requestHeaders: headers,
      });
      const parsed =
        "requests" in request
          ? parseSageBatchResponse(payload, request)
          : parseSageResponse(payload, request.question, request.content);
      // Include decode and validation in the caller's total budget, not just response headers.
      transport.signal?.throwIfAborted();
      remaining();
      return parsed;
    } catch {
      transport.signal?.throwIfAborted();
      remaining();
      throw new SageResponseError();
    }
  } finally {
    await result.release();
  }
}
