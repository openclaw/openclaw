import { emitModelTransportDebug, formatModelTransportDebugUrl } from "@openclaw/ai/diagnostics";
/**
 * Guarded provider fetch transport utilities.
 *
 * Applies request timeouts, proxy/TLS overrides, SSRF policy, local-service leases, retry hints, and SSE normalization.
 */
import { parseRetryAfterHeadersSeconds as parseRetryAfterSeconds } from "@openclaw/ai/internal/retry-after";
import {
  isCloudMetadataIpAddress,
  isLinkLocalIpAddress,
  isRfc8215LocalUseNat64Ipv6Address,
  parseCanonicalIpAddress,
} from "@openclaw/net-policy/ip";
import {
  asFiniteNumberInRange,
  clampTimerTimeoutMs,
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
import {
  containsSecretSentinel,
  resolveSecretSentinel,
  SECRET_SENTINEL_PATTERN,
  swapSecretSentinelsInText,
} from "../secrets/sentinel.js";
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
} from "./provider-request-config.js";
import { getProviderTransportDispatcherPool } from "./provider-transport-dispatcher-pool.js";
import {
  cancelReaderBestEffort,
  findSseEventBoundary,
  hasReadableSseData,
  sanitizeOpenAISdkSseResponse,
} from "./provider-transport-sse.js";

const DEFAULT_MAX_SDK_RETRY_WAIT_SECONDS = 60;
const SLOW_MODEL_FETCH_MS = 1_000;
const OPENAI_SDK_STREAM_CONTENT_SNIFF_BYTES = 2 * 1024;
const log = createSubsystemLogger("provider-transport-fetch");

const BLOCKED_EXACT_ORIGIN_TRUST_HOSTNAME_LABELS = new Set(["instance-data"]);
const PLAIN_DECIMAL_NUMBER_RE = /^\d+(?:\.\d+)?$/;

function shouldSanitizeOpenAISdkSseResponse(model: Model): boolean {
  if (model.provider !== "openai") {
    return true;
  }
  try {
    return new URL(model.baseUrl).hostname.toLowerCase() !== "api.openai.com";
  } catch {
    return true;
  }
}

