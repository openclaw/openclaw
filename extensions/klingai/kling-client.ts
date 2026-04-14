import {
  assertOkOrThrowHttpError,
  fetchWithTimeout,
  postJsonRequest,
  resolveProviderHttpRequestConfig,
} from "openclaw/plugin-sdk/provider-http";
import { normalizeOptionalString } from "openclaw/plugin-sdk/text-runtime";

const DEFAULT_KLING_BASE_URL = "https://api-singapore.klingai.com";
const DEFAULT_HTTP_TIMEOUT_MS = 30_000;
const DEFAULT_TASK_TIMEOUT_MS = 600_000;
const DEFAULT_POLL_INTERVAL_MS = 5_000;
const KLINGAI_EXTENSION_USER_AGENT = "openclaw-extensions-klingai/2026.4.8";

type KlingApiEnvelope<TData> = {
  code?: number;
  message?: string;
  msg?: string;
  data?: TData;
};

type KlingSubmitData = {
  task_id?: string | number;
};

type KlingTaskResultImage = {
  url?: string;
};

type KlingTaskResultVideo = {
  url?: string;
  watermark_url?: string;
};

type KlingTaskResult = {
  images?: KlingTaskResultImage[];
  series_images?: KlingTaskResultImage[];
  videos?: KlingTaskResultVideo[];
  url?: string;
  video_url?: string;
};

export type KlingTaskData = {
  task_id?: string | number;
  task_status?: string;
  task_status_msg?: string;
  task_result?: KlingTaskResult;
};

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/u, "");
}

function isKlingApiSuccess(code: number | undefined): boolean {
  return code === 0 || code === 200;
}

function getKlingErrorMessage(payload: KlingApiEnvelope<unknown>, fallback: string): string {
  return normalizeOptionalString(payload.message) || normalizeOptionalString(payload.msg) || fallback;
}

function parseKlingEnvelope<TData>(
  payload: unknown,
  context: string,
): KlingApiEnvelope<TData> & { data: TData } {
  if (!payload || typeof payload !== "object") {
    throw new Error(`${context}: invalid KlingAI response payload`);
  }
  const envelope = payload as KlingApiEnvelope<TData>;
  if (!isKlingApiSuccess(envelope.code)) {
    throw new Error(
      `${context}: ${getKlingErrorMessage(envelope, "KlingAI API returned an error")} (${String(
        envelope.code,
      )})`,
    );
  }
  if (envelope.data === undefined) {
    throw new Error(`${context}: response missing data`);
  }
  return envelope as KlingApiEnvelope<TData> & { data: TData };
}

function asTaskId(value: string | number | undefined): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return normalizeOptionalString(value);
}

export function toDataUrl(buffer: Buffer, mimeType: string): string {
  return `data:${mimeType};base64,${buffer.toString("base64")}`;
}

export function resolveKlingHttpConfig(params: {
  apiKey: string;
  configuredBaseUrl: string | undefined;
  capability: "image" | "video";
}) {
  return resolveProviderHttpRequestConfig({
    baseUrl: normalizeOptionalString(params.configuredBaseUrl),
    defaultBaseUrl: DEFAULT_KLING_BASE_URL,
    allowPrivateNetwork: false,
    defaultHeaders: {
      Authorization: `Bearer ${params.apiKey}`,
      "Content-Type": "application/json",
      "User-Agent": KLINGAI_EXTENSION_USER_AGENT,
    },
    provider: "klingai",
    capability: params.capability,
    transport: "http",
  });
}

export async function submitKlingTask(params: {
  endpointPath: string;
  body: Record<string, unknown>;
  headers: Headers;
  timeoutMs?: number;
  fetchFn: typeof fetch;
  allowPrivateNetwork: boolean;
  dispatcherPolicy: ReturnType<typeof resolveProviderHttpRequestConfig>["dispatcherPolicy"];
  baseUrl: string;
  context: string;
}): Promise<string> {
  const endpointUrl = `${normalizeBaseUrl(params.baseUrl)}${params.endpointPath}`;
  const { response, release } = await postJsonRequest({
    url: endpointUrl,
    headers: params.headers,
    body: params.body,
    timeoutMs: params.timeoutMs,
    fetchFn: params.fetchFn,
    allowPrivateNetwork: params.allowPrivateNetwork,
    dispatcherPolicy: params.dispatcherPolicy,
  });
  try {
    await assertOkOrThrowHttpError(response, `${params.context} failed`);
    const payload = parseKlingEnvelope<KlingSubmitData>(
      await response.json(),
      `${params.context} failed`,
    );
    const taskId = asTaskId(payload.data.task_id);
    if (!taskId) {
      throw new Error(`${params.context} failed: response missing task_id`);
    }
    return taskId;
  } finally {
    await release();
  }
}

