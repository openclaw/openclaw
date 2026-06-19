// Voice Call provider HTTP clients share bounded response body readers.

const PROVIDER_JSON_RESPONSE_MAX_BYTES = 1 * 1024 * 1024;
const PROVIDER_ERROR_RESPONSE_MAX_BYTES = 8 * 1024;
const TRUNCATED_SUFFIX = "... [truncated]";

type ReadProviderResponseTextParams = {
  response: Response;
  maxBytes: number;
  truncateOnLimit?: boolean;
};

export async function cancelProviderResponseBody(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined);
}

function appendTruncatedSuffix(text: string): string {
  return `${text.trimEnd()}${TRUNCATED_SUFFIX}`;
}

async function readProviderResponseTextWithLimit(
  params: ReadProviderResponseTextParams,
): Promise<string> {
  if (!params.response.body) {
    return "";
  }

  const reader = params.response.body.getReader();
  const decoder = new TextDecoder();
  let totalBytes = 0;
  let text = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        return text + decoder.decode();
      }
      if (!value?.byteLength) {
        continue;
      }

      const remainingBytes = params.maxBytes - totalBytes;
      if (value.byteLength > remainingBytes) {
        if (params.truncateOnLimit) {
          const clipped = remainingBytes > 0 ? value.slice(0, remainingBytes) : undefined;
          if (clipped) {
            text += decoder.decode(clipped, { stream: true });
          }
          await reader.cancel().catch(() => undefined);
          return appendTruncatedSuffix(text + decoder.decode());
        }
        await reader.cancel().catch(() => undefined);
        throw new Error(
          `provider response body too large: ${totalBytes + value.byteLength} bytes ` +
            `(limit: ${params.maxBytes} bytes)`,
        );
      }

      text += decoder.decode(value, { stream: true });
      totalBytes += value.byteLength;
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {}
  }
}

export async function readProviderJsonResponseText(response: Response): Promise<string> {
  return await readProviderResponseTextWithLimit({
    response,
    maxBytes: PROVIDER_JSON_RESPONSE_MAX_BYTES,
  });
}

export async function readProviderErrorResponseSnippet(response: Response): Promise<string> {
  return await readProviderResponseTextWithLimit({
    response,
    maxBytes: PROVIDER_ERROR_RESPONSE_MAX_BYTES,
    truncateOnLimit: true,
  });
}
