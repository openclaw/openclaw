import type {
  PaymentProviderId,
  PaymentRail,
  FundingSource,
  CredentialHandle,
  MachinePaymentResult,
  Money,
  Merchant,
} from "../types.js";

// ----- Setup status -----
export type PaymentProviderSetupStatus = {
  available: boolean;
  reason?: string; // when not available, human-readable reason
  providerVersion?: string;
  authState?: "unknown" | "unauthenticated" | "authenticated";
  testMode?: boolean;
};

// ----- Param shapes -----
export type ListFundingSourcesParams = {
  // Reserved for future filters; empty in V1. Adapters MUST accept undefined fields gracefully.
};

export type IssueVirtualCardParams = {
  fundingSourceId: string;
  amount: Money;
  merchant: Merchant;
  /**
   * User-visible context string.
   * Stripe Link requires >= 100 chars; the adapter validates this before shelling out.
   */
  purchaseIntent: string;
  /** Optional caller-supplied idempotency key. If omitted, the manager generates one. */
  idempotencyKey?: string;
};

export type ExecuteMachinePaymentParams = {
  fundingSourceId: string;
  targetUrl: string;
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  body?: unknown; // optional JSON-serializable body
  /** Optional caller-supplied idempotency key. If omitted, the manager generates one. */
  idempotencyKey?: string;
};

// ----- Adapter interface -----
export interface PaymentProviderAdapter {
  readonly id: PaymentProviderId;
  readonly rails: readonly PaymentRail[];

  getSetupStatus(): Promise<PaymentProviderSetupStatus>;
  listFundingSources(params: ListFundingSourcesParams): Promise<FundingSource[]>;

  /** Approval already gated by the manager. Returns a CredentialHandle in pending_approval/approved/denied terminal status. */
  issueVirtualCard(params: IssueVirtualCardParams): Promise<CredentialHandle>;

  /**
   * Hook-only. Returns transient card secrets + buyer profile for browser-fill substitution.
   * MUST NOT be persisted, logged, or returned from any tool path.
   * The caller (the before_tool_call fill hook in U6) drops the values immediately
   * after substitution.
   *
   * The method NAME stays `retrieveCardSecrets` for backward-compatibility with
   * security audit comments throughout the codebase. The "single call site"
   * invariant references this exact method name.
   */
  retrieveCardSecrets(spendRequestId: string): Promise<CredentialFillData>;

  executeMachinePayment(params: ExecuteMachinePaymentParams): Promise<MachinePaymentResult>;

  getStatus(handleId: string): Promise<CredentialHandle>;
}

/**
 * Transient card-secret object. MUST NOT be persisted, logged, or returned from any
 * tool path. Closed type — only the fields below are recognized as card secrets.
 *
 * The before_tool_call fill hook in U6 is the ONLY consumer; it substitutes these
 * into rewritten params and drops the reference immediately after.
 *
 * Strictly card-secret fields only. All redact-protected by the redaction-hook's
 * pattern matchers (Luhn for PAN, CVV-context, Authorization: Payment).
 */
export type CardSecrets = {
  pan: string; // Luhn-detectable. Redact-protected.
  cvv: string; // CVV-context detectable. Redact-protected.
  expMonth: string; // "12"
  expYear: string; // "2030"
  expMmYy: string; // "12/30"
  expMmYyyy: string; // "12/2030"
};

/**
 * Buyer PII with known structured fields and an open extras map for forward-compat
 * passthrough. Less strict redaction than CardSecrets (still PII-sensitive, but
 * not card-secret).
 *
 * Adapters auto-pass-through any string-typed top-level fields from the underlying
 * provider response that aren't structurally captured. So when link-cli starts
 * exposing email/phone/shipping_*, agents can use those field names immediately
 * without plugin code changes.
 *
 * SECURITY: Adapters MUST NOT populate `extras` with card-secret data (PAN, CVV,
 * full expiry). The string-typed-fields-only filter in the Stripe Link adapter is
 * a defense-in-depth measure against accidental leakage of nested objects.
 */
export type BuyerProfile = {
  /** Cardholder name (from card.billing_address.name in current Stripe Link). */
  holderName?: string;
  /** Structured billing address fields. All optional. */
  billing?: {
    line1?: string;
    city?: string;
    state?: string;
    postalCode?: string;
    country?: string;
  };
  /**
   * Forward-compat passthrough. Adapters populate this with any non-secret
   * string-typed fields from the underlying provider response that aren't
   * captured in the structured tier above.
   *
   * Example: if link-cli starts returning `card.email`, the Stripe Link adapter
   * passes it through here as `extras.email = "..."`. The agent can immediately
   * use `field: "email"` without any plugin code changes.
   *
   * MUST NOT contain card-secret data (PAN, CVV, full expiry). Adapters are
   * responsible for excluding sensitive fields from extras.
   */
  extras: Record<string, string>;
};

/**
 * Two-tier transient data returned by `retrieveCardSecrets`.
 *
 * Tier 1 (`secrets`): strictly card-secret. Closed type, redact-protected.
 * Tier 2 (`profile`): buyer PII with open extras for forward-compat passthrough.
 *
 * MUST NOT be persisted, logged, or returned from any tool path. The fill-hook
 * is the only consumer.
 */
export type CredentialFillData = {
  secrets: CardSecrets;
  profile: BuyerProfile;
};

// ----- Typed errors -----
export class PaymentProviderError extends Error {
  readonly code: PaymentProviderErrorCode;
  readonly providerId?: PaymentProviderId;
  constructor(
    code: PaymentProviderErrorCode,
    message: string,
    providerId?: PaymentProviderId,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "PaymentProviderError";
    this.code = code;
    this.providerId = providerId;
  }
}

export type PaymentProviderErrorCode =
  | "unsupported_rail"
  | "provider_unavailable"
  | "policy_denied"
  | "card_unavailable";

export class UnsupportedRailError extends PaymentProviderError {
  readonly rail: PaymentRail;
  readonly action: "issueVirtualCard" | "executeMachinePayment";
  constructor(
    providerId: PaymentProviderId,
    rail: PaymentRail,
    action: "issueVirtualCard" | "executeMachinePayment",
    options?: { cause?: unknown },
  ) {
    super(
      "unsupported_rail",
      `Provider "${providerId}" does not support rail "${rail}" for action "${action}"`,
      providerId,
      options,
    );
    this.name = "UnsupportedRailError";
    this.rail = rail;
    this.action = action;
  }
}

export class ProviderUnavailableError extends PaymentProviderError {
  constructor(providerId: PaymentProviderId, reason: string, options?: { cause?: unknown }) {
    super(
      "provider_unavailable",
      `Provider "${providerId}" unavailable: ${reason}`,
      providerId,
      options,
    );
    this.name = "ProviderUnavailableError";
  }
}

export class PolicyDeniedError extends PaymentProviderError {
  readonly reason: string;
  constructor(reason: string, providerId?: PaymentProviderId, options?: { cause?: unknown }) {
    super("policy_denied", `Policy denied: ${reason}`, providerId, options);
    this.name = "PolicyDeniedError";
    this.reason = reason;
  }
}

export class CardUnavailableError extends PaymentProviderError {
  readonly handleId?: string;
  constructor(
    handleId: string | undefined,
    reason: string,
    providerId?: PaymentProviderId,
    options?: { cause?: unknown },
  ) {
    super("card_unavailable", `Card unavailable: ${reason}`, providerId, options);
    this.name = "CardUnavailableError";
    this.handleId = handleId;
  }
}
