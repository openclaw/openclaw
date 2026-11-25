import { asOptionalRecord } from "./record-coerce.js";
import { normalizeOptionalString } from "./string-coerce.js";
import { truncateUtf16Safe } from "./utf16-slice.js";

export type BillingError = { message: string; actionUrl?: string };

export const BILLING_ERROR_MESSAGE_MAX_CHARS = 600;
export const BILLING_ERROR_ACTION_URL_MAX_CHARS = 2048;

export function normalizeBillingError(value: unknown): BillingError | undefined {
  const source = asOptionalRecord(value);
  const message = normalizeOptionalString(source?.message);
  if (!message) {
    return undefined;
  }
  const result: BillingError = {
    message: truncateUtf16Safe(message, BILLING_ERROR_MESSAGE_MAX_CHARS),
  };
  const actionUrl = normalizeOptionalString(source?.actionUrl);
  if (actionUrl && actionUrl.length <= BILLING_ERROR_ACTION_URL_MAX_CHARS) {
    try {
      const url = new URL(actionUrl);
      if (
        (url.protocol === "https:" || url.protocol === "http:") &&
        !url.username &&
        !url.password &&
        url.href.length <= BILLING_ERROR_ACTION_URL_MAX_CHARS
      ) {
        result.actionUrl = url.href;
      }
    } catch {}
  }
  return result;
}
