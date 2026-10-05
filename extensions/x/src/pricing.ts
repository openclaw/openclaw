import { asOptionalRecord as record } from "openclaw/plugin-sdk/string-coerce-runtime";
import { findXUrls } from "./urls.js";

// X pay-per-use rates, verified 2026-10-04:
// https://docs.x.com/x-api/getting-started/pricing
// Count expanded users and repeated resources conservatively, without UTC-day deduplication.
export const X_POST_READ_MICRO_USD = 5_000;
export const X_USER_READ_MICRO_USD = 10_000;
export const X_POST_EVENT_MICRO_USD = 5_000;
const X_REPLY_MICRO_USD = 15_000;
const X_LINK_REPLY_MICRO_USD = 200_000;

export function xReplyCost(text: string): number {
  return findXUrls(text).length ? X_LINK_REPLY_MICRO_USD : X_REPLY_MICRO_USD;
}

export function xReadCost(value: unknown, kind: "posts" | "users"): number {
  const row = record(value);
  const includes = record(row?.includes);
  const count = (data: unknown) => (Array.isArray(data) ? data.length : record(data) ? 1 : 0);
  return (
    count(row?.data) * (kind === "posts" ? X_POST_READ_MICRO_USD : X_USER_READ_MICRO_USD) +
    count(includes?.tweets) * X_POST_READ_MICRO_USD +
    count(includes?.users) * X_USER_READ_MICRO_USD
  );
}
