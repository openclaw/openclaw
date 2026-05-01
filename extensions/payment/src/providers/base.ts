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
   * Hook-only. Returns transient card secrets for browser-fill substitution.
   * MUST NOT be persisted, logged, or returned from any tool path.
   * The caller (the before_tool_call fill hook in U6) drops the values immediately
   * after substitution.
   */
  retrieveCardSecrets(spendRequestId: string): Promise<CardSecrets>;

  executeMachinePayment(params: ExecuteMachinePaymentParams): Promise<MachinePaymentResult>;

  getStatus(handleId: string): Promise<CredentialHandle>;
}

/**
 * Transient secret object. MUST NOT be persisted, logged, or returned from any tool path.
 * The before_tool_call fill hook in U6 is the ONLY consumer; it substitutes these into
 * rewritten params and drops the reference immediately after.
 */
export type CardSecrets = {
  pan: string;
  cvv: string;
  expMonth: string;
  expYear: string;
  holderName: string;
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
