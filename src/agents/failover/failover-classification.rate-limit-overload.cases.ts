import {
  type FailoverClassificationCorpusRow,
  billingSource,
  messageRows,
  failoverSignalRows,
  patternsSource,
  reason,
  retrySource,
} from "./failover-classification.corpus.test-support.js";
export const rateLimitOverloadCases = [
  ...failoverSignalRows(billingSource, reason("rate_limit"), [
    [
      "billing-zhipu-periodic-limit",
      {
        provider: "zai",
        message:
          "LLM error 1310: Weekly/Monthly Limit Exhausted. Your limit will reset at 2026-03-06 22:19:54 (request_id: 20260303141547610b7f574d1b44cb)",
      },
    ],
    [
      "billing-subscription-quota-refresh",
      {
        message:
          "402 You have reached your subscription quota limit. Please wait for automatic quota refresh in the rolling time window, upgrade to a higher plan, or use a Pay-As-You-Go API Key for unlimited access.",
      },
    ],
    [
      "billing-minimax-chinese-usage-limit",
      {
        provider: "minimax",
        message: "已达到 Token Plan 用量上限：请升级 Token Plan 套餐或购买积分补充用量。 (2056)",
      },
    ],
  ]),
  ...messageRows(billingSource, reason("rate_limit"), [
    { id: "billing-rate-limit-too-many", message: "too many requests" },
    {
      id: "billing-org-period",
      message: "Organization limit exceeded for this billing period.",
      status: 402,
    },
    { id: "billing-http402-rate-limit", message: "HTTP 402 Payment Required: rate limit exceeded" },
  ]),
  ...messageRows(patternsSource, reason("rate_limit"), [
    {
      id: "patterns-claude-cli-session-limit",
      provider: "claude-cli",
      message: "You've hit your session limit · resets 2:50pm (America/New_York)",
    },
    {
      id: "patterns-claude-cli-plain-limit",
      provider: "claude-cli",
      message: "You've hit your limit · resets 5pm (Europe/Berlin)",
    },
    {
      id: "patterns-claude-cli-five-hour-limit",
      provider: "claude-cli",
      message: "You've hit your 5-hour limit · resets 3pm (UTC)",
    },
  ]),
  {
    id: "retry-429-insufficient-quota-short",
    source: retrySource,
    signal: { message: "429 insufficient_quota" },
    expected: reason("billing"),
  },
  ...failoverSignalRows(billingSource, reason("overloaded"), [
    ["billing-service-capacity", { message: "service unavailable due to capacity limits" }],
  ]),
] satisfies readonly FailoverClassificationCorpusRow[];
