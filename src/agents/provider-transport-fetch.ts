import {
  emitModelTransportDebug,
  emitModelTransportError,
  formatModelTransportDebugUrl,
} from "@openclaw/ai/diagnostics";
import { parseRetryAfterHeadersSeconds as parseRetryAfterSeconds } from "@openclaw/ai/internal/retry-after";
import {
  isCloudMetadataIpAddress,
  isLinkLocalIpAddress,
  isRfc8215LocalUseNat64Ipv6Address,
  parseCanonicalIpAddress,
} from "@openclaw/net-policy/ip";
import {
  asFiniteNumberInRange,
  clampPositiveTimerTimeoutMs,
  parseStrictFiniteNumber,
} from "@openclaw/normalization-core/number-coercion";
import {
  fetchWithSsrFGuard,
  withTrustedEnvProxyGuardedFetchMode,
} from "../infra/net/fetch-guard.js";
import { wrapGuardedBodyStream } from "../infra/net/guarded-body-stream.js";
import { shouldUseEnvHttpProxyForUrl } from "../infra/net/proxy-env.js";
import {
  mergeSsrFPolicies,
  ssrfPolicyFromHttpBaseUrlFakeIpHostnameAllowlist,
  ssrfPolicyFromHttpBaseUrlAllowedOrigin,
  SsrFBlockedError,
  type SsrFPolicy,
} from "../infra/net/ssrf.js";
import type { Model } from "../llm/types.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { resolveDebugProxySettings } from "../proxy-capture/env.js";
import { isRetryableProviderHttpStatus } from "./failover/retry-evidence.js";
import {
  ProviderHttpError,
  readResponseTextLimited,
  summarizeProviderTransportError,
} from "./provider-http-errors.js";
import type { ProviderLocalServiceLease } from "./provider-local-service-target.js";
import { ensureModelProviderLocalService } from "./provider-local-service.js";
import {
  buildProviderRequestDispatcherPolicy,
  getModelProviderRequestRouteFacts,
  getModelProviderRequestTransport,
  mergeModelProviderRequestOverrides,
  resolveProviderRequestPolicyConfig,
  type ModelProviderRequestTransportOverrides,
} from "./provider-request-config.js";
import { getProviderTransportDispatcherPool } from "./provider-transport-dispatcher-pool.js";
import { requestBodyHasStreamTrue } from "./provider-transport-request-body.js";
import { swapSecretSentinelsForEgress } from "./provider-transport-secret-egress.js";
import {
  cancelReaderBestEffort,
  findSseEventBoundary,
  hasReadableSseData,
  isProviderJsonContentType,
  prepareOpenAISdkSseResponse,
} from "./provider-transport-sse.js";

const DEFAULT_MAX_SDK_RETRY_WAIT_SECONDS = 60;
const SLOW_MODEL_FETCH_MS = 1_000;
const OPENAI_SDK_STREAM_CONTENT_SNIFF_BYTES = 2 * 1024;
const log = createSubsystemLogger("provider-transport-fetch");

const BLOCKED_EXACT_ORIGIN_TRUST_HOSTNAME_LABELS = new Set(["instance-data"]);
const PLAIN_DECIMAL_NUMBER_RE = /^\d+(?:\.\d+)?$/;

function shouldSanitizeOpenAISdkSseResponse(model: Model): boolean {
  return (
    model.provider !== "openai" ||
    URL.parse(model.baseUrl)?.hostname.toLowerCase() !== "api.openai.com"
  );
}

type OpenAISdkStreamBodyKind = "html" | "json" | "sse" | "unknown";

function classifyOpenAISdkStreamBodyPrefix(text: string): OpenAISdkStreamBodyKind {
  const trimmed = text.replace(/^\uFEFF/u, "").trimStart();
  if (!trimmed) {
    return "unknown";
  }
  if (trimmed.startsWith("<")) {
    return "html";
  }
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    return "json";
  }
  if (/^(?::|(?:data|event|id|retry)(?::|\r?\n|\r))/u.test(trimmed)) {
    return "sse";
  }
  const boundary = findSseEventBoundary(text);
  if (boundary && hasReadableSseData(text.slice(0, boundary.index))) {
    return "sse";
  }
  return "unknown";
}

