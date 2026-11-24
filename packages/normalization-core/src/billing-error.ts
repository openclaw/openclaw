import { asOptionalRecord } from "./record-coerce.js";
import { truncateUtf16Safe } from "./utf16-slice.js";

export type BillingError = { message: string };

export const BILLING_ERROR_MESSAGE_MAX_CHARS = 600;

export function normalizeBillingError(value: unknown): BillingError | undefined {
  const source = asOptionalRecord(value);
  const message =
    typeof source?.message === "string"
      ? truncateUtf16Safe(source.message.trim(), BILLING_ERROR_MESSAGE_MAX_CHARS)
      : "";
  return message ? { message } : undefined;
}
