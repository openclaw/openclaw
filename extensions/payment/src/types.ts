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
  field:
    | "pan"
    | "cvv"
    | "exp_month"
    | "exp_year"
    | "exp_mm_yy"
    | "exp_mm_yyyy"
    | "holder_name"
    | "billing_line1"
    | "billing_city"
    | "billing_state"
    | "billing_postal_code"
    | "billing_country";
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
  fillSentinels?: Record<
    | "pan"
    | "cvv"
    | "exp_month"
    | "exp_year"
    | "exp_mm_yy"
    | "exp_mm_yyyy"
    | "holder_name"
    | "billing_line1"
    | "billing_city"
    | "billing_state"
    | "billing_postal_code"
    | "billing_country",
    FillSentinel
  >;
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
