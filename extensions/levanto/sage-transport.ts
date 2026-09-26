import { buildTimeoutAbortSignal } from "openclaw/plugin-sdk/extension-shared";
import {
  assertOkOrThrowProviderError,
  createProviderOperationTimeoutResolver,
  postJsonRequest,
  readProviderJsonResponse,
  type ProviderOperationDeadline,
} from "openclaw/plugin-sdk/provider-http";
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
  let onAbort: (() => void) | undefined;
  try {
    if (!signal) {
      throw new Error("Sage validation requires a deadline signal");
    }
    signal.throwIfAborted();
    const aborted = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(new Error("Sage validation aborted"));
      signal.addEventListener("abort", onAbort, { once: true });
    });
    // The normal media owner retains its read-only probe; cancellation must not
    // leave this request waiting for it or allow a later HTTP effect.
    await Promise.race([validateSageRequest(request, transport.probeImage), aborted]);
    signal.throwIfAborted();
  } catch {
    transport.signal?.throwIfAborted();
    signal?.throwIfAborted();
    remaining();
    throw new SageRequestError();
  } finally {
    if (onAbort) {
      signal?.removeEventListener("abort", onAbort);
    }
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
  const result = await postJsonRequest({
    url: base.href,
    headers,
    body: request,
    timeoutMs: remaining(),
    signal: transport.signal,
    fetchFn: transport.fetchFn,
    dispatcherPolicy: transport.dispatcherPolicy,
    ssrfPolicy: transport.ssrfPolicy,
    allowPrivateNetwork: transport.allowPrivateNetwork,
    mode: transport.mode,
    auditContext: "levanto-sage",
    // No retryStage: a billable POST is attempted once, including abstentions and 503s.
  });
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
