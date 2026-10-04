import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { resolveGeneratedMediaMaxBytes } from "openclaw/plugin-sdk/media-generation-runtime";
import { extensionForMime, type MediaKind } from "openclaw/plugin-sdk/media-mime";
import { resolveApiKeyForProvider } from "openclaw/plugin-sdk/provider-auth-runtime";
import {
  assertOkOrThrowHttpError,
  createProviderOperationDeadline,
  createProviderOperationTimeoutError,
  createProviderOperationTimeoutResolver,
  fetchWithTimeoutGuarded,
  pollProviderOperationJson,
  postJsonRequest,
  readProviderBinaryResponse,
  readProviderJsonResponse,
  resolveProviderHttpRequestConfig,
  resolveProviderOperationTimeoutMs,
  sanitizeConfiguredModelProviderRequest,
  type ProviderOperationTimeoutMs,
} from "openclaw/plugin-sdk/provider-http";
import type { SsrFPolicy } from "openclaw/plugin-sdk/ssrf-runtime";
import {
  asOptionalRecord,
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { DEFAULT_VYDRA_BASE_URL, normalizeVydraBaseUrl } from "./defaults.js";

const DEFAULT_HTTP_TIMEOUT_MS = 120_000;
const POLL_INTERVAL_MS = 2_500;
const MAX_POLL_ATTEMPTS = 120;
type VydraAuthStore = Parameters<typeof resolveApiKeyForProvider>[0]["store"];

type VydraRequestPolicy = Pick<
  ReturnType<typeof resolveProviderHttpRequestConfig>,
  "allowPrivateNetwork" | "dispatcherPolicy" | "headers"
> & {
  headerOrigin: string;
  ssrfPolicy?: SsrFPolicy;
};

type VydraMediaKind = Extract<MediaKind, "audio" | "image" | "video">;

function addUrlValue(value: unknown, urls: Set<string>): void {
  const normalized = normalizeOptionalString(value);
  if (normalized !== undefined) {
    if (/^https?:\/\//iu.test(normalized)) {
      urls.add(normalized);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      addUrlValue(entry, urls);
    }
  }
}

function resolveVydraResponseJobId(payload: unknown): string | undefined {
  const object = asOptionalRecord(payload);
  return normalizeOptionalString(object?.jobId) ?? normalizeOptionalString(object?.id);
}

function resolveVydraResponseStatus(payload: unknown): string | undefined {
  return normalizeOptionalLowercaseString(asOptionalRecord(payload)?.status);
}

function resolveVydraErrorMessage(payload: unknown): string | undefined {
  const object = asOptionalRecord(payload);
  const error = object?.error;
  if (typeof error === "string" && error.trim()) {
    return error.trim();
  }
  const errorObject = asOptionalRecord(error);
  return (
    normalizeOptionalString(errorObject?.message) ??
    normalizeOptionalString(errorObject?.detail) ??
    normalizeOptionalString(object?.message)
  );
}

export function extractVydraResultUrls(payload: unknown, kind: VydraMediaKind): string[] {
  const urls = new Set<string>();
  const urlKeys = [
    `${kind}Url`,
    `${kind}Urls`,
    "resultUrl",
    "resultUrls",
    "outputUrl",
    "outputUrls",
    "url",
    "urls",
  ];
  const recurseKeys = ["output", "outputs", "result", "results", "data", "asset", "assets"];

  const visit = (value: unknown, depth = 0) => {
    if (depth > 5) {
      return;
    }
    if (Array.isArray(value)) {
      for (const entry of value) {
        visit(entry, depth + 1);
      }
      return;
    }
    const object = asOptionalRecord(value);
    if (!object) {
      return;
    }
    for (const key of urlKeys) {
      addUrlValue(object[key], urls);
    }
    for (const key of recurseKeys) {
      if (key in object) {
        visit(object[key], depth + 1);
      }
    }
  };

  visit(payload);
  return [...urls];
}

export async function downloadVydraAsset(params: {
  url: string;
  kind: VydraMediaKind;
  timeoutMs?: ProviderOperationTimeoutMs;
  fetchFn: typeof fetch;
  maxBytes: number;
  requestPolicy: VydraRequestPolicy;
}): Promise<{ buffer: Buffer; mimeType: string; fileName: string }> {
  const requestedTimeoutMs =
    typeof params.timeoutMs === "function" ? params.timeoutMs() : params.timeoutMs;
  const timeoutMs =
    typeof requestedTimeoutMs === "number" &&
    Number.isFinite(requestedTimeoutMs) &&
    requestedTimeoutMs > 0
      ? requestedTimeoutMs
      : DEFAULT_HTTP_TIMEOUT_MS;
  const deadline = createProviderOperationDeadline({
    timeoutMs,
    label: `Vydra ${params.kind} download`,
  });
  const resolveTimeoutMs = createProviderOperationTimeoutResolver({
    deadline,
    defaultTimeoutMs: timeoutMs,
  });
  const policy = params.requestPolicy;
  // Never send provider credentials to cross-origin result URLs.
  const headers =
    URL.parse(params.url)?.origin === policy.headerOrigin ? policy.headers : undefined;
  const ssrfPolicy = policy.allowPrivateNetwork
    ? { ...policy.ssrfPolicy, allowPrivateNetwork: true }
    : policy.ssrfPolicy;
  const result = await fetchWithTimeoutGuarded(
    params.url,
    {
      method: "GET",
      ...(headers ? { headers } : {}),
    },
    resolveTimeoutMs(),
    params.fetchFn,
    {
      ...(ssrfPolicy ? { ssrfPolicy } : {}),
      ...(policy.dispatcherPolicy ? { dispatcherPolicy: policy.dispatcherPolicy } : {}),
      auditContext: "vydra-media-download",
    },
  );
  try {
    await assertOkOrThrowHttpError(result.response, `Vydra ${params.kind} download failed`, {
      bodyTimeoutMs: resolveTimeoutMs,
      onBodyTimeout: () => createProviderOperationTimeoutError(deadline),
    });
    const mimeType =
      result.response.headers.get("content-type")?.trim() ||
      (params.kind === "image"
        ? "image/png"
        : params.kind === "audio"
          ? "audio/mpeg"
          : "video/mp4");
    const buffer = await readProviderBinaryResponse(result.response, deadline.label, params.kind, {
      maxBytes: params.maxBytes,
      chunkTimeoutMs: 0,
      timeoutMs: resolveTimeoutMs,
      onTimeout: () => createProviderOperationTimeoutError(deadline),
      onOverflow: ({ maxBytes }) => new Error(`${deadline.label} exceeds ${maxBytes} bytes`),
    });
    const extension =
      extensionForMime(mimeType)?.slice(1) ??
      (params.kind === "image" ? "png" : params.kind === "audio" ? "mp3" : "mp4");
    return {
      buffer,
      mimeType,
      fileName: `${params.kind}-1.${extension}`,
    };
  } catch (error) {
    // The request timer can fire before wall-clock time reaches the operation deadline.
    if (error instanceof Error && error.name === "TimeoutError") {
      throw createProviderOperationTimeoutError(deadline);
    }
    throw error;
  } finally {
    await result.release();
  }
}

export async function runVydraGeneration(params: {
  cfg: OpenClawConfig;
  agentDir?: string;
  authStore?: VydraAuthStore;
  body: unknown;
  deadlineTimeoutMs?: number;
  kind: Extract<VydraMediaKind, "image" | "video">;
  model: string;
  ssrfPolicy?: SsrFPolicy;
  timeoutMs?: number;
}): Promise<{
  asset: { buffer: Buffer; mimeType: string; fileName: string };
  jobId?: string;
  resultUrl: string;
  status: string;
}> {
  const auth = await resolveApiKeyForProvider({
    provider: "vydra",
    cfg: params.cfg,
    agentDir: params.agentDir,
    store: params.authStore,
  });
  if (!auth.apiKey) {
    throw new Error("Vydra API key missing");
  }
  const fetchFn = fetch;
  const providerConfig = params.cfg.models?.providers?.vydra;
  const { baseUrl, ...http } = resolveProviderHttpRequestConfig({
    baseUrl: normalizeVydraBaseUrl(providerConfig?.baseUrl),
    defaultBaseUrl: DEFAULT_VYDRA_BASE_URL,
    defaultHeaders: {
      Authorization: `Bearer ${auth.apiKey}`,
      "Content-Type": "application/json",
    },
    provider: "vydra",
    capability: params.kind,
    transport: "http",
    request: sanitizeConfiguredModelProviderRequest(providerConfig?.request),
  });
  const requestPolicy: VydraRequestPolicy = {
    ...http,
    headerOrigin: new URL(baseUrl).origin,
    ...(params.ssrfPolicy ? { ssrfPolicy: params.ssrfPolicy } : {}),
  };
  const operationLabel = `Vydra ${params.kind} generation`;
  const deadline =
    params.deadlineTimeoutMs === undefined
      ? undefined
      : createProviderOperationDeadline({
          timeoutMs: params.deadlineTimeoutMs,
          label: operationLabel,
        });
  const timeoutMs = deadline
    ? resolveProviderOperationTimeoutMs({
        deadline,
        defaultTimeoutMs: DEFAULT_HTTP_TIMEOUT_MS,
      })
    : params.timeoutMs;
  const { response, release } = await postJsonRequest({
    url: `${baseUrl}/models/${params.model}`,
    headers: requestPolicy.headers,
    body: params.body,
    timeoutMs,
    fetchFn,
    allowPrivateNetwork: requestPolicy.allowPrivateNetwork,
    ...(requestPolicy.ssrfPolicy ? { ssrfPolicy: requestPolicy.ssrfPolicy } : {}),
    dispatcherPolicy: requestPolicy.dispatcherPolicy,
  });

  try {
    await assertOkOrThrowHttpError(response, `${operationLabel} failed`);
    const submitted = await readProviderJsonResponse(
      response,
      params.kind === "image" ? "vydra.image-generation" : operationLabel,
    );
    const isComplete = (payload: unknown) =>
      resolveVydraResponseStatus(payload) === "completed" ||
      extractVydraResultUrls(payload, params.kind).length > 0;
    let completedPayload = submitted;
    if (!isComplete(submitted)) {
      const jobId = resolveVydraResponseJobId(submitted);
      if (!jobId) {
        throw new Error(
          resolveVydraErrorMessage(submitted) ?? `${operationLabel} response missing job id`,
        );
      }
      completedPayload = await pollProviderOperationJson<unknown>({
        url: `${baseUrl}/jobs/${jobId}`,
        headers: requestPolicy.headers,
        deadline:
          deadline ??
          createProviderOperationDeadline({
            timeoutMs: params.timeoutMs,
            label: `Vydra job ${jobId}`,
          }),
        defaultTimeoutMs: DEFAULT_HTTP_TIMEOUT_MS,
        fetchFn,
        maxAttempts: MAX_POLL_ATTEMPTS,
        pollIntervalMs: POLL_INTERVAL_MS,
        requestFailedMessage: "Vydra job status request failed",
        timeoutMessage: `Vydra job ${jobId} did not finish in time`,
        allowPrivateNetwork: requestPolicy.allowPrivateNetwork,
        ssrfPolicy: requestPolicy.ssrfPolicy,
        dispatcherPolicy: requestPolicy.dispatcherPolicy,
        auditContext: "vydra-job-status",
        isComplete,
        getFailureMessage: (payload) => {
          const status = resolveVydraResponseStatus(payload);
          return status === "failed" || status === "error" || status === "cancelled"
            ? (resolveVydraErrorMessage(payload) ?? `Vydra job ${jobId} failed`)
            : undefined;
        },
      });
    }
    const resultUrl = extractVydraResultUrls(completedPayload, params.kind)[0];
    if (!resultUrl) {
      throw new Error(`${operationLabel} completed without a ${params.kind} URL`);
    }
    const asset = await downloadVydraAsset({
      url: resultUrl,
      kind: params.kind,
      timeoutMs: deadline
        ? createProviderOperationTimeoutResolver({
            deadline,
            defaultTimeoutMs: DEFAULT_HTTP_TIMEOUT_MS,
          })
        : params.timeoutMs,
      fetchFn,
      maxBytes: resolveGeneratedMediaMaxBytes(params.cfg, params.kind),
      requestPolicy,
    });
    const jobId =
      resolveVydraResponseJobId(completedPayload) ?? resolveVydraResponseJobId(submitted);
    return {
      asset,
      ...(jobId ? { jobId } : {}),
      resultUrl,
      status: resolveVydraResponseStatus(completedPayload) ?? "completed",
    };
  } finally {
    await release();
  }
}