async function classifyOpenAISdkStreamBody(response: Response): Promise<OpenAISdkStreamBodyKind> {
  const reader = response.clone().body?.getReader();
  if (!reader) {
    return "unknown";
  }

  const decoder = new TextDecoder();
  let total = 0;
  let text = "";
  try {
    while (total < OPENAI_SDK_STREAM_CONTENT_SNIFF_BYTES) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }
      if (!value || value.byteLength === 0) {
        continue;
      }
      const remaining = OPENAI_SDK_STREAM_CONTENT_SNIFF_BYTES - total;
      const chunk = value.byteLength > remaining ? value.subarray(0, remaining) : value;
      total += chunk.byteLength;
      text += decoder.decode(chunk, { stream: true });
      const kind = classifyOpenAISdkStreamBodyPrefix(text);
      if (kind !== "unknown") {
        return kind;
      }
    }
    text += decoder.decode();
    return classifyOpenAISdkStreamBodyPrefix(text);
  } finally {
    void cancelReaderBestEffort(reader);
  }
}

function withOpenAISdkStreamContentType(response: Response, contentType: string): Response {
  const normalized = new Response(response.body, response);
  normalized.headers.set("content-type", contentType);
  return normalized;
}

async function normalizeOpenAISdkStreamContentType(params: {
  response: Response;
  model: Model;
  release: () => Promise<void>;
  localServiceLease?: ProviderLocalServiceLease;
}): Promise<Response> {
  const contentType = params.response.headers.get("content-type") ?? "";
  if (!params.response.ok || !params.response.body) {
    return params.response;
  }
  if (/\btext\/event-stream\b/i.test(contentType)) {
    return params.response;
  }
  const isJson = isProviderJsonContentType(contentType);
  if (isJson || !contentType.trim()) {
    // Some OpenAI-compatible gateways stream real SSE (`data: {...}`) but mislabel
    // the response as JSON. Without relabeling, the JSON-wrap fallback below would
    // re-prefix each frame as `data: data: {...}`, breaking JSON.parse in the SDK.
    // Missing content types use the same clone sniff while preserving the original body.
    const kind = await classifyOpenAISdkStreamBody(params.response).catch(() => "unknown" as const);
    if (kind === "sse") {
      return withOpenAISdkStreamContentType(params.response, "text/event-stream; charset=utf-8");
    }
    if (isJson) {
      return params.response;
    }
    if (kind === "json") {
      return withOpenAISdkStreamContentType(params.response, "application/json; charset=utf-8");
    }
  }
  const body = await readResponseTextLimited(params.response).catch(() => "");
  await params.release().catch(() => undefined);
  params.localServiceLease?.release();
  const hint =
    "OpenAI-compatible streamed responses must be text/event-stream or JSON; got " +
    `${contentType || "missing content-type"}. Check the provider baseUrl; ` +
    "OpenAI-compatible APIs commonly require a /v1 path prefix.";
  throw new ProviderHttpError(`${params.model.provider}/${params.model.id}: ${hint}`, {
    status: params.response.status,
    code: "invalid_provider_content_type",
    type: "invalid_response",
    body,
  });
}

function resolveMaxSdkRetryWaitSeconds(): number | undefined {
  const raw = process.env.OPENCLAW_SDK_RETRY_MAX_WAIT_SECONDS?.trim();
  if (!raw) {
    return DEFAULT_MAX_SDK_RETRY_WAIT_SECONDS;
  }

  if (/^(?:0|false|off|none|disabled)$/i.test(raw)) {
    return undefined;
  }

  if (!PLAIN_DECIMAL_NUMBER_RE.test(raw)) {
    return DEFAULT_MAX_SDK_RETRY_WAIT_SECONDS;
  }

  return (
    asFiniteNumberInRange(parseStrictFiniteNumber(raw), {
      min: 0,
      minExclusive: true,
      max: Number.MAX_SAFE_INTEGER,
    }) ?? DEFAULT_MAX_SDK_RETRY_WAIT_SECONDS
  );
}

function shouldBypassLongSdkRetry(response: Response): boolean {
  const maxWaitSeconds = resolveMaxSdkRetryWaitSeconds();
  if (maxWaitSeconds === undefined) {
    return false;
  }

  const status = response.status;
  if (!isRetryableProviderHttpStatus(status)) {
    return false;
  }

  const retryAfterSeconds = parseRetryAfterSeconds(response.headers);
  if (retryAfterSeconds !== undefined) {
    return retryAfterSeconds > maxWaitSeconds;
  }

  return status === 429;
}

type ProviderRequestRateLimitConfig = NonNullable<
  ModelProviderRequestTransportOverrides["rateLimit"]
>;

