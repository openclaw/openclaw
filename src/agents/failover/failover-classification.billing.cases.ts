import {
  type FailoverClassificationCorpusRow,
  billingSource,
  httpSource,
  messageRows,
  failoverSignalRows,
  patternsSource,
  reason,
} from "./failover-classification.corpus.test-support.js";
export const billingCases = [
  ...failoverSignalRows(billingSource, reason("billing"), [
    [
      "billing-together-payment-required",
      {
        provider: "together",
        message:
          "402 Payment Required: The account associated with this API key has reached its maximum allowed monthly spending limit.",
      },
    ],
    [
      "billing-proxy-subscription",
      { message: "402 No available asset for API access, please purchase a subscription" },
    ],
  ]),
  {
    id: "patterns-xai-spending-limit",
    source: patternsSource,
    signal: {
      provider: "xai",
      message:
        '429 {"code":"Some resource has been exhausted","error":"Your team team-redacted has either used all available credits or reached its monthly spending limit. To continue making API requests, please purchase more credits or raise your spending limit."}',
    },
    expected: reason("billing"),
  },
  {
    id: "http-structured-insufficient-quota",
    source: httpSource,
    signal: {
      status: 429,
      code: "insufficient_quota",
      errorType: "rate_limit_error",
      message: "Provider API error (429): Quota exceeded",
      details: ["insufficient_quota"],
    },
    expected: reason("billing"),
  },
  {
    // xAI hook corpus.
    id: "xai-403-spending-limit",
    source: "extensions/xai/index.test.ts",
    signal: {
      provider: "xai",
      message:
        '403 {"code":"The caller does not have permission to execute the specified operation","error":"Your team team-redacted has either used all available credits or reached its monthly spending limit. To continue making API requests, please purchase more credits or raise your spending limit."}',
    },
    expected: reason("billing"),
  },
  ...messageRows(billingSource, reason("billing"), [
    {
      id: "billing-periodic-limit-402",
      message: "402 Payment Required: Weekly/Monthly Limit Exhausted",
    },
    { id: "billing-custom-proxy", message: "402 custom proxy billing failure", status: 402 },
  ]),
] satisfies readonly FailoverClassificationCorpusRow[];