function isJsonContentType(contentType: string): boolean {
  return /\bapplication\/json\b/i.test(contentType) || /\+json\b/i.test(contentType);
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
  const headers = new Headers(response.headers);
  headers.set("content-type", contentType);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
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
  if (isJsonContentType(contentType)) {
    // Some OpenAI-compatible gateways stream real SSE (`data: {...}`) but mislabel
    // the response as JSON. Without relabeling, the JSON-wrap fallback below would
    // re-prefix each frame as `data: data: {...}`, breaking JSON.parse in the SDK.
    const kind = await classifyOpenAISdkStreamBody(params.response).catch(() => "unknown" as const);
    if (kind === "sse") {
      return withOpenAISdkStreamContentType(params.response, "text/event-stream; charset=utf-8");
    }
    return params.response;
  }
  if (!contentType.trim()) {
    // ChatGPT Codex can stream valid SSE with no content-type header. Sniff a
    // clone so the SDK still receives the original body once we normalize it.
    const kind = await classifyOpenAISdkStreamBody(params.response).catch(() => "unknown" as const);
    if (kind === "sse") {
      return withOpenAISdkStreamContentType(params.response, "text/event-stream; charset=utf-8");
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

function requestBodyHasStreamTrue(
  request: Request | undefined,
  init: RequestInit | undefined,
): boolean {
  const method = request?.method ?? init?.method;
  if (method && method.toUpperCase() !== "POST") {
    return false;
  }
  const headers = request?.headers ?? new Headers(init?.headers);
  const contentType = headers.get("content-type") ?? "";
  if (contentType && !/\bapplication\/json\b/i.test(contentType)) {
    return false;
  }

  let text: string | undefined;
  if (typeof init?.body === "string") {
    text = init.body;
  }
  if (!text) {
    return false;
  }
  try {
    return (JSON.parse(text) as { stream?: unknown }).stream === true;
  } catch {
    return false;
  }
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

  const seconds = asFiniteNumberInRange(parseStrictFiniteNumber(raw), {
    min: 0,
    minExclusive: true,
    max: Number.MAX_SAFE_INTEGER,
  });
  if (seconds !== undefined) {
    return seconds;
  }

  return DEFAULT_MAX_SDK_RETRY_WAIT_SECONDS;
}

function shouldBypassLongSdkRetry(response: Response): boolean {
  const maxWaitSeconds = resolveMaxSdkRetryWaitSeconds();
  if (maxWaitSeconds === undefined) {
    return false;
  }

  const status = response.status;
  const stainlessRetryable = status === 408 || status === 409 || status === 429 || status >= 500;
  if (!stainlessRetryable) {
    return false;
  }

  const retryAfterSeconds = parseRetryAfterSeconds(response.headers);
  if (retryAfterSeconds !== undefined) {
    return retryAfterSeconds > maxWaitSeconds;
  }

  return status === 429;
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
  return new Response(wrappedBody, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

function resolveModelRequestPolicy(model: Model) {
  const debugProxy = resolveDebugProxySettings();
  let explicitDebugProxyUrl: string | undefined;
  if (debugProxy.enabled && debugProxy.proxyUrl) {
    try {
      if (new URL(model.baseUrl).protocol === "https:") {
        explicitDebugProxyUrl = debugProxy.proxyUrl;
      }
    } catch {
      // Non-URL provider base URLs cannot use the debug proxy override safely.
    }
  }
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
  if (timeoutMs !== undefined) {
    return typeof timeoutMs === "number" && Number.isFinite(timeoutMs) && timeoutMs > 0
      ? clampTimerTimeoutMs(timeoutMs)
      : undefined;
  }
  const modelTimeoutMs = (model as { requestTimeoutMs?: unknown }).requestTimeoutMs;
  return typeof modelTimeoutMs === "number" && Number.isFinite(modelTimeoutMs) && modelTimeoutMs > 0
    ? clampTimerTimeoutMs(modelTimeoutMs)
    : undefined;
}

function buildModelRequestSignal(
  baseSignal: AbortSignal | undefined,
  timeoutMs: number | undefined,
): AbortSignal | undefined {
  if (timeoutMs === undefined) {
    return baseSignal;
  }
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  if (!baseSignal) {
    return timeoutSignal;
  }
  return AbortSignal.any([baseSignal, timeoutSignal]);
}

function resolveHttpOrigin(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) {
    return undefined;
  }
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return undefined;
    }
    parsed.hostname = parsed.hostname.replace(/\.+$/, "");
    return parsed.origin.toLowerCase();
  } catch {
    return undefined;
  }
}

function normalizeProviderOriginHostname(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) {
    return undefined;
  }
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return undefined;
    }
    const normalized = parsed.hostname.trim().toLowerCase().replace(/\.+$/, "");
    return normalized || undefined;
  } catch {
    return undefined;
  }
}

function canImplicitlyTrustConfiguredBaseUrlOrigin(value: unknown): value is string {
  const hostname = normalizeProviderOriginHostname(value);
  if (!hostname) {
    return false;
  }
  const labels = hostname.split(".").filter(Boolean);
  return (
    !labels.some(
      (label) =>
        label.includes("metadata") || BLOCKED_EXACT_ORIGIN_TRUST_HOSTNAME_LABELS.has(label),
    ) &&
    !isLinkLocalIpAddress(hostname) &&
    !isCloudMetadataIpAddress(hostname) &&
    !isRfc8215LocalUseNat64Ipv6Address(hostname)
  );
}