type ProviderRequestRateLimitBucket = {
  expiresAt: number;
  queue: Promise<void>;
  queued: number;
  requestTimes: number[];
  lastDispatchAt: number;
};

const DEFAULT_PROVIDER_RATE_LIMIT_MAX_QUEUE_SIZE = 64;
const PROVIDER_RATE_LIMIT_WINDOW_MS = 60_000;

const providerRequestRateLimitBuckets = new Map<string, ProviderRequestRateLimitBucket>();

function resetProviderRequestRateLimitBucketsForTests(): void {
  providerRequestRateLimitBuckets.clear();
}

function getProviderRequestRateLimitBucketCountForTests(): number {
  return providerRequestRateLimitBuckets.size;
}

function pruneProviderRequestRateLimitBuckets(now: number): void {
  for (const [key, bucket] of providerRequestRateLimitBuckets) {
    if (bucket.queued === 0 && bucket.expiresAt > 0 && bucket.expiresAt <= now) {
      providerRequestRateLimitBuckets.delete(key);
    }
  }
}

function recordProviderRequestRateLimitDispatch(
  bucket: ProviderRequestRateLimitBucket,
  config: ProviderRequestRateLimitConfig,
  now = Date.now(),
): void {
  bucket.lastDispatchAt = now;
  bucket.requestTimes.push(now);
  bucket.expiresAt = now + Math.max(PROVIDER_RATE_LIMIT_WINDOW_MS, config.minIntervalMs ?? 0);
}

function createProviderRequestRateLimitAbortError(signal?: AbortSignal): Error {
  const reason = signal?.reason;
  if (reason instanceof Error) {
    return reason;
  }
  const error =
    reason === undefined
      ? new Error("Request was aborted")
      : new Error("Request was aborted", { cause: reason });
  error.name = "AbortError";
  return error;
}

