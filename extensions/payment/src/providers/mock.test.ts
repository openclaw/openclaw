import { beforeEach, describe, expect, it } from "vitest";
import { handleMap } from "../store.js";
import { CardUnavailableError, PolicyDeniedError, UnsupportedRailError } from "./base.js";
import { __resetMockState, mockPaymentAdapter } from "./mock.js";

// ---------------------------------------------------------------------------
// Helper: a purchaseIntent that satisfies the >= 100 char constraint
// ---------------------------------------------------------------------------

const VALID_PURCHASE_INTENT =
  "I am purchasing a software subscription from Acme Corp for the monthly developer plan. " +
  "This charge is authorized by the account owner.";

const BASE_AMOUNT = { amountCents: 1000, currency: "usd" };
const BASE_MERCHANT = { name: "Acme Corp", url: "https://acme.example.com" };

beforeEach(() => {
  __resetMockState();
  // Clear handleMap between tests
  for (const id of [...handleMap._map.keys()]) {
    handleMap.delete(id);
  }
});

// ---------------------------------------------------------------------------
// getSetupStatus
// ---------------------------------------------------------------------------

describe("mockPaymentAdapter.getSetupStatus", () => {
  it("returns available=true with expected fields", async () => {
    const status = await mockPaymentAdapter.getSetupStatus();
    expect(status.available).toBe(true);
    expect(status.providerVersion).toBe("mock-1.0.0");
    expect(status.authState).toBe("authenticated");
    expect(status.testMode).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// listFundingSources
// ---------------------------------------------------------------------------

describe("mockPaymentAdapter.listFundingSources", () => {
  it("returns exactly 2 fixed funding sources", async () => {
    const sources = await mockPaymentAdapter.listFundingSources({});
    expect(sources).toHaveLength(2);
  });

  it("first source supports both rails", async () => {
    const sources = await mockPaymentAdapter.listFundingSources({});
    const card = sources.find((s) => s.id === "mock-fs-card-001");
    expect(card).toBeDefined();
    expect(card?.rails).toContain("virtual_card");
    expect(card?.rails).toContain("machine_payment");
    expect(card?.settlementAssets).toContain("usd_card");
  });

  it("second source supports only machine_payment rail", async () => {
    const sources = await mockPaymentAdapter.listFundingSources({});
    const usdc = sources.find((s) => s.id === "mock-fs-usdc-001");
    expect(usdc).toBeDefined();
    expect(usdc?.rails).toContain("machine_payment");
    expect(usdc?.rails).not.toContain("virtual_card");
    expect(usdc?.settlementAssets).toContain("usdc");
  });
});

// ---------------------------------------------------------------------------
// issueVirtualCard
// ---------------------------------------------------------------------------

describe("mockPaymentAdapter.issueVirtualCard", () => {
  it("returns approved CredentialHandle with expected fields", async () => {
    const handle = await mockPaymentAdapter.issueVirtualCard({
      fundingSourceId: "mock-fs-card-001",
      amount: BASE_AMOUNT,
      merchant: BASE_MERCHANT,
      purchaseIntent: VALID_PURCHASE_INTENT,
    });

    expect(handle.status).toBe("approved");
    expect(handle.provider).toBe("mock");
    expect(handle.rail).toBe("virtual_card");
    expect(handle.id).toMatch(/^mock-handle-\d+$/);
    expect(handle.providerRequestId).toMatch(/^mock-spreq-\d+$/);
    expect(handle.display?.brand).toBe("Visa");
    expect(handle.display?.last4).toBe("4242");
    expect(handle.display?.expMonth).toBe("12");
    expect(handle.display?.expYear).toBe("2030");
  });

  it("populates all 5 fillSentinels referencing the handle id", async () => {
    const handle = await mockPaymentAdapter.issueVirtualCard({
      fundingSourceId: "mock-fs-card-001",
      amount: BASE_AMOUNT,
      merchant: BASE_MERCHANT,
      purchaseIntent: VALID_PURCHASE_INTENT,
    });

    expect(handle.fillSentinels).toBeDefined();
    const sentinels = handle.fillSentinels!;
    expect(sentinels.pan).toEqual({ $paymentHandle: handle.id, field: "pan" });
    expect(sentinels.cvv).toEqual({ $paymentHandle: handle.id, field: "cvv" });
    expect(sentinels.exp_month).toEqual({ $paymentHandle: handle.id, field: "exp_month" });
    expect(sentinels.exp_year).toEqual({ $paymentHandle: handle.id, field: "exp_year" });
    expect(sentinels.holder_name).toEqual({ $paymentHandle: handle.id, field: "holder_name" });
  });

  it("throws PolicyDeniedError when purchaseIntent < 100 chars", async () => {
    await expect(
      mockPaymentAdapter.issueVirtualCard({
        fundingSourceId: "mock-fs-card-001",
        amount: BASE_AMOUNT,
        merchant: BASE_MERCHANT,
        purchaseIntent: "too short",
      }),
    ).rejects.toThrow(PolicyDeniedError);
  });

  it("PolicyDeniedError has correct providerId and reason", async () => {
    let caught: PolicyDeniedError | undefined;
    try {
      await mockPaymentAdapter.issueVirtualCard({
        fundingSourceId: "mock-fs-card-001",
        amount: BASE_AMOUNT,
        merchant: BASE_MERCHANT,
        purchaseIntent: "short",
      });
    } catch (err) {
      caught = err as PolicyDeniedError;
    }
    expect(caught).toBeInstanceOf(PolicyDeniedError);
    expect(caught?.providerId).toBe("mock");
    expect(caught?.reason).toContain("purchaseIntent");
  });

  it("throws UnsupportedRailError for non-existent fundingSourceId", async () => {
    await expect(
      mockPaymentAdapter.issueVirtualCard({
        fundingSourceId: "nonexistent-fs",
        amount: BASE_AMOUNT,
        merchant: BASE_MERCHANT,
        purchaseIntent: VALID_PURCHASE_INTENT,
      }),
    ).rejects.toThrow(UnsupportedRailError);
  });

  it("throws UnsupportedRailError for funding source that doesn't support virtual_card", async () => {
    // mock-fs-usdc-001 only supports machine_payment
    await expect(
      mockPaymentAdapter.issueVirtualCard({
        fundingSourceId: "mock-fs-usdc-001",
        amount: BASE_AMOUNT,
        merchant: BASE_MERCHANT,
        purchaseIntent: VALID_PURCHASE_INTENT,
      }),
    ).rejects.toThrow(UnsupportedRailError);
  });

  it("populates handleMap after successful issuance", async () => {
    const handle = await mockPaymentAdapter.issueVirtualCard({
      fundingSourceId: "mock-fs-card-001",
      amount: BASE_AMOUNT,
      merchant: BASE_MERCHANT,
      purchaseIntent: VALID_PURCHASE_INTENT,
    });

    const meta = handleMap.get(handle.id);
    expect(meta).toBeDefined();
    expect(meta?.spendRequestId).toBe(handle.providerRequestId);
    expect(meta?.last4).toBe("4242");
    expect(meta?.validUntil).toBe(handle.validUntil);
  });

  it("handle ids increment monotonically across calls", async () => {
    const h1 = await mockPaymentAdapter.issueVirtualCard({
      fundingSourceId: "mock-fs-card-001",
      amount: BASE_AMOUNT,
      merchant: BASE_MERCHANT,
      purchaseIntent: VALID_PURCHASE_INTENT,
    });
    const h2 = await mockPaymentAdapter.issueVirtualCard({
      fundingSourceId: "mock-fs-card-001",
      amount: BASE_AMOUNT,
      merchant: BASE_MERCHANT,
      purchaseIntent: VALID_PURCHASE_INTENT,
    });
    expect(h1.id).not.toBe(h2.id);
    expect(h1.providerRequestId).not.toBe(h2.providerRequestId);
  });

  it("validUntil is approximately 30 minutes in the future", async () => {
    const before = Date.now();
    const handle = await mockPaymentAdapter.issueVirtualCard({
      fundingSourceId: "mock-fs-card-001",
      amount: BASE_AMOUNT,
      merchant: BASE_MERCHANT,
      purchaseIntent: VALID_PURCHASE_INTENT,
    });
    const after = Date.now();

    const validUntil = new Date(handle.validUntil!).getTime();
    const thirtyMins = 30 * 60_000;
    expect(validUntil).toBeGreaterThanOrEqual(before + thirtyMins - 1000);
    expect(validUntil).toBeLessThanOrEqual(after + thirtyMins + 1000);
  });
});

// ---------------------------------------------------------------------------
// retrieveCardSecrets
// ---------------------------------------------------------------------------

describe("mockPaymentAdapter.retrieveCardSecrets", () => {
  it("returns deterministic test values for an issued spend request", async () => {
    const handle = await mockPaymentAdapter.issueVirtualCard({
      fundingSourceId: "mock-fs-card-001",
      amount: BASE_AMOUNT,
      merchant: BASE_MERCHANT,
      purchaseIntent: VALID_PURCHASE_INTENT,
    });

    const secrets = await mockPaymentAdapter.retrieveCardSecrets(handle.providerRequestId!);

    // Assert individual fields with literals — avoid stringifying into a snapshot
    expect(secrets.pan).toBe("4242 4242 4242 4242");
    expect(secrets.cvv).toBe("123");
    expect(secrets.expMonth).toBe("12");
    expect(secrets.expYear).toBe("2030");
    expect(secrets.holderName).toBe("Mock Holder");
  });

  it("throws CardUnavailableError for unknown spend request id", async () => {
    await expect(mockPaymentAdapter.retrieveCardSecrets("nonexistent-spend-req")).rejects.toThrow(
      CardUnavailableError,
    );
  });

  it("CardUnavailableError for unknown spend request has correct code", async () => {
    let caught: CardUnavailableError | undefined;
    try {
      await mockPaymentAdapter.retrieveCardSecrets("nonexistent");
    } catch (err) {
      caught = err as CardUnavailableError;
    }
    expect(caught).toBeInstanceOf(CardUnavailableError);
    expect(caught?.code).toBe("card_unavailable");
    expect(caught?.providerId).toBe("mock");
    expect(caught?.handleId).toBeUndefined();
  });

  it("spend request from one issue is not accessible after state reset", async () => {
    const handle = await mockPaymentAdapter.issueVirtualCard({
      fundingSourceId: "mock-fs-card-001",
      amount: BASE_AMOUNT,
      merchant: BASE_MERCHANT,
      purchaseIntent: VALID_PURCHASE_INTENT,
    });
    const spendReqId = handle.providerRequestId!;

    __resetMockState();

    await expect(mockPaymentAdapter.retrieveCardSecrets(spendReqId)).rejects.toThrow(
      CardUnavailableError,
    );
  });
});

// ---------------------------------------------------------------------------
// executeMachinePayment
// ---------------------------------------------------------------------------

describe("mockPaymentAdapter.executeMachinePayment", () => {
  it("happy path returns settled outcome with receipt", async () => {
    const result = await mockPaymentAdapter.executeMachinePayment({
      fundingSourceId: "mock-fs-card-001",
      targetUrl: "https://api.example.com/pay",
      method: "POST",
      body: { amount: 1000 },
    });

    expect(result.outcome).toBe("settled");
    expect(result.targetUrl).toBe("https://api.example.com/pay");
    expect(result.receipt?.receiptId).toMatch(/^mock-rcpt-\d+$/);
    expect(result.receipt?.statusCode).toBe(200);
    expect(result.receipt?.issuedAt).toBeTruthy();
  });

  it("also works with usdc funding source (supports machine_payment)", async () => {
    const result = await mockPaymentAdapter.executeMachinePayment({
      fundingSourceId: "mock-fs-usdc-001",
      targetUrl: "https://api.example.com/pay",
      method: "GET",
    });
    expect(result.outcome).toBe("settled");
  });

  it("throws UnsupportedRailError for non-existent fundingSourceId", async () => {
    await expect(
      mockPaymentAdapter.executeMachinePayment({
        fundingSourceId: "nonexistent-fs",
        targetUrl: "https://api.example.com/pay",
        method: "POST",
      }),
    ).rejects.toThrow(UnsupportedRailError);
  });

  it("handleId in result follows mock-handle-N pattern", async () => {
    const result = await mockPaymentAdapter.executeMachinePayment({
      fundingSourceId: "mock-fs-card-001",
      targetUrl: "https://api.example.com/pay",
      method: "POST",
    });
    expect(result.handleId).toMatch(/^mock-handle-\d+$/);
  });
});

// ---------------------------------------------------------------------------
// getStatus
// ---------------------------------------------------------------------------

describe("mockPaymentAdapter.getStatus", () => {
  it("returns the originally issued CredentialHandle", async () => {
    const handle = await mockPaymentAdapter.issueVirtualCard({
      fundingSourceId: "mock-fs-card-001",
      amount: BASE_AMOUNT,
      merchant: BASE_MERCHANT,
      purchaseIntent: VALID_PURCHASE_INTENT,
    });

    const status = await mockPaymentAdapter.getStatus(handle.id);
    expect(status).toEqual(handle);
  });

  it("throws CardUnavailableError for unknown handleId", async () => {
    await expect(mockPaymentAdapter.getStatus("nonexistent-handle")).rejects.toThrow(
      CardUnavailableError,
    );
  });

  it("CardUnavailableError carries the handleId", async () => {
    let caught: CardUnavailableError | undefined;
    try {
      await mockPaymentAdapter.getStatus("handle-xyz");
    } catch (err) {
      caught = err as CardUnavailableError;
    }
    expect(caught?.handleId).toBe("handle-xyz");
    expect(caught?.providerId).toBe("mock");
  });
});
