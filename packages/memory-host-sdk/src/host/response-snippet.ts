import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { readResponseTextPrefix, readResponseWithLimit } from "./openclaw-runtime-network.js";

const DEFAULT_ERROR_BODY_MAX_BYTES = 8 * 1024;
const DEFAULT_ERROR_BODY_MAX_CHARS = 1_000;
const DEFAULT_JSON_BODY_MAX_BYTES = 64 * 1024 * 1024;
const TRUNCATED_SUFFIX = "... [truncated]";

// Bounded response readers for provider/remote HTTP errors and JSON bodies.
type ResponseTextSnippetOptions = {
  maxBytes?: number;
  maxChars?: number;
  signal?: AbortSignal;
};

type ResponseJsonOptions = {
  maxBytes?: number;
  errorPrefix: string;
  signal?: AbortSignal;
};

/** Read a small collapsed text snippet from a response body. */
export async function readMemoryHostResponseTextSnippet(
  res: Response,
  options: ResponseTextSnippetOptions = {},
): Promise<string> {
  const maxBytes = options.maxBytes ?? DEFAULT_ERROR_BODY_MAX_BYTES;
  const maxChars = options.maxChars ?? DEFAULT_ERROR_BODY_MAX_CHARS;
  if (!res.body || typeof res.body.getReader !== "function") {
    return "";
  }
  const prefix = await readResponseTextPrefix(res, maxBytes, { signal: options.signal }).catch(
    (error: unknown) => {
      throw options.signal?.aborted
        ? toAbortError(options.signal, "Response snippet body read aborted")
        : error;
    },
  );
  const collapsed = prefix.text.replace(/\s+/g, " ").trim();
  if (!collapsed) {
    return "";
  }
  if (prefix.truncated || collapsed.length > maxChars) {
    return `${truncateUtf16Safe(collapsed, maxChars)}${TRUNCATED_SUFFIX}`;
  }
  return collapsed;
}

/** Read and parse JSON while enforcing a hard byte limit. */
export async function readResponseJsonWithLimit(
  res: Response,
  options: ResponseJsonOptions,
): Promise<unknown> {
  const maxBytes = options.maxBytes ?? DEFAULT_JSON_BODY_MAX_BYTES;
  const contentLength = parseContentLength(res.headers.get("content-length"), options.errorPrefix);
  if (typeof contentLength === "number" && contentLength > maxBytes) {
    cancelResponseBody(res);
    throw responseTooLarge(options.errorPrefix, contentLength, maxBytes);
  }

  const bytes =
    res.body && typeof res.body.getReader === "function"
      ? await readResponseWithLimit(res, maxBytes, {
          signal: options.signal,
          onOverflow: ({ size }) => responseTooLarge(options.errorPrefix, size, maxBytes),
        }).catch((error: unknown) => {
          throw options.signal?.aborted
            ? toAbortError(options.signal, `${options.errorPrefix}: response body read aborted`)
            : error;
        })
      : new Uint8Array();
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);

  try {
    return JSON.parse(text);
  } catch (cause) {
    throw new Error(`${options.errorPrefix}: malformed JSON response`, { cause });
  }
}

function toAbortError(signal: AbortSignal, fallbackMessage: string): Error {
  return signal.reason instanceof Error ? signal.reason : new Error(fallbackMessage);
}

function cancelResponseBody(res: Response): void {
  const body = res.body;
  if (!body || typeof body.cancel !== "function") {
    return;
  }
  void body.cancel().catch(() => undefined);
}

function parseContentLength(raw: string | null, errorPrefix: string): number | undefined {
  const trimmed = raw?.trim();
  if (!trimmed) {
    return undefined;
  }
  const value = Number(trimmed);
  if (!/^\d+$/.test(trimmed) || !Number.isSafeInteger(value)) {
    throw new Error(`${errorPrefix}: invalid content-length header: ${raw}`);
  }
  return value;
}

function responseTooLarge(errorPrefix: string, size: number, maxBytes: number): Error {
  return new Error(
    `${errorPrefix}: response body too large: ${size} bytes (limit: ${maxBytes} bytes)`,
  );
}