function sleepForRateLimit(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(createProviderRequestRateLimitAbortError(signal));
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      },
      clampTimerTimeoutMs(delayMs, 0) ?? 0,
    );
    const onAbort = () => {
      clearTimeout(timer);
      reject(createProviderRequestRateLimitAbortError(signal));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function resolveProviderRateLimitKey(model: Model): string {
  return [model.provider, model.id, model.api, model.baseUrl].join("\0");
}

function resolveProviderRateLimitDelayMs(
  bucket: ProviderRequestRateLimitBucket,
  config: ProviderRequestRateLimitConfig,
): number {
  const now = Date.now();
  bucket.requestTimes = bucket.requestTimes.filter(
    (time) => time > now - PROVIDER_RATE_LIMIT_WINDOW_MS,
  );
  const intervalDelayMs = Math.max(0, (config.minIntervalMs ?? 0) - (now - bucket.lastDispatchAt));
  const oldest = bucket.requestTimes[0];
  const minuteDelayMs =
    config.requestsPerMinute &&
    bucket.requestTimes.length >= config.requestsPerMinute &&
    oldest !== undefined
      ? Math.max(0, oldest + 60_000 - now)
      : 0;
  return Math.max(intervalDelayMs, minuteDelayMs);
}

function buildProviderRateLimitQueueFullResponse(model: Model): Response {
  return new Response(
    JSON.stringify({
      error: {
        message: `${model.provider}/${model.id}: provider request rate-limit queue is full`,
        type: "rate_limit",
        code: "provider_rate_limit_queue_full",
      },
    }),
    {
      status: 429,
      statusText: "Too Many Requests",
      headers: {
        "content-type": "application/json",
        "x-should-retry": "false",
      },
    },
  );
}

async function waitForProviderRequestRateLimit(
  model: Model,
  config?: ProviderRequestRateLimitConfig,
  signal?: AbortSignal,
): Promise<Response | undefined> {
  if (!config || (!config.requestsPerMinute && !config.minIntervalMs)) {
    return undefined;
  }
  pruneProviderRequestRateLimitBuckets(Date.now());
  const key = resolveProviderRateLimitKey(model);
  const bucket = providerRequestRateLimitBuckets.get(key) ?? {
    expiresAt: 0,
    queue: Promise.resolve(),
    queued: 0,
    requestTimes: [],
    lastDispatchAt: 0,
  };
  providerRequestRateLimitBuckets.set(key, bucket);
  const maxQueueSize = config.maxQueueSize ?? DEFAULT_PROVIDER_RATE_LIMIT_MAX_QUEUE_SIZE;
  if (bucket.queued === 0 && resolveProviderRateLimitDelayMs(bucket, config) <= 0) {
    recordProviderRequestRateLimitDispatch(bucket, config);
    return undefined;
  }
  if (bucket.queued >= maxQueueSize) {
    return buildProviderRateLimitQueueFullResponse(model);
  }
  bucket.queued += 1;
  const turn = bucket.queue.then(async () => {
    const delayMs = resolveProviderRateLimitDelayMs(bucket, config);
    if (delayMs > 0) {
      await sleepForRateLimit(delayMs, signal);
    }
    recordProviderRequestRateLimitDispatch(bucket, config);
  });
  bucket.queue = turn.catch(() => undefined);
  try {
    await turn;
  } finally {
    bucket.queued = Math.max(0, bucket.queued - 1);
    pruneProviderRequestRateLimitBuckets(Date.now());
  }
  return undefined;
}
function buildManagedResponse(
  response: Response,
  release: () => Promise<void>,
  refreshTimeout?: () => void,
  localServiceLease?: ProviderLocalServiceLease,
): Response {
  const finalizeLocalServiceLease = () => {
    localServiceLease?.release();
  };
  if (!response.body) {
    void release().finally(finalizeLocalServiceLease);
    return response;
  }
  const wrappedBody = wrapGuardedBodyStream({
    body: response.body,
    // Lease release must survive a failed guard release so local services do not leak.
    cleanup: async () => {
      try {
        await release().catch(() => undefined);
      } finally {
        finalizeLocalServiceLease();
      }
    },
    refreshTimeout,
  });
  return new Response(wrappedBody, response);
}

function resolveModelRequestPolicy(model: Model) {
  const debugProxy = resolveDebugProxySettings();
  const explicitDebugProxyUrl =
    debugProxy.enabled && debugProxy.proxyUrl && URL.parse(model.baseUrl)?.protocol === "https:"
      ? debugProxy.proxyUrl
      : undefined;
  const request = mergeModelProviderRequestOverrides(getModelProviderRequestTransport(model), {
    proxy: explicitDebugProxyUrl
      ? {
          mode: "explicit-proxy",
          url: explicitDebugProxyUrl,
        }
      : undefined,
  });
  const routeFacts = getModelProviderRequestRouteFacts(model);
  return resolveProviderRequestPolicyConfig({
    provider: model.provider,
    api: model.api,
    baseUrl: model.baseUrl,
    ...(routeFacts ? { routeFacts } : {}),
    capability: "llm",
    transport: "stream",
    request,
  });
}

export function resolveModelRequestTimeoutMs(
  model: Model,
  timeoutMs: number | undefined,
): number | undefined {
  return clampPositiveTimerTimeoutMs(
    timeoutMs === undefined
      ? (model as { requestTimeoutMs?: unknown }).requestTimeoutMs
      : timeoutMs,
  );
}

function resolveHttpOrigin(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) {
    return undefined;
  }
  const parsed = URL.parse(value);
  if (!parsed || (parsed.protocol !== "http:" && parsed.protocol !== "https:")) {
    return undefined;
  }
  parsed.hostname = parsed.hostname.replace(/\.+$/, "");
  return parsed.origin.toLowerCase();
}

function normalizeProviderOriginHostname(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) {
    return undefined;
  }
  const parsed = URL.parse(value);
  if (!parsed || (parsed.protocol !== "http:" && parsed.protocol !== "https:")) {
    return undefined;
  }
  return parsed.hostname.trim().toLowerCase().replace(/\.+$/, "") || undefined;
}

export function resolveProviderTransportSsrFPolicy(params: {
  baseUrl?: string;
  url: string;
  allowPrivateNetwork?: boolean;
  trustConfiguredBaseUrlOrigin?: boolean;
}): SsrFPolicy | undefined {
  const baseUrl = params.baseUrl;
  const baseOrigin = resolveHttpOrigin(baseUrl);
  const requestOrigin = resolveHttpOrigin(params.url);
  const requestMatchesBaseOrigin =
    typeof baseUrl === "string" && Boolean(baseOrigin) && requestOrigin === baseOrigin;
  const hostname = requestMatchesBaseOrigin ? normalizeProviderOriginHostname(baseUrl) : undefined;
  const eligibleHostname =
    hostname &&
    !hostname
      .split(".")
      .filter(Boolean)
      .some(
        (label) =>
          label.includes("metadata") || BLOCKED_EXACT_ORIGIN_TRUST_HOSTNAME_LABELS.has(label),
      );
  const baseUrlOriginPolicy =
    requestMatchesBaseOrigin &&
    params.trustConfiguredBaseUrlOrigin &&
    eligibleHostname &&
    !isLinkLocalIpAddress(hostname) &&
    !isCloudMetadataIpAddress(hostname) &&
    !isRfc8215LocalUseNat64Ipv6Address(hostname)
      ? ssrfPolicyFromHttpBaseUrlAllowedOrigin(baseUrl)
      : undefined;
  // Fake-IP trust is hostname-scoped and orthogonal to exact-origin private-IP trust.
  // It is for DNS hostnames only and does not allow literal private IPs by itself.
  const fakeIpPolicy =
    requestMatchesBaseOrigin && eligibleHostname && !parseCanonicalIpAddress(hostname)
      ? ssrfPolicyFromHttpBaseUrlFakeIpHostnameAllowlist(baseUrl)
      : undefined;
  return mergeSsrFPolicies(
    baseUrlOriginPolicy,
    fakeIpPolicy,
    params.allowPrivateNetwork ? { allowPrivateNetwork: true } : undefined,
  );
}

