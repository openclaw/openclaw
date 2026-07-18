import { extensionForMime } from "openclaw/plugin-sdk/media-mime";
import {
  assertOkOrThrowHttpError,
  executeProviderOperationWithRetry,
  fetchWithTimeoutGuarded,
  resolveProviderRequestTimeoutMs,
  type ProviderOperationTimeoutMs,
} from "openclaw/plugin-sdk/provider-http";
import { readResponseWithLimit } from "openclaw/plugin-sdk/response-limit-runtime";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { GeneratedVideoAsset } from "openclaw/plugin-sdk/video-generation";

export type XaiVideoRequestPolicy = {
  allowPrivateNetwork: boolean;
  dispatcherPolicy?: NonNullable<Parameters<typeof fetchWithTimeoutGuarded>[4]>["dispatcherPolicy"];
};

export async function fetchXaiVideoResponse(
  params: {
    url: string;
    init: RequestInit;
    stage: "poll" | "download";
    requestFailedMessage: string;
    auditContext: string;
    timeoutMs?: ProviderOperationTimeoutMs;
    defaultTimeoutMs: number;
    fetchFn: typeof fetch;
  } & XaiVideoRequestPolicy,
) {
  return await executeProviderOperationWithRetry({
    provider: "xai",
    stage: params.stage,
    operation: async () => {
      const result = await fetchWithTimeoutGuarded(
        params.url,
        params.init,
        resolveProviderRequestTimeoutMs({
          timeoutMs: params.timeoutMs,
          defaultTimeoutMs: params.defaultTimeoutMs,
        }),
        params.fetchFn,
        {
          ...(params.allowPrivateNetwork ? { ssrfPolicy: { allowPrivateNetwork: true } } : {}),
          ...(params.dispatcherPolicy ? { dispatcherPolicy: params.dispatcherPolicy } : {}),
          auditContext: params.auditContext,
        },
      );
      try {
        await assertOkOrThrowHttpError(result.response, params.requestFailedMessage);
        return result;
      } catch (error) {
        await result.release();
        throw error;
      }
    },
  });
}

export async function downloadXaiVideo(
  params: {
    url: string;
    timeoutMs?: ProviderOperationTimeoutMs;
    defaultTimeoutMs: number;
    fetchFn: typeof fetch;
    maxBytes: number;
  } & XaiVideoRequestPolicy,
): Promise<GeneratedVideoAsset> {
  const { response, release } = await fetchXaiVideoResponse({
    url: params.url,
    stage: "download",
    requestFailedMessage: "xAI generated video download failed",
    auditContext: "xai-video-download",
    init: { method: "GET" },
    timeoutMs: params.timeoutMs,
    defaultTimeoutMs: params.defaultTimeoutMs,
    allowPrivateNetwork: params.allowPrivateNetwork,
    dispatcherPolicy: params.dispatcherPolicy,
    fetchFn: params.fetchFn,
  });
  try {
    const mimeType = normalizeOptionalString(response.headers.get("content-type")) ?? "video/mp4";
    const buffer = await readResponseWithLimit(response, params.maxBytes, {
      timeoutMs: params.timeoutMs ?? params.defaultTimeoutMs,
      onTimeout: ({ timeoutMs }) =>
        new Error(`xAI generated video download timed out after ${timeoutMs}ms`),
      onOverflow: ({ maxBytes }) =>
        new Error(`xAI generated video download exceeds ${maxBytes} bytes`),
    });
    return {
      buffer,
      mimeType,
      fileName: `video-1.${extensionForMime(mimeType)?.slice(1) ?? "mp4"}`,
    };
  } finally {
    await release();
  }
}
