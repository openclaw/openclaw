import { asNullableObjectRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { safeParseJson } from "openclaw/plugin-sdk/text-utility-runtime";
import { guardedJsonApiRequest } from "../shared/guarded-json-api.js";
import { requireSupportedTwilioApiHostname } from "../twilio-region.js";

export class TwilioApiError extends Error {
  readonly httpStatus: number;
  readonly responseText: string;
  readonly twilioCode?: number;

  constructor(httpStatus: number, responseText: string) {
    const parsed = asNullableObjectRecord(safeParseJson<unknown>(responseText));
    const detail = typeof parsed?.message === "string" ? parsed.message : responseText;
    super(`Twilio API error: ${httpStatus} ${detail}`);
    this.name = "TwilioApiError";
    this.httpStatus = httpStatus;
    this.responseText = responseText;
    this.twilioCode = typeof parsed?.code === "number" ? parsed.code : undefined;
  }
}

/** POST a form-encoded Twilio REST API request through the SSRF guard. */
export async function twilioApiRequest<T = unknown>(params: {
  baseUrl: string;
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

  return guardedJsonApiRequest<T>({
    url: `${params.baseUrl}${params.endpoint}`,
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${params.accountSid}:${params.authToken}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: bodyParams,
    allowNotFound: params.allowNotFound,
    allowedHostnames: [requireSupportedTwilioApiHostname(params.baseUrl)],
    auditContext: "voice-call.twilio.api",
    errorPrefix: "Twilio API error",
    malformedJsonMessage: "Twilio API returned malformed JSON.",
    createError: (status, text) => new TwilioApiError(status, text),
  });
}
