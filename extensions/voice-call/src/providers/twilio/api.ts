import { asNullableObjectRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { safeParseJson } from "openclaw/plugin-sdk/text-utility-runtime";
import { isProviderStatusTerminal, normalizeProviderStatus } from "../shared/call-status.js";
import { createCarrierApi } from "../shared/carrier-api.js";
import { requireSupportedTwilioApiHostname } from "../twilio-region.js";

export class TwilioApiError extends Error {
  readonly twilioCode?: number;
  readonly moreInfo?: string;

  constructor(httpStatus: number, responseText: string) {
    const parsed = asNullableObjectRecord(safeParseJson<unknown>(responseText));
    const detail = typeof parsed?.message === "string" ? parsed.message : responseText;
    const twilioCode = typeof parsed?.code === "number" ? parsed.code : undefined;
    const moreInfo =
      typeof parsed?.more_info === "string" && parsed.more_info.startsWith("https://")
        ? parsed.more_info
        : undefined;
    super(
      `Twilio API error: ${httpStatus} ${detail}${formatTwilioErrorReference(twilioCode, moreInfo)}`,
    );
    this.name = "TwilioApiError";
    this.twilioCode = twilioCode;
    this.moreInfo = moreInfo;
  }
}

/**
 * Twilio's message alone is often ambiguous ("Account not allowed to call ..." covers trial
 * accounts, geo permissions and missing business profiles); the code and docs link tell them apart.
 */
function formatTwilioErrorReference(
  code: number | undefined,
  moreInfo: string | undefined,
): string {
  if (code === undefined) {
    return "";
  }
  return moreInfo ? ` (Twilio error ${code}: ${moreInfo})` : ` (Twilio error ${code})`;
}

export function createTwilioApi(params: {
  baseUrl: string;
  accountSid: string;
  authToken: string;
}) {
  requireSupportedTwilioApiHostname(params.baseUrl);
  const api = createCarrierApi(
    "Twilio",
    params.baseUrl,
    `Basic ${Buffer.from(`${params.accountSid}:${params.authToken}`).toString("base64")}`,
    {
      contentType: "application/x-www-form-urlencoded",
      malformedJsonMessage: "Twilio API returned malformed JSON.",
      createError: (status, text) => new TwilioApiError(status, text),
    },
  );
  return {
    request: <T = unknown>(
      endpoint: string,
      body: URLSearchParams | Record<string, string | string[]>,
      options?: { allowNotFound?: boolean },
    ): Promise<T> => {
      const form = body instanceof URLSearchParams ? body : new URLSearchParams();
      if (!(body instanceof URLSearchParams)) {
        for (const [key, value] of Object.entries(body)) {
          for (const entry of Array.isArray(value) ? value : [value]) {
            form.append(key, entry);
          }
        }
      }
      return api.request<T>(endpoint, form, options);
    },
    getCallStatus: ({ providerCallId }: { providerCallId: string }) =>
      api.getCallStatus<{ status?: string }>(`/Calls/${providerCallId}.json`, (data) => {
        const status = normalizeProviderStatus(data.status);
        return { status, isTerminal: isProviderStatusTerminal(status) };
      }),
  };
}
