// Voice Call API module exposes the plugin public contract.
import { fetchWithSsrFGuard } from "../../../api.js";
import {
  cancelProviderResponseBody,
  readProviderErrorResponseSnippet,
  readProviderJsonResponseText,
} from "../shared/response-body.js";

// Guarded Twilio REST API client helpers.

/** Minimal Twilio REST API error payload. */
type ParsedTwilioApiError = {
  code?: number;
  message?: string;
};

const TWILIO_API_TIMEOUT_MS = 30_000;

export type TwilioApiTarget = {
  baseUrl: string;
  hostname: string;
};

/** Build the exact Twilio REST target shared by requests and their SSRF policy. */
export function createTwilioApiTarget(params: {
  accountSid: string;
  edge?: string;
  region?: string;
}): TwilioApiTarget {
  if (Boolean(params.edge) !== Boolean(params.region)) {
    throw new Error("Twilio Edge and Region must be configured together");
  }
  const hostname =
    params.edge && params.region
      ? `api.${params.edge}.${params.region}.twilio.com`
      : "api.twilio.com";
  return {
    baseUrl: `https://${hostname}/2010-04-01/Accounts/${params.accountSid}`,
    hostname,
  };
}

/** Parse Twilio JSON error responses without trusting response shape. */
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

/** Error thrown for non-2xx Twilio REST API responses. */
export class TwilioApiError extends Error {
  readonly httpStatus: number;
  readonly responseText: string;
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

/** POST a form-encoded Twilio REST API request through the SSRF guard. */
export async function twilioApiRequest<T = unknown>(params: {
  target: TwilioApiTarget;
  accountSid: string;
  authToken: string;
  endpoint: string;
  body: URLSearchParams | Record<string, string | string[]>;
  allowNotFound?: boolean;
}): Promise<T> {
  const bodyParams =
    params.body instanceof URLSearchParams
      ? params.body
      : Object.entries(params.body).reduce((acc, [key, value]) => {
          if (Array.isArray(value)) {
            for (const entry of value) {
              acc.append(key, entry);
            }
          } else if (typeof value === "string") {
            acc.append(key, value);
          }
          return acc;
        }, new URLSearchParams());

  const requestUrl = `${params.target.baseUrl}${params.endpoint}`;
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
    policy: { allowedHostnames: [params.target.hostname] },
    timeoutMs: TWILIO_API_TIMEOUT_MS,
    auditContext: "voice-call.twilio.api",
  });
  try {
    if (!response.ok) {
      if (params.allowNotFound && response.status === 404) {
        await cancelProviderResponseBody(response);
        return undefined as T;
      }
      const errorText = await readProviderErrorResponseSnippet(response);
      throw new TwilioApiError(response.status, errorText);
    }

    const text = await readProviderJsonResponseText(response);
    if (!text) {
      return undefined as T;
    }
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new Error("Twilio API returned malformed JSON.");
    }
  } finally {
    await release();
  }
}
