import {
  parseOpenAiCompatibleImageResponse,
  resolveInlineImageJsonResponseMaxBytes,
  type GeneratedImageAsset,
} from "openclaw/plugin-sdk/image-generation";
import {
  assertOkOrThrowHttpError,
  readProviderBinaryResponse,
  readProviderJsonResponse,
  resolveProviderOperationTimeoutMs,
  type postJsonRequest,
  type ProviderOperationDeadline,
} from "openclaw/plugin-sdk/provider-http";
import {
  fetchWithSsrFGuard,
  mergeSsrFPolicies,
  ssrfPolicyFromPrivateNetworkOptIn,
} from "openclaw/plugin-sdk/ssrf-runtime";
import {
  asOptionalObjectRecord,
  isRecord,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";

type ResponseParams = Pick<
  Parameters<typeof postJsonRequest>[0],
  "allowPrivateNetwork" | "ssrfPolicy" | "dispatcherPolicy"
> & {
  operation: string;
  providerUrl: string;
  defaultMimeType: string;
  maxImages: number;
  maxDownloads: number;
  maxBytes: number;
  timeoutMs: number;
  deadline: ProviderOperationDeadline;
};

export async function readOpenAIImageGenerationResponse(
  response: Response,
  params: ResponseParams,
): Promise<GeneratedImageAsset[]> {
  const timeoutMs = () =>
    resolveProviderOperationTimeoutMs({
      deadline: params.deadline,
      defaultTimeoutMs: params.timeoutMs,
    });
  await assertOkOrThrowHttpError(response, `${params.operation} failed`, {
    bodyTimeoutMs: timeoutMs,
  });
  let payload = await readProviderJsonResponse<unknown>(response, "openai.image-generation", {
    maxBytes: resolveInlineImageJsonResponseMaxBytes(params.maxImages, params.maxBytes),
    timeoutMs,
  });
  if (isRecord(payload) && Array.isArray(payload.data)) {
    const providerOrigin = new URL(params.providerUrl).origin;
    const dispatcherPolicy = params.dispatcherPolicy;
    // Target TLS identity and hostname overrides belong to the provider origin.
    const externalDispatcherPolicy =
      dispatcherPolicy?.mode === "explicit-proxy"
        ? { ...dispatcherPolicy, proxyTls: undefined, pinnedHostname: undefined }
        : dispatcherPolicy
          ? { ...dispatcherPolicy, connect: undefined, pinnedHostname: undefined }
          : undefined;
    const downloadOptions = {
      policy: mergeSsrFPolicies(
        params.ssrfPolicy,
        ssrfPolicyFromPrivateNetworkOptIn(params.allowPrivateNetwork),
      ),
      resolveDispatcherPolicy: (url: URL) =>
        url.origin === providerOrigin ? dispatcherPolicy : externalDispatcherPolicy,
      useEnvProxyForEligibleUrls: true,
      auditContext: "openai-image-download",
    };
    const entries: unknown[] = [];
    let downloads = 0;
    for (const entry of payload.data) {
      const record = asOptionalObjectRecord(entry);
      const url =
        record && !normalizeOptionalString(record.b64_json)
          ? normalizeOptionalString(record.url)
          : undefined;
      if (!record || !url) {
        entries.push(entry);
        continue;
      }
      if (downloads >= params.maxDownloads) {
        throw new Error(`${params.operation} returned too many image URLs`);
      }
      downloads += 1;
      const { response: download, release } = await fetchWithSsrFGuard({
        ...downloadOptions,
        url,
        init: { method: "GET" },
        timeoutMs: timeoutMs(),
        fetchImpl: fetch,
      });
      try {
        await assertOkOrThrowHttpError(download, "OpenAI image download failed", {
          bodyTimeoutMs: timeoutMs,
        });
        const mimeType = download.headers.get("Content-Type")?.split(";")[0]?.trim().toLowerCase();
        if (!mimeType || !/^image\/[a-z0-9.+-]+$/.test(mimeType)) {
          void download.body?.cancel().catch(() => undefined);
          throw new Error("OpenAI image download: expected an image Content-Type");
        }
        const buffer = await readProviderBinaryResponse(
          download,
          "OpenAI image download",
          "image",
          {
            maxBytes: params.maxBytes,
            timeoutMs,
          },
        );
        // Keep downloaded and inline entries on the same asset parser.
        entries.push({ ...record, b64_json: buffer.toString("base64"), mime_type: mimeType });
      } finally {
        await release();
      }
    }
    payload = { ...payload, data: entries };
  }
  const images = parseOpenAiCompatibleImageResponse(payload, {
    defaultMimeType: params.defaultMimeType,
    malformedResponseError: `${params.operation} response malformed`,
  });
  if (images.length === 0) {
    throw new Error(`${params.operation} response missing image data`);
  }
  return images;
}
