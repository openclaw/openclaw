export { asFiniteNumber } from "../shared/number-coercion.js";
import { normalizeOptionalString as trimToUndefined } from "../shared/string-coerce.js";
export { normalizeOptionalString as trimToUndefined } from "../shared/string-coerce.js";

export function asBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

export function asObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function truncateErrorDetail(detail: string, limit = 220): string {
  return detail.length <= limit ? detail : `${detail.slice(0, limit - 1)}…`;
}

export async function readResponseTextLimited(
  response: Response,
  limitBytes = 16 * 1024,
): Promise<string> {
  if (limitBytes <= 0) {
    return "";
  }
  const reader = response.body?.getReader();
  if (!reader) {
    return "";
  }

  const decoder = new TextDecoder();
  let total = 0;
  let text = "";
  let reachedLimit = false;

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }
      if (!value || value.byteLength === 0) {
        continue;
      }
      const remaining = limitBytes - total;
      if (remaining <= 0) {
        reachedLimit = true;
        break;
      }
      const chunk = value.byteLength > remaining ? value.subarray(0, remaining) : value;
      total += chunk.byteLength;
      text += decoder.decode(chunk, { stream: true });
      if (total >= limitBytes) {
        reachedLimit = true;
        break;
      }
    }
    text += decoder.decode();
  } finally {
    if (reachedLimit) {
      await reader.cancel().catch(() => {});
    }
  }

  return text;
}

export function formatProviderErrorPayload(payload: unknown): string | undefined {
  const root = asObject(payload);
  const detailObject = asObject(root?.detail);
  const subject = asObject(root?.error) ?? detailObject ?? root;
  if (!subject) {
    return undefined;
  }
  const message =
    trimToUndefined(subject.message) ??
    trimToUndefined(subject.detail) ??
    trimToUndefined(root?.message) ??
    trimToUndefined(root?.error) ??
    trimToUndefined(root?.detail);
  const type = trimToUndefined(subject.type);
  const code = trimToUndefined(subject.code) ?? trimToUndefined(subject.status);
  const metadata = [type ? `type=${type}` : undefined, code ? `code=${code}` : undefined]
    .filter((value): value is string => Boolean(value))
    .join(", ");
  if (message && metadata) {
    return `${truncateErrorDetail(message)} [${metadata}]`;
  }
  if (message) {
    return truncateErrorDetail(message);
  }
  if (metadata) {
    return `[${metadata}]`;
  }
  return undefined;
}

/**
 * Returns the JSON object encoded by the first `data:` line of an SSE payload,
 * or undefined if the body does not start with one. Streaming endpoints
 * (e.g. Google Generative AI's `:streamGenerateContent?alt=sse`) sometimes
 * deliver error envelopes through SSE framing instead of bare JSON, so the
 * raw body would otherwise fail `JSON.parse` and surface as opaque text.
 */
function tryParseSseDataObject(rawBody: string): unknown {
  for (const line of rawBody.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) {
      continue;
    }
    const payload = trimmed.slice("data:".length).trim();
    if (!payload || payload === "[DONE]") {
      continue;
    }
    try {
      return JSON.parse(payload);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export async function extractProviderErrorDetail(response: Response): Promise<string | undefined> {
  let rawBody: string | undefined;
  try {
    rawBody = trimToUndefined(await readResponseTextLimited(response));
  } catch {
    rawBody = undefined;
  }
  if (rawBody) {
    try {
      return formatProviderErrorPayload(JSON.parse(rawBody)) ?? truncateErrorDetail(rawBody);
    } catch {
      const sseParsed = tryParseSseDataObject(rawBody);
      if (sseParsed !== undefined) {
        const formatted = formatProviderErrorPayload(sseParsed);
        if (formatted) {
          return formatted;
        }
      }
      return truncateErrorDetail(rawBody);
    }
  }
  // When the response body is empty or unreadable (streaming endpoints can
  // close mid-error, producing a 4xx/5xx with no body), fall back to the
  // HTTP status text so callers do not see a bare "(400)" with no context.
  return trimToUndefined(response.statusText);
}

export function extractProviderRequestId(response: Response): string | undefined {
  return (
    trimToUndefined(response.headers.get("x-request-id")) ??
    trimToUndefined(response.headers.get("request-id"))
  );
}

export function formatProviderHttpErrorMessage(params: {
  label: string;
  status: number;
  detail?: string;
  requestId?: string;
  statusPrefix?: string;
}): string {
  const { label, status, detail, requestId, statusPrefix = "" } = params;
  return (
    `${label} (${statusPrefix}${status})` +
    (detail ? `: ${detail}` : "") +
    (requestId ? ` [request_id=${requestId}]` : "")
  );
}

export async function createProviderHttpError(
  response: Response,
  label: string,
  options?: { statusPrefix?: string },
): Promise<Error> {
  const detail = await extractProviderErrorDetail(response);
  const requestId = extractProviderRequestId(response);
  return new Error(
    formatProviderHttpErrorMessage({
      label,
      status: response.status,
      detail,
      requestId,
      statusPrefix: options?.statusPrefix,
    }),
  );
}

export async function assertOkOrThrowProviderError(
  response: Response,
  label: string,
): Promise<void> {
  if (response.ok) {
    return;
  }
  throw await createProviderHttpError(response, label);
}

export async function assertOkOrThrowHttpError(response: Response, label: string): Promise<void> {
  if (response.ok) {
    return;
  }
  throw await createProviderHttpError(response, label, { statusPrefix: "HTTP " });
}