function canApplyFakeIpHostnamePolicy(value: unknown): value is string {
  const hostname = normalizeProviderOriginHostname(value);
  if (!hostname) {
    return false;
  }
  const labels = hostname.split(".").filter(Boolean);
  return (
    !labels.some(
      (label) =>
        label.includes("metadata") || BLOCKED_EXACT_ORIGIN_TRUST_HOSTNAME_LABELS.has(label),
    ) && !parseCanonicalIpAddress(hostname)
  );
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
  const baseUrlOriginPolicy =
    requestMatchesBaseOrigin &&
    params.trustConfiguredBaseUrlOrigin &&
    canImplicitlyTrustConfiguredBaseUrlOrigin(baseUrl)
      ? ssrfPolicyFromHttpBaseUrlAllowedOrigin(baseUrl)
      : undefined;
  // Fake-IP trust is hostname-scoped and orthogonal to exact-origin private-IP trust.
  // It is for DNS hostnames only and does not allow literal private IPs by itself.
  const fakeIpPolicy =
    requestMatchesBaseOrigin && canApplyFakeIpHostnamePolicy(baseUrl)
      ? ssrfPolicyFromHttpBaseUrlFakeIpHostnameAllowlist(baseUrl)
      : undefined;
  return mergeSsrFPolicies(
    baseUrlOriginPolicy,
    fakeIpPolicy,
    params.allowPrivateNetwork ? { allowPrivateNetwork: true } : undefined,
  );
}

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

function headersContainSecretSentinel(headers: HeadersInit | undefined): boolean {
  if (!headers) {
    return false;
  }
  for (const value of new Headers(headers).values()) {
    if (containsSecretSentinel(value)) {
      return true;
    }
  }
  return false;
}

function swapSecretSentinelsInUrl(url: string): { text: string; unknown: string[] } {
  if (!containsSecretSentinel(url)) {
    return { text: url, unknown: [] };
  }
  const unknown = new Set<string>();
  const text = url.replace(new RegExp(SECRET_SENTINEL_PATTERN.source, "g"), (sentinel) => {
    const value = resolveSecretSentinel(sentinel);
    if (value === undefined) {
      unknown.add(sentinel);
      return sentinel;
    }
    // Sentinels are URL-safe placeholders. Encode the real bytes so query/path structure is stable.
    return encodeURIComponent(value);
  });
  return { text, unknown: [...unknown] };
}

function swapSecretSentinelsForEgress(params: { url: string; headers?: HeadersInit }): {
  url: string;
  headers?: Headers;
} {
  if (!containsSecretSentinel(params.url) && !headersContainSecretSentinel(params.headers)) {
    return { url: params.url };
  }
  const urlSwap = swapSecretSentinelsInUrl(params.url);
  const headers = params.headers ? new Headers(params.headers) : undefined;
  const unknown = new Set(urlSwap.unknown);
  if (headers) {
    for (const [name, value] of headers.entries()) {
      const swapped = swapSecretSentinelsInText(value);
      headers.set(name, swapped.text);
      for (const sentinel of swapped.unknown) {
        unknown.add(sentinel);
      }
    }
  }
  const unresolved = unknown.values().next().value;
  if (unresolved) {
    throw new Error(
      `Secret sentinel ${unresolved} is not registered in this process; refusing to send request`,
    );
  }
  return { url: urlSwap.text, ...(headers ? { headers } : {}) };
}

export function buildGuardedModelFetch(
  model: Model,
  timeoutMs?: number,
  options?: { sanitizeSse?: boolean; onSseComment?: () => void },
): typeof fetch {
  const requestConfig = resolveModelRequestPolicy(model);
  const dispatcherPolicy = buildProviderRequestDispatcherPolicy(requestConfig);
  const requestTimeoutMs = resolveModelRequestTimeoutMs(model, timeoutMs);
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
    const localServiceSignal = buildModelRequestSignal(baseSignal, requestTimeoutMs);
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
      result = await fetchWithSsrFGuard(
        useEnvProxy
          ? withTrustedEnvProxyGuardedFetchMode(guardedFetchOptions)
          : guardedFetchOptions,
      );
    } catch (error) {
      const remediatedError = withModelProviderNetworkRemediation(error, {
        baseUrl: model.baseUrl,
        providerId: model.provider,
        url,
      });
      log.warn(
        `[model-fetch] error provider=${model.provider} api=${model.api} model=${model.id} ` +
          `elapsedMs=${Date.now() - fetchStartedAt} ${summarizeProviderTransportError(remediatedError)}`,
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
    return options?.sanitizeSse === false || !shouldSanitizeOpenAISdkSseResponse(model)
      ? response
      : sanitizeOpenAISdkSseResponse(response, {
          synthesizeJsonAsSse,
          onSseComment: options?.onSseComment,
        });
  };
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
