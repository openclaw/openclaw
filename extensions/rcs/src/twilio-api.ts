// Rcs plugin module implements guarded Twilio API requests.
import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import type { ResolvedRcsAccount } from "./types.js";

const TWILIO_API_TIMEOUT_MS = 30_000;
const TWILIO_API_SUCCESS_BODY_LIMIT_BYTES = 1 * 1024 * 1024;
const TWILIO_API_ERROR_BODY_LIMIT_BYTES = 8 * 1024;
const TRUNCATED_RESPONSE_SUFFIX = "... [truncated]";

type ParsedTwilioApiError = {
  code?: number;
  message?: string;
};

type TwilioApiResponse = {
  ok: boolean;
  status: number;
  text: string;
};

function parseTwilioApiError(text: string): ParsedTwilioApiError {
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object") {
      return {};
    }
    const record = parsed as Record<string, unknown>;
    return {
      code: typeof record.code === "number" ? record.code : undefined,
      message: typeof record.message === "string" ? record.message : undefined,
    };
  } catch {
    return {};
  }
}

export class TwilioRcsApiError extends Error {
  readonly httpStatus: number;
  readonly responseText: string;
  readonly twilioCode?: number;

  constructor(httpStatus: number, responseText: string, operation = "send") {
    const parsed = parseTwilioApiError(responseText);
    const detail = parsed.message ?? (responseText || "unknown");
    super(`Twilio RCS ${operation} failed (${httpStatus}): ${detail}`);
    this.name = "TwilioRcsApiError";
    this.httpStatus = httpStatus;
    this.responseText = responseText;
    this.twilioCode = parsed.code;
  }
}

function basicAuthHeader(account: ResolvedRcsAccount): string {
  return `Basic ${Buffer.from(`${account.accountSid}:${account.authToken}`).toString("base64")}`;
}

function appendTruncatedResponseSuffix(text: string): string {
  return `${text.trimEnd()}${TRUNCATED_RESPONSE_SUFFIX}`;
}

async function readTwilioApiResponseText(response: Response): Promise<string> {
  if (!response.body) {
    return "";
  }

  const maxBytes = response.ok
    ? TWILIO_API_SUCCESS_BODY_LIMIT_BYTES
    : TWILIO_API_ERROR_BODY_LIMIT_BYTES;
  const truncateOnLimit = !response.ok;
  const reader = response.body.getReader();
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

      const remainingBytes = maxBytes - totalBytes;
      if (value.byteLength > remainingBytes) {
        const clipped = remainingBytes > 0 ? value.slice(0, remainingBytes) : undefined;
        if (truncateOnLimit) {
          if (clipped) {
            text += decoder.decode(clipped, { stream: true });
          }
          await reader.cancel().catch(() => undefined);
          return appendTruncatedResponseSuffix(text + decoder.decode());
        }
        await reader.cancel().catch(() => undefined);
        throw new Error(
          `Twilio RCS API response body too large: ${totalBytes + value.byteLength} bytes ` +
            `(limit: ${maxBytes} bytes)`,
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

function normalizeRequestHeaders(headers: HeadersInit | undefined): Record<string, string> {
  if (!headers) {
    return {};
  }
  if (headers instanceof Headers) {
    return Object.fromEntries(headers.entries());
  }
  if (Array.isArray(headers)) {
    return Object.fromEntries(headers.map(([key, value]) => [key, value]));
  }
  return Object.fromEntries(Object.entries(headers));
}

export async function requestTwilioApi(params: {
  url: string;
  account: ResolvedRcsAccount;
  allowedHostname: string;
  init?: RequestInit;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<TwilioApiResponse> {
  const init = {
    ...params.init,
    headers: {
      ...normalizeRequestHeaders(params.init?.headers),
      authorization: basicAuthHeader(params.account),
    },
  } satisfies RequestInit;
  if (params.fetchImpl) {
    const response = await params.fetchImpl(params.url, init);
    return {
      ok: response.ok,
      status: response.status,
      text: await readTwilioApiResponseText(response),
    };
  }

  const guarded = await fetchWithSsrFGuard({
    url: params.url,
    init,
    auditContext: "rcs-twilio-api",
    policy: { allowedHostnames: [params.allowedHostname] },
    requireHttps: true,
    timeoutMs: params.timeoutMs ?? TWILIO_API_TIMEOUT_MS,
  });
  try {
    return {
      ok: guarded.response.ok,
      status: guarded.response.status,
      text: await readTwilioApiResponseText(guarded.response),
    };
  } finally {
    await guarded.release();
  }
}
