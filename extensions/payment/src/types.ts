export type PaymentRail = "virtual_card" | "machine_payment";

export type SettlementAsset = "usd_card" | "usdc";

export type Money = {
  amountCents: number;
  currency: string;
};

export type Merchant = {
  name: string;
  url?: string;
  countryCode?: string;
  category?: string;
  mcc?: string;
};

export type PaymentProviderId = "stripe-link" | "mock";

export type FundingSource = {
  id: string;
  provider: PaymentProviderId;
  rails: PaymentRail[];
  settlementAssets: SettlementAsset[];
  displayName: string;
  currency?: string;
  availableBalanceCents?: number;
  restrictions?: Record<string, unknown>;
};

export type FillSentinel = {
  $paymentHandle: string;
  /**
   * Sentinel field name. Resolved at fill time by the payment plugin's
   * before_tool_call hook against the adapter's CredentialFillData.
   *
   * Well-known values (always supported by stripe-link and mock adapters):
   *   - Card secrets: "pan", "cvv", "exp_month", "exp_year", "exp_mm_yy", "exp_mm_yyyy"
   *   - Buyer profile: "holder_name", "billing_line1", "billing_city",
   *                    "billing_state", "billing_postal_code", "billing_country"
   *
   * Forward-compat: if the underlying provider exposes additional fields
   * (e.g., link-cli adds `email`, `phone`, `shipping_*`), the adapter
   * passes them through via BuyerProfile.extras and the agent can use the
   * field name immediately. Unknown fields fail fast with a clear
   * "field not available for this credential" error.
   */
  field: string;
};

export type CredentialHandle = {
  id: string;
  provider: PaymentProviderId;
  rail: PaymentRail;
  status: "pending_approval" | "approved" | "denied" | "expired";
  providerRequestId?: string;
  validUntil?: string;
  display?: {
    brand?: string;
    last4?: string;
    expMonth?: string;
    expYear?: string;
  };
  /**
   * Map of sentinel field name → sentinel object. Adapters always populate the
   * 12 well-known keys. Future fields exposed by the provider (via
   * BuyerProfile.extras) are not pre-listed here; agents may reference them
   * directly by passing `{ $paymentHandle, field: "<name>" }` in a fill call.
   */
  fillSentinels?: Record<string, FillSentinel>;
};

export type Receipt = {
  receiptId?: string;
  issuedAt?: string;
  statusCode?: number;
};

export type MachinePaymentResult = {
  handleId: string;
  targetUrl: string;
  outcome: "settled" | "failed" | "pending";
  receipt?: Receipt;
};