export const testing = {
  getProviderRequestRateLimitBucketCountForTests,
  resetProviderRequestRateLimitBucketsForTests,
};
function withModelProviderNetworkRemediation(
  error: unknown,
  params: {
    baseUrl?: string;
    providerId: string;
    url: string;
  },
): unknown {
  const baseOrigin = resolveHttpOrigin(params.baseUrl);
  const requestOrigin = resolveHttpOrigin(params.url);
  const hostname = normalizeProviderOriginHostname(params.baseUrl);
  if (
    !(error instanceof SsrFBlockedError) ||
    !baseOrigin ||
    requestOrigin !== baseOrigin ||
    !hostname ||
    !isRfc8215LocalUseNat64Ipv6Address(hostname)
  ) {
    return error;
  }
  return new SsrFBlockedError(
    `Configured model provider ${params.providerId} uses local-use NAT64 origin ` +
      `${baseOrigin}, which OpenClaw blocks by default. Move the provider to a ` +
      `loopback, LAN, or tailnet address, or set ` +
      `models.providers.${params.providerId}.request.allowPrivateNetwork=true only for an ` +
      `operator-controlled endpoint. Original block: ${error.message}`,
  );
}

export function buildGuardedModelFetch(
  model: Model,
  timeoutMs?: number,
  options?: { sanitizeSse?: boolean; onSseComment?: () => void },
): typeof fetch {
  const requestConfig = resolveModelRequestPolicy(model);
  const dispatcherPolicy = buildProviderRequestDispatcherPolicy(requestConfig);
  const requestTimeoutMs = resolveModelRequestTimeoutMs(model, timeoutMs);
  const rateLimitConfig = getModelProviderRequestTransport(model)?.rateLimit;
  return async (input, init) => {
    let localServiceLease: ProviderLocalServiceLease | undefined;
    const request = input instanceof Request ? new Request(input, init) : undefined;
    const rawUrl =
      request?.url ??
      (input instanceof URL
        ? input.toString()
        : typeof input === "string"
          ? input
          : (() => {
              throw new Error("Unsupported fetch input for transport-aware model request");
            })());
    const rawHeaders = request?.headers ?? init?.headers;
    const swappedEgress = swapSecretSentinelsForEgress({
      url: rawUrl,
      headers: rawHeaders,
    });
    const url = swappedEgress.url;
    const policy = resolveProviderTransportSsrFPolicy({
      baseUrl: model.baseUrl,
      url,
      allowPrivateNetwork: requestConfig.allowPrivateNetwork,
      // Only operator-configured custom/local endpoints get exact-origin trust;
      // known public/native providers keep the default rebinding checks.
      trustConfiguredBaseUrlOrigin: requestConfig.trustConfiguredBaseUrlOrigin,
    });
    const requestInit =
      request &&
      ({
        method: request.method,
        headers: swappedEgress.headers ?? request.headers,
        body: request.body ?? undefined,
        redirect: request.redirect,
        signal: request.signal,
        ...(request.body ? ({ duplex: "half" } as const) : {}),
      } satisfies RequestInit & { duplex?: "half" });
    const baseInit =
      requestInit ??
      (swappedEgress.headers && init ? { ...init, headers: swappedEgress.headers } : init);
    const baseSignal = baseInit?.signal ?? undefined;
    const timeoutSignal =
      requestTimeoutMs === undefined ? undefined : AbortSignal.timeout(requestTimeoutMs);
    const localServiceSignal =
      baseSignal && timeoutSignal
        ? AbortSignal.any([baseSignal, timeoutSignal])
        : (baseSignal ?? timeoutSignal);
    const guardedFetchOptions = {
      url,
      init: baseInit,
      capture: {
        meta: {
          provider: model.provider,
          api: model.api,
          model: model.id,
        },
      },
      dispatcherPolicy,
      dispatcherPool: getProviderTransportDispatcherPool(),
      timeoutMs: requestTimeoutMs,
      ...(baseSignal ? { signal: baseSignal } : {}),
      // Provider transport intentionally keeps the secure default and never
      // replays unsafe request bodies across cross-origin redirects.
      allowCrossOriginUnsafeRedirectReplay: false,
      ...(policy ? { policy } : {}),
    };
    let result: Awaited<ReturnType<typeof fetchWithSsrFGuard>>;
    const fetchStartedAt = Date.now();
    const useEnvProxy = !dispatcherPolicy && shouldUseEnvHttpProxyForUrl(url);
    emitModelTransportDebug(
      log,
      `[model-fetch] start provider=${model.provider} api=${model.api} model=${model.id} ` +
        // Log the pre-swap URL: the swapped URL can carry an injected credential in its path.
        `method=${baseInit?.method ?? "GET"} url=${formatModelTransportDebugUrl(rawUrl)} timeoutMs=${requestTimeoutMs} ` +
        `proxy=${dispatcherPolicy ? "configured" : useEnvProxy ? "env" : "none"} ` +
        `policy=${policy ? "custom" : "default"}`,
    );
    try {
      localServiceLease = await ensureModelProviderLocalService(
        model,
        rawHeaders,
        localServiceSignal,
      );
      // Admission is measured after local-service readiness so a slow startup
      // cannot collapse separately paced requests into one dispatch burst.
      let rateLimitResponse: Response | undefined;
      if (rateLimitConfig) {
        rateLimitResponse = await waitForProviderRequestRateLimit(
          model,
          rateLimitConfig,
          localServiceSignal,
        );
      }
      if (rateLimitResponse) {
        localServiceLease?.release();
        localServiceLease = undefined;
        result = {
          response: rateLimitResponse,
          finalUrl: url,
          release: async () => undefined,
        };
      } else {
        result = await fetchWithSsrFGuard(
          useEnvProxy
            ? withTrustedEnvProxyGuardedFetchMode(guardedFetchOptions)
            : guardedFetchOptions,
        );
      }
    } catch (error) {
      const remediatedError = withModelProviderNetworkRemediation(error, {
        baseUrl: model.baseUrl,
        providerId: model.provider,
        url,
      });
      emitModelTransportError(
        log,
        "model-fetch",
        `provider=${model.provider} api=${model.api} model=${model.id} ` +
          `elapsedMs=${Date.now() - fetchStartedAt} ${summarizeProviderTransportError(remediatedError)}`,
        baseSignal,
      );
      localServiceLease?.release();
      throw remediatedError;
    }
    let response = result.response;
    const elapsedMs = Date.now() - fetchStartedAt;
    const responseMessage =
      `[model-fetch] response provider=${model.provider} api=${model.api} model=${model.id} ` +
      `status=${response.status} elapsedMs=${elapsedMs} ` +
      `dispatcher=${result.dispatcherReused ? "reused" : "new"} ` +
      `contentType=${response.headers.get("content-type") ?? ""}`;
    if (!response.ok || elapsedMs >= SLOW_MODEL_FETCH_MS) {
      log.info(responseMessage);
    } else {
      emitModelTransportDebug(log, responseMessage);
    }
    if (shouldBypassLongSdkRetry(response)) {
      const headers = new Headers(response.headers);
      headers.set("x-should-retry", "false");
      response = new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    }
    const synthesizeJsonAsSse =
      options?.sanitizeSse !== false &&
      !/\btext\/event-stream\b/i.test(response.headers.get("content-type") ?? "") &&
      requestBodyHasStreamTrue(request, baseInit);
    if (synthesizeJsonAsSse) {
      response = await normalizeOpenAISdkStreamContentType({
        response,
        model,
        release: result.release,
        localServiceLease,
      });
    }
    response = buildManagedResponse(
      response,
      result.release,
      result.refreshTimeout,
      localServiceLease,
    );
    return prepareOpenAISdkSseResponse(response, {
      sanitize: options?.sanitizeSse !== false && shouldSanitizeOpenAISdkSseResponse(model),
      synthesizeJsonAsSse,
      onSseComment: options?.onSseComment,
    });
  };
}
