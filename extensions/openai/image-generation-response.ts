import {
  inlineOpenAiCompatibleImageUrls,
  parseOpenAiCompatibleImageResponse,
  resolveInlineImageJsonResponseMaxBytes,
} from "openclaw/plugin-sdk/image-generation";
import {
  assertOkOrThrowHttpError,
  readProviderJsonResponse,
  resolveProviderOperationTimeoutMs,
  type postJsonRequest,
  type ProviderOperationDeadline,
} from "openclaw/plugin-sdk/provider-http";
import { asOptionalRecord, asSafeIntegerInRange } from "openclaw/plugin-sdk/string-coerce-runtime";

function resolveOpenAIImageUsage(payload: unknown) {
  const usage = asOptionalRecord(asOptionalRecord(payload)?.usage);
  if (!usage) {
    return undefined;
  }
  const projectTokenCounts = (record: Record<string, unknown>, fields: readonly string[]) =>
    Object.fromEntries(
      fields.flatMap((field) => {
        const count = asSafeIntegerInRange(record[field], { min: 0 });
        return count === undefined ? [] : [[field, count]];
      }),
    );
  const counts: Record<string, number | Record<string, number>> = projectTokenCounts(usage, [
    "input_tokens",
    "output_tokens",
    "total_tokens",
  ]);
  for (const field of ["input_tokens_details", "output_tokens_details"]) {
    const details = asOptionalRecord(usage[field]);
    if (details) {
      const projected = projectTokenCounts(details, ["text_tokens", "image_tokens"]);
      if (Object.keys(projected).length > 0) {
        counts[field] = projected;
      }
    }
  }
  return Object.keys(counts).length > 0 ? counts : undefined;
}

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
) {
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
  return { images, usage: resolveOpenAIImageUsage(payload) };
}
