import {
  billingSource,
  legacyFailoverCorpusRows,
} from "./failover-classification.corpus.test-support.js";

// Distinct real inputs preserved from matcher-specific suites retired by refactor-02.
export const legacyBillingACases = legacyFailoverCorpusRows("legacy-billing-a", billingSource, [
  [
    4,
    "isTimeoutErrorMessage,classifyFailoverReason,isFailoverErrorMessage",
    "  terminated  ",
    "timeout",
  ],
  [
    6,
    "classifyFailoverReason",
    '{"type":"error","error":{"type":"api_error","message":"invalid input format"}}',
    null,
  ],
  [
    21,
    "classifyFailoverReason",
    '429 {"type":"error","error":{"type":"rate_limit_error","message":"You\\u0027ve hit your usage limit. Upgrade to Plus to continue using Codex (https://chatgpt.com/explore/plus), try again after 11:34 AM."}}',
    "rate_limit",
    "openai",
  ],
  [34, "isAuthErrorMessage", "billing issue detected", null],
  [
    55,
    "classifyFailoverReason",
    'HTTP 401: {"type":"error","error":{"type":"server_error","code":"server_error"}}',
    "auth",
  ],
  [58, "classifyFailoverReason", "HTTP 402", "billing"],
  [
    59,
    "classifyFailoverReason",
    'HTTP 402: {"type":"error","error":{"type":"server_error","code":"server_error"}}',
    "billing",
  ],
  [73, "classifyFailoverReason", "HTTP 404: invalid_api_key", "auth"],
  [
    82,
    "classifyFailoverReason",
    'HTTP 422: {"type":"error","error":{"type":"server_error","code":"server_error"}}',
    "format",
  ],
]);
