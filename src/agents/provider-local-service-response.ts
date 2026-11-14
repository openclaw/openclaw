import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { readResponseTextPrefix } from "../infra/http-body.js";
import { truncateUtf8Suffix } from "../utils/utf8-truncate.js";
import { redactProviderResponseErrorText } from "./provider-request-header-redaction.js";

const ERROR_BODY_MAX_BYTES = 64 * 1024;

/** Preserve SDK status/retry handling while enriching an owned service's JSON error. */
export async function withLocalServiceResponseDiagnostics(
  response: Response,
  tail: string,
  signal?: AbortSignal | null,
  requestHeaders?: HeadersInit,
): Promise<Response> {
  if (response.ok || !response.body || !tail || signal?.aborted) {
    return response;
  }
  try {
    const prefix = await readResponseTextPrefix(response.clone(), ERROR_BODY_MAX_BYTES, {
      signal: signal ?? undefined,
      chunkTimeoutMs: 10_000,
    });
    if (prefix.truncated || signal?.aborted) {
      return response;
    }
    const payload = asOptionalRecord(JSON.parse(prefix.text));
    const error = asOptionalRecord(payload?.error);
    if (!error || typeof error.message !== "string") {
      return response;
    }
    // The SDK exposes a 4K message prefix. Keep the latest stderr inside that window.
    const message = redactProviderResponseErrorText(error.message, requestHeaders ?? {});
    const recentTail =
      tail.length > 2048 ? `; recent stderr: ${truncateUtf8Suffix(tail, 2000)}` : tail;
    error.message = `${truncateUtf16Safe(message, 2048)}${recentTail}`;
    const body = JSON.stringify(payload);
    if (Buffer.byteLength(body) > ERROR_BODY_MAX_BYTES) {
      return response;
    }
    const headers = new Headers(response.headers);
    headers.delete("content-length");
    const enhanced = new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
    // A capture tee can keep cancellation pending; never delay the SDK's error.
    void response.body.cancel().catch(() => undefined);
    return enhanced;
  } catch {
    // Malformed or failed bodies retain the SDK's original error handling.
    return response;
  }
}