async function queryKlingTask(params: {
  queryPath: string;
  taskId: string;
  headers: Headers;
  timeoutMs?: number;
  fetchFn: typeof fetch;
  context: string;
}): Promise<KlingTaskData> {
  const queryUrl = `${normalizeBaseUrl(params.queryPath)}/${encodeURIComponent(params.taskId)}`;
  const response = await fetchWithTimeout(
    queryUrl,
    {
      method: "GET",
      headers: params.headers,
    },
    params.timeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS,
    params.fetchFn,
  );
  await assertOkOrThrowHttpError(response, `${params.context} status query failed`);
  const payload = parseKlingEnvelope<KlingTaskData>(
    await response.json(),
    `${params.context} status query failed`,
  );
  return payload.data;
}

export async function pollKlingTaskUntilComplete(params: {
  queryPath: string;
  taskId: string;
  headers: Headers;
  timeoutMs?: number;
  fetchFn: typeof fetch;
  context: string;
  pollIntervalMs?: number;
}): Promise<KlingTaskData> {
  const timeoutMs = params.timeoutMs ?? DEFAULT_TASK_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  const pollIntervalMs = params.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  let lastStatus = "unknown";
  while (Date.now() < deadline) {
    const data = await queryKlingTask({
      queryPath: params.queryPath,
      taskId: params.taskId,
      headers: params.headers,
      timeoutMs: DEFAULT_HTTP_TIMEOUT_MS,
      fetchFn: params.fetchFn,
      context: params.context,
    });
    const status = normalizeOptionalString(data.task_status)?.toLowerCase();
    if (status) {
      lastStatus = status;
    }
    if (status === "succeed") {
      return data;
    }
    if (status === "failed") {
      throw new Error(
        `${params.context} failed: ${normalizeOptionalString(data.task_status_msg) || "task failed"}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
  throw new Error(`${params.context} timed out while waiting for task completion (${lastStatus})`);
}

export async function downloadKlingBinaryAsset(params: {
  url: string;
  timeoutMs?: number;
  fetchFn: typeof fetch;
  context: string;
}): Promise<{ buffer: Buffer; mimeType: string }> {
  const response = await fetchWithTimeout(
    params.url,
    { method: "GET" },
    params.timeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS,
    params.fetchFn,
  );
  await assertOkOrThrowHttpError(response, `${params.context} download failed`);
  const mimeType = normalizeOptionalString(response.headers.get("content-type")) || "application/octet-stream";
  const arrayBuffer = await response.arrayBuffer();
  return {
    buffer: Buffer.from(arrayBuffer),
    mimeType,
  };
}

export function listKlingImageUrls(taskData: KlingTaskData): string[] {
  const urls = new Set<string>();
  const imageGroups = [
    ...(taskData.task_result?.images ?? []),
    ...(taskData.task_result?.series_images ?? []),
  ];
  for (const image of imageGroups) {
    const url = normalizeOptionalString(image.url);
    if (url) {
      urls.add(url);
    }
  }
  const fallbackUrl = normalizeOptionalString(taskData.task_result?.url);
  if (fallbackUrl) {
    urls.add(fallbackUrl);
  }
  return [...urls];
}

export function resolveKlingVideoUrl(taskData: KlingTaskData): string | undefined {
  const direct = normalizeOptionalString(taskData.task_result?.videos?.[0]?.url);
  if (direct) {
    return direct;
  }
  return (
    normalizeOptionalString(taskData.task_result?.video_url) ||
    normalizeOptionalString(taskData.task_result?.url)
  );
}
