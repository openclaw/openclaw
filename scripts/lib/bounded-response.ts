type BoundedResponseTextOptions = {
  createTooLargeError?: (message: string) => Error;
  formatTooLargeMessage?: (label: string, maxBytes: number) => string;
  timeoutPromise?: Promise<never>;
};

const defaultTooLargeMessage = (label: string, maxBytes: number) =>
  `${label} response body exceeded ${maxBytes} bytes`;

const defaultTooLargeError = (message: string) => new Error(`${message}.`);

export async function readBoundedResponseText(
  response: Response,
  label: string,
  maxBytes: number,
  options: BoundedResponseTextOptions = {},
): Promise<string> {
  const formatTooLargeMessage = options.formatTooLargeMessage ?? defaultTooLargeMessage;
  const createTooLargeError = options.createTooLargeError ?? defaultTooLargeError;
  const tooLargeError = () => createTooLargeError(formatTooLargeMessage(label, maxBytes));
  const contentLength = Number(response.headers.get("content-length") ?? "");
  if (Number.isSafeInteger(contentLength) && contentLength > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw tooLargeError();
  }

  if (!response.body) {
    return "";
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let totalBytes = 0;

  try {
    for (;;) {
      const { done, value } = await (options.timeoutPromise
        ? Promise.race([reader.read(), options.timeoutPromise])
        : reader.read());
      if (done) {
        const tail = decoder.decode();
        if (tail) {
          chunks.push(tail);
        }
        break;
      }

      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw tooLargeError();
      }
      chunks.push(decoder.decode(value, { stream: true }));
    }
  } finally {
    reader.releaseLock();
  }

  return chunks.join("");
}
