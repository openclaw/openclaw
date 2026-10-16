import {
  inlineOpenAiCompatibleImageUrls,
  parseOpenAiCompatibleImageResponse,
  resolveInlineImageJsonResponseMaxBytes,
  type GeneratedImageAsset,
} from "openclaw/plugin-sdk/image-generation";
import {
  assertOkOrThrowHttpError,
  readProviderJsonResponse,
  resolveProviderOperationTimeoutMs,
  type postJsonRequest,
  type ProviderOperationDeadline,
} from "openclaw/plugin-sdk/provider-http";

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
  const payload = await readProviderJsonResponse<unknown>(response, "openai.image-generation", {
    maxBytes: resolveInlineImageJsonResponseMaxBytes(params.maxImages, params.maxBytes),
    timeoutMs,
  });
  const images = parseOpenAiCompatibleImageResponse(
    await inlineOpenAiCompatibleImageUrls(payload, {
      providerId: "openai",
      label: "OpenAI",
      operation: params.operation,
      providerUrl: params.providerUrl,
      maxDownloads: params.maxDownloads,
      maxBytes: params.maxBytes,
      timeoutMs,
      allowPrivateNetwork: params.allowPrivateNetwork,
      ssrfPolicy: params.ssrfPolicy,
      dispatcherPolicy: params.dispatcherPolicy,
    }),
    {
      defaultMimeType: params.defaultMimeType,
      malformedResponseError: `${params.operation} response malformed`,
    },
  );
  if (images.length === 0) {
    throw new Error(`${params.operation} response missing image data`);
  }
  return images;
}
