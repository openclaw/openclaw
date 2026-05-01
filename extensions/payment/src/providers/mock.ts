import { handleMap } from "../store.js";
import type { CredentialHandle, FundingSource, MachinePaymentResult } from "../types.js";
import type {
  CardSecrets,
  ExecuteMachinePaymentParams,
  IssueVirtualCardParams,
  ListFundingSourcesParams,
  PaymentProviderAdapter,
  PaymentProviderSetupStatus,
} from "./base.js";
import { CardUnavailableError, PolicyDeniedError, UnsupportedRailError } from "./base.js";

// ---------------------------------------------------------------------------
// Module-scoped state
// Reset via __resetMockState() in beforeEach.
// ---------------------------------------------------------------------------

let counter = 0;
const issuedSpendRequestIds = new Set<string>();
const issuedHandles = new Map<string, CredentialHandle>();

/**
 * Resets all module-scoped mock state. Call in beforeEach to avoid cross-test pollution.
 */
export function __resetMockState(): void {
  counter = 0;
  issuedSpendRequestIds.clear();
  issuedHandles.clear();
}

// ---------------------------------------------------------------------------
// Fixed funding sources
// ---------------------------------------------------------------------------

const MOCK_FUNDING_SOURCES: FundingSource[] = [
  {
    id: "mock-fs-card-001",
    provider: "mock",
    rails: ["virtual_card", "machine_payment"],
    settlementAssets: ["usd_card"],
    displayName: "Mock USD Card",
    currency: "usd",
    availableBalanceCents: 100_000_00,
  },
  {
    id: "mock-fs-usdc-001",
    provider: "mock",
    rails: ["machine_payment"],
    settlementAssets: ["usdc"],
    displayName: "Mock USDC Token",
    currency: "usd",
    availableBalanceCents: 1_000_000_00,
  },
];

// ---------------------------------------------------------------------------
// Mock adapter implementation
// ---------------------------------------------------------------------------

export const mockPaymentAdapter: PaymentProviderAdapter = {
  id: "mock",
  rails: ["virtual_card", "machine_payment"],

  async getSetupStatus(): Promise<PaymentProviderSetupStatus> {
    return {
      available: true,
      providerVersion: "mock-1.0.0",
      authState: "authenticated",
      testMode: true,
    };
  },

  async listFundingSources(_params: ListFundingSourcesParams): Promise<FundingSource[]> {
    return [...MOCK_FUNDING_SOURCES];
  },

  async issueVirtualCard(params: IssueVirtualCardParams): Promise<CredentialHandle> {
    // Validate purchaseIntent length (matches Stripe Link's real constraint)
    if (params.purchaseIntent.length < 100) {
      throw new PolicyDeniedError("purchaseIntent must be at least 100 characters", "mock");
    }

    // Validate funding source exists and supports virtual_card
    const fs = MOCK_FUNDING_SOURCES.find((s) => s.id === params.fundingSourceId);
    if (!fs || !fs.rails.includes("virtual_card")) {
      throw new UnsupportedRailError("mock", "virtual_card", "issueVirtualCard");
    }

    counter += 1;
    const handleId = `mock-handle-${counter}`;
    const spendRequestId = `mock-spreq-${counter}`;

    const handle: CredentialHandle = {
      id: handleId,
      provider: "mock",
      rail: "virtual_card",
      status: "approved",
      providerRequestId: spendRequestId,
      validUntil: new Date(Date.now() + 30 * 60_000).toISOString(),
      display: {
        brand: "Visa",
        last4: "4242",
        expMonth: "12",
        expYear: "2030",
      },
      fillSentinels: {
        pan: { $paymentHandle: handleId, field: "pan" },
        cvv: { $paymentHandle: handleId, field: "cvv" },
        exp_month: { $paymentHandle: handleId, field: "exp_month" },
        exp_year: { $paymentHandle: handleId, field: "exp_year" },
        exp_mm_yy: { $paymentHandle: handleId, field: "exp_mm_yy" },
        exp_mm_yyyy: { $paymentHandle: handleId, field: "exp_mm_yyyy" },
        holder_name: { $paymentHandle: handleId, field: "holder_name" },
      },
    };

    // Track issued spend request ids for retrieveCardSecrets
    issuedSpendRequestIds.add(spendRequestId);
    // Track the handle for getStatus
    issuedHandles.set(handleId, handle);

    // Populate handleMap with non-sensitive metadata.
    // Choice: mock populates handleMap directly (simplest approach for U3;
    // the manager layer can take over in U5 when audit records are wired).
    handleMap.set(handleId, {
      spendRequestId,
      providerId: "mock",
      last4: "4242",
      issuedAt: new Date().toISOString(),
      validUntil: handle.validUntil,
    });

    return handle;
  },

  async retrieveCardSecrets(spendRequestId: string): Promise<CardSecrets> {
    if (!issuedSpendRequestIds.has(spendRequestId)) {
      throw new CardUnavailableError(undefined, "spend_request not found", "mock");
    }
    // MUST NOT be persisted, logged, or returned from any tool path.
    // The before_tool_call fill hook in U6 is the ONLY consumer.
    return {
      pan: "4242 4242 4242 4242",
      cvv: "123",
      expMonth: "12",
      expYear: "2030",
      expMmYy: "12/30",
      expMmYyyy: "12/2030",
      holderName: "Mock Holder",
    };
  },

  async executeMachinePayment(params: ExecuteMachinePaymentParams): Promise<MachinePaymentResult> {
    // Validate funding source exists and supports machine_payment
    const fs = MOCK_FUNDING_SOURCES.find((s) => s.id === params.fundingSourceId);
    if (!fs || !fs.rails.includes("machine_payment")) {
      throw new UnsupportedRailError("mock", "machine_payment", "executeMachinePayment");
    }

    counter += 1;
    const handleId = `mock-handle-${counter}`;
    const receiptId = `mock-rcpt-${counter}`;

    return {
      handleId,
      targetUrl: params.targetUrl,
      outcome: "settled",
      receipt: {
        receiptId,
        issuedAt: new Date().toISOString(),
        statusCode: 200,
      },
    };
  },

  async getStatus(handleId: string): Promise<CredentialHandle> {
    const handle = issuedHandles.get(handleId);
    if (!handle) {
      throw new CardUnavailableError(handleId, "handle not found", "mock");
    }
    return handle;
  },
};
