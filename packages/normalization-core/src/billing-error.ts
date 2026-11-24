import { asOptionalRecord } from "./record-coerce.js";
import { truncateUtf16Safe } from "./utf16-slice.js";

export type BillingError = { message: string; actionUrl?: string };

export const BILLING_ERROR_MESSAGE_MAX_CHARS = 600;
export const BILLING_ERROR_ACTION_URL_MAX_CHARS = 2048;

export function normalizeBillingError(value: unknown): BillingError | undefined {
  const source = asOptionalRecord(value);
  const message =
    typeof source?.message === "string"
      ? truncateUtf16Safe(source.message.trim(), BILLING_ERROR_MESSAGE_MAX_CHARS)
      : "";
  if (!message) {
    return undefined;
  }
  const actionUrl = typeof source?.actionUrl === "string" ? source.actionUrl.trim() : "";
  if (actionUrl && actionUrl.length <= BILLING_ERROR_ACTION_URL_MAX_CHARS) {
    try {
      const url = new URL(actionUrl);
      if (
        (url.protocol === "https:" || url.protocol === "http:") &&
        url.href.length <= BILLING_ERROR_ACTION_URL_MAX_CHARS
      ) {
        return { message, actionUrl: url.href };
      }
    } catch {}
  }
  return { message };
}
