import {
  billingSource,
  legacyFailoverCorpusRows,
} from "./failover-classification.corpus.test-support.js";

// Distinct real inputs preserved from matcher-specific suites retired by refactor-02.
export const legacyBillingBCases = legacyFailoverCorpusRows("legacy-billing-b", billingSource, [
  [3, "classifyFailoverReason", "HTTP 422: No response body", null],
  [
    28,
    "classifyFailoverReason",
    "OAuth token refresh failed for openai: file lock timeout for /tmp/agent/auth-profiles.json. Please try again or re-authenticate.",
    "auth",
    "openai",
  ],
  [
    36,
    "isTimeoutErrorMessage,classifyFailoverReason,isFailoverErrorMessage",
    "Proxy notice: Status: Internal Server Error; upstream connect error",
    "timeout",
  ],
  [
    37,
    "isBillingErrorMessage",
    "Quarterly report summary: subsystem A returned 402 records after retry. This is an analytics count, not an HTTP/API billing failure. Notes: xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
    "billing",
  ],
  [
    55,
    "isBillingErrorMessage",
    "Sure! Here's how to set up billing for your SaaS application.\n\n## Payment Integration\n\nFirst, you'll need to configure your payment gateway. Most providers offer a dashboard where you can manage credits, view invoices, and upgrade your plan. The billing page typically shows your current balance and payment history.\n\n## Managing Credits\n\nUsers can purchase credits through the billing portal. When their credit balance runs low, send them a notification to upgrade their plan or add more credits. You should also handle insufficient balance cases gracefully.\n\n## Subscription Plans\n\nOffer multiple plan tiers with different features. Allow users to upgrade or downgrade their plan at any time. Make sure the billing cycle is clear.\n\nLet me know if you need more details on any of these topics!",
    null,
  ],
  [
    79,
    "classifyFailoverReason",
    "Your authentication session could not be refreshed automatically. Please log out and sign in again.",
    "auth_permanent",
    "openai",
  ],
]);
