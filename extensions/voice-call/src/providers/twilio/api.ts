import { fetchWithSsrFGuard } from "../../../api.js";

type ParsedTwilioApiError = {
  code?: number;
  message?: string;
};

const TWILIO_API_TIMEOUT_MS = 30_000;

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

/** Twilio REST failure with structured status/code metadata for provider retry and race handling. */
export class TwilioApiError extends Error {
  /** HTTP status returned by Twilio. */
  readonly httpStatus: number;
  /** Raw response body retained for diagnostics without reparsing at call sites. */
  readonly responseText: string;
  /** Twilio-specific numeric error code, when the response body exposes one. */
  readonly twilioCode?: number;

  constructor(httpStatus: number, responseText: string) {
    const parsed = parseTwilioApiError(responseText);
    const detail = parsed.message ?? responseText;
    super(`Twilio API error: ${httpStatus} ${detail}`);
    this.name = "TwilioApiError";
    this.httpStatus = httpStatus;
    this.responseText = responseText;
    this.twilioCode = parsed.code;
  }
}

/** Sends a Twilio REST form request through the SSRF guard and releases the resolved-address pin. */
export async function twilioApiRequest<T = unknown>(params: {
  /** Twilio REST API origin; normally `https://api.twilio.com`. */
  baseUrl: string;
  /** Account SID used for HTTP Basic auth. */
  accountSid: string;
  /** Auth token paired with the account SID. */
  authToken: string;
  /** API path beginning at the account-scoped resource endpoint. */
  endpoint: string;
  /** Form body; array values are encoded as repeated Twilio form keys. */
  body: URLSearchParams | Record<string, string | string[]>;
  /** Treat 404 as an idempotent missing resource instead of throwing. */
  allowNotFound?: boolean;
}): Promise<T> {
  const bodyParams =
    params.body instanceof URLSearchParams
      ? params.body
      : Object.entries(params.body).reduce((acc, [key, value]) => {
          if (Array.isArray(value)) {
            // Twilio expects repeated form keys for multi-value params like StatusCallbackEvent.
            for (const entry of value) {
              acc.append(key, entry);
            }
          } else if (typeof value === "string") {
            acc.append(key, value);
          }
          return acc;
        }, new URLSearchParams());

  const requestUrl = `${params.baseUrl}${params.endpoint}`;
  const { response, release } = await fetchWithSsrFGuard({
    url: requestUrl,
    init: {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${params.accountSid}:${params.authToken}`).toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: bodyParams,
    },
    policy: { allowedHostnames: ["api.twilio.com"] },
    timeoutMs: TWILIO_API_TIMEOUT_MS,
    auditContext: "voice-call.twilio.api",
  });
  try {
    if (!response.ok) {
      if (params.allowNotFound && response.status === 404) {
        return undefined as T;
      }
      const errorText = await response.text();
      throw new TwilioApiError(response.status, errorText);
    }

    const text = await response.text();
    if (!text) {
      return undefined as T;
    }
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new Error("Twilio API returned malformed JSON.");
    }
  } finally {
    // Release the resolved-address pin after response text has been consumed.
    await release();
  }
}
