export type EmbeddedContextFile = { path: string; content: string };

export type FailoverReason = "auth" | "format" | "rate_limit" | "billing" | "timeout" | "unknown";

/**
 * Structured payment information extracted from x402 v2 billing error responses.
 * Providers that support x402 include a PAYMENT-REQUIRED header and/or embed
 * payment info in the error response body (topup URL, balance, scheme).
 */
export type X402PaymentInfo = {
  /** URL where credits can be purchased (e.g., "https://example.com/billing"). */
  topupUrl?: string;
  /** Current balance information from the provider. */
  balance?: {
    budgetLimit?: number;
    budgetUsed?: number;
    remaining?: number;
  };
  /** Payment scheme (e.g., "fiat-redirect", "crypto"). */
  scheme?: string;
  /** Minimum top-up amount in cents. */
  minAmountCents?: number;
};
