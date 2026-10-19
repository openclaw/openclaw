import { downloadGeneratedVideoAsset } from "openclaw/plugin-sdk/media-generation-runtime";
import { resolvePositiveTimerTimeoutMs } from "openclaw/plugin-sdk/number-runtime";
import {
  assertOkOrThrowHttpError,
  executeProviderOperationWithRetry,
  fetchWithTimeoutGuarded,
  type ProviderOperationTimeoutMs,
} from "openclaw/plugin-sdk/provider-http";
import type { GeneratedVideoAsset } from "openclaw/plugin-sdk/video-generation";
import { XAI_VIDEO_DEFAULT_TIMEOUT_MS } from "./capability-provider-metadata-factory.js";

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
  } & XaiVideoRequestPolicy,
) {
  return await executeProviderOperationWithRetry({
    provider: "xai",
    stage: params.stage,
    operation: async () => {
      const result = await fetchWithTimeoutGuarded(
        params.url,
        params.init,
        resolvePositiveTimerTimeoutMs(
          typeof params.timeoutMs === "function" ? params.timeoutMs() : params.timeoutMs,
          XAI_VIDEO_DEFAULT_TIMEOUT_MS,
        ),
        fetch,
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
    maxBytes: number;
  } & XaiVideoRequestPolicy,
): Promise<GeneratedVideoAsset> {
  return await downloadGeneratedVideoAsset({
    url: params.url,
    timeoutMs: params.timeoutMs ?? XAI_VIDEO_DEFAULT_TIMEOUT_MS,
    defaultTimeoutMs: XAI_VIDEO_DEFAULT_TIMEOUT_MS,
    fetchFn: fetch,
    provider: "xai",
    label: "xAI generated video download",
    requestFailedMessage: "xAI generated video download failed",
    maxBytes: params.maxBytes,
    validateBinaryResponse: true,
    chunkTimeoutMs: 0,
    fetchResponse: async ({ timeoutMs }) =>
      await fetchXaiVideoResponse({
        url: params.url,
        stage: "download",
        requestFailedMessage: "xAI generated video download failed",
        auditContext: "xai-video-download",
        init: { method: "GET" },
        timeoutMs,
        allowPrivateNetwork: params.allowPrivateNetwork,
        dispatcherPolicy: params.dispatcherPolicy,
      }),
  });
}
