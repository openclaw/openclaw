/**
 * payments.test.ts — Manager + rail-check + mock integration tests.
 *
 * DEFERRED: Plugin-inspector capture run (scenario 6 from feature plan) is
 * deferred to U5, since registerTool("payment", ...) and api.on("before_tool_call", ...)
 * registrations do not exist yet at U3 time. See payments.ts and index.ts.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { defaultPaymentConfig } from "./config.js";
import { createPaymentManager } from "./payments.js";
import type { PaymentProviderAdapter } from "./providers/base.js";
import { CardUnavailableError, UnsupportedRailError } from "./providers/base.js";
import { __resetMockState, mockPaymentAdapter } from "./providers/mock.js";
import { handleMap } from "./store.js";
import type { CredentialHandle, MachinePaymentResult } from "./types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const VALID_PURCHASE_INTENT =
  "Purchasing a developer subscription from Acme Corp for the monthly plan. " +
  "This charge is authorized by the account holder and approved for processing.";

const BASE_AMOUNT = { amountCents: 2500, currency: "usd" };
const BASE_MERCHANT = { name: "Test Merchant", url: "https://merchant.example.com" };
const CONFIG = defaultPaymentConfig();
const MOCK_CONFIG = { ...CONFIG, provider: "mock" as const };

function makeMockManager() {
  return createPaymentManager({ adapters: [mockPaymentAdapter], config: MOCK_CONFIG });
}

beforeEach(() => {
  __resetMockState();
  for (const id of [...handleMap._map.keys()]) {
    handleMap.delete(id);
  }
});

// ---------------------------------------------------------------------------
// 1. Status transitions for issue and execute
// ---------------------------------------------------------------------------

describe("issueVirtualCard — status transitions", () => {
  it("happy path: status is approved, no handleId error", async () => {
    const manager = makeMockManager();
    const handle = await manager.issueVirtualCard({
      providerId: "mock",
      fundingSourceId: "mock-fs-card-001",
      amount: BASE_AMOUNT,
      merchant: BASE_MERCHANT,
      purchaseIntent: VALID_PURCHASE_INTENT,
    });
    expect(handle.status).toBe("approved");
    expect(handle.provider).toBe("mock");
    expect(handle.rail).toBe("virtual_card");
  });

  it("purchaseIntent < 100 chars throws PolicyDeniedError, no handle returned", async () => {
    const manager = makeMockManager();
    await expect(
      manager.issueVirtualCard({
        providerId: "mock",
        fundingSourceId: "mock-fs-card-001",
        amount: BASE_AMOUNT,
        merchant: BASE_MERCHANT,
        purchaseIntent: "too short",
      }),
    ).rejects.toMatchObject({ name: "PolicyDeniedError", code: "policy_denied" });
  });

  it("non-existent fundingSourceId throws (UnsupportedRailError from mock)", async () => {
    const manager = makeMockManager();
    await expect(
      manager.issueVirtualCard({
        providerId: "mock",
        fundingSourceId: "does-not-exist",
        amount: BASE_AMOUNT,
        merchant: BASE_MERCHANT,
        purchaseIntent: VALID_PURCHASE_INTENT,
      }),
    ).rejects.toThrow(UnsupportedRailError);
  });
});

describe("executeMachinePayment — status transitions", () => {
  it("happy path: outcome settled, receipt has receiptId", async () => {
    const manager = makeMockManager();
    const result = await manager.executeMachinePayment({
      providerId: "mock",
      fundingSourceId: "mock-fs-card-001",
      targetUrl: "https://api.example.com/pay",
      method: "POST",
    });
    expect(result.outcome).toBe("settled");
    expect(result.receipt?.receiptId).toBeTruthy();
  });

  it("non-existent fundingSourceId throws", async () => {
    const manager = makeMockManager();
    await expect(
      manager.executeMachinePayment({
        providerId: "mock",
        fundingSourceId: "does-not-exist",
        targetUrl: "https://api.example.com/pay",
        method: "GET",
      }),
    ).rejects.toThrow(UnsupportedRailError);
  });

  it("funding source that doesn't support machine_payment rail throws UnsupportedRailError at manager layer", async () => {
    // Build a virtual-card-only adapter to test the manager's rail check
    const vcOnlyAdapter: PaymentProviderAdapter = {
      id: "mock",
      rails: ["virtual_card"],
      getSetupStatus: vi.fn(),
      listFundingSources: vi.fn(),
      issueVirtualCard: vi.fn(),
      retrieveCardSecrets: vi.fn(),
      executeMachinePayment: vi.fn(),
      getStatus: vi.fn(),
    };

    const manager = createPaymentManager({ adapters: [vcOnlyAdapter], config: MOCK_CONFIG });

    await expect(
      manager.executeMachinePayment({
        providerId: "mock",
        fundingSourceId: "any-fs",
        targetUrl: "https://api.example.com/pay",
        method: "POST",
      }),
    ).rejects.toThrow(UnsupportedRailError);

    // The adapter's executeMachinePayment must NEVER have been called
    expect(vcOnlyAdapter.executeMachinePayment).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 2. Idempotency key behavior
// ---------------------------------------------------------------------------

describe("idempotency key — executeMachinePayment", () => {
  it("supplied idempotency key is passed verbatim to the adapter", async () => {
    const spyAdapter: PaymentProviderAdapter = {
      id: "mock",
      rails: ["virtual_card", "machine_payment"],
      getSetupStatus: vi.fn(),
      listFundingSources: vi.fn(),
      issueVirtualCard: vi.fn(),
      retrieveCardSecrets: vi.fn(),
      executeMachinePayment: vi.fn(
        async (): Promise<MachinePaymentResult> => ({
          handleId: "mock-handle-99",
          targetUrl: "https://example.com",
          outcome: "settled",
          receipt: { receiptId: "rcpt-99", issuedAt: new Date().toISOString(), statusCode: 200 },
        }),
      ),
      getStatus: vi.fn(),
    };

    const manager = createPaymentManager({ adapters: [spyAdapter], config: MOCK_CONFIG });
    await manager.executeMachinePayment({
      providerId: "mock",
      fundingSourceId: "any-fs",
      targetUrl: "https://example.com",
      method: "GET",
      idempotencyKey: "client-key-abc",
    });

    expect(spyAdapter.executeMachinePayment).toHaveBeenCalledWith(
      expect.objectContaining({ idempotencyKey: "client-key-abc" }),
    );
  });

  it("omitted idempotency key is generated (non-empty UUID format)", async () => {
    const spyAdapter: PaymentProviderAdapter = {
      id: "mock",
      rails: ["virtual_card", "machine_payment"],
      getSetupStatus: vi.fn(),
      listFundingSources: vi.fn(),
      issueVirtualCard: vi.fn(),
      retrieveCardSecrets: vi.fn(),
      executeMachinePayment: vi.fn(
        async (): Promise<MachinePaymentResult> => ({
          handleId: "mock-handle-99",
          targetUrl: "https://example.com",
          outcome: "settled",
          receipt: { receiptId: "rcpt-99", issuedAt: new Date().toISOString(), statusCode: 200 },
        }),
      ),
      getStatus: vi.fn(),
    };

    const manager = createPaymentManager({ adapters: [spyAdapter], config: MOCK_CONFIG });
    await manager.executeMachinePayment({
      providerId: "mock",
      fundingSourceId: "any-fs",
      targetUrl: "https://example.com",
      method: "GET",
      // no idempotencyKey
    });

    expect(spyAdapter.executeMachinePayment).toHaveBeenCalledWith(
      expect.objectContaining({ idempotencyKey: expect.stringMatching(/^[0-9a-f-]{36}$/) }),
    );
  });
});

describe("idempotency key — issueVirtualCard", () => {
  it("supplied idempotency key is passed verbatim to the adapter", async () => {
    const spyAdapter: PaymentProviderAdapter = {
      id: "mock",
      rails: ["virtual_card", "machine_payment"],
      getSetupStatus: vi.fn(),
      listFundingSources: vi.fn(),
      issueVirtualCard: vi.fn(
        async (): Promise<CredentialHandle> => ({
          id: "mock-handle-99",
          provider: "mock",
          rail: "virtual_card",
          status: "approved",
        }),
      ),
      retrieveCardSecrets: vi.fn(),
      executeMachinePayment: vi.fn(),
      getStatus: vi.fn(),
    };

    const manager = createPaymentManager({ adapters: [spyAdapter], config: MOCK_CONFIG });
    await manager.issueVirtualCard({
      providerId: "mock",
      fundingSourceId: "any-fs",
      amount: BASE_AMOUNT,
      merchant: BASE_MERCHANT,
      purchaseIntent: VALID_PURCHASE_INTENT,
      idempotencyKey: "client-key-abc",
    });

    expect(spyAdapter.issueVirtualCard).toHaveBeenCalledWith(
      expect.objectContaining({ idempotencyKey: "client-key-abc" }),
    );
  });

  it("omitted idempotency key is generated (non-empty UUID format)", async () => {
    const spyAdapter: PaymentProviderAdapter = {
      id: "mock",
      rails: ["virtual_card", "machine_payment"],
      getSetupStatus: vi.fn(),
      listFundingSources: vi.fn(),
      issueVirtualCard: vi.fn(
        async (): Promise<CredentialHandle> => ({
          id: "mock-handle-99",
          provider: "mock",
          rail: "virtual_card",
          status: "approved",
        }),
      ),
      retrieveCardSecrets: vi.fn(),
      executeMachinePayment: vi.fn(),
      getStatus: vi.fn(),
    };

    const manager = createPaymentManager({ adapters: [spyAdapter], config: MOCK_CONFIG });
    await manager.issueVirtualCard({
      providerId: "mock",
      fundingSourceId: "any-fs",
      amount: BASE_AMOUNT,
      merchant: BASE_MERCHANT,
      purchaseIntent: VALID_PURCHASE_INTENT,
      // no idempotencyKey
    });

    expect(spyAdapter.issueVirtualCard).toHaveBeenCalledWith(
      expect.objectContaining({ idempotencyKey: expect.stringMatching(/^[0-9a-f-]{36}$/) }),
    );
  });
});

// ---------------------------------------------------------------------------
// 3. Store integration: handleMap populated after issueVirtualCard
// ---------------------------------------------------------------------------

describe("store integration", () => {
  it("handleMap is populated with handle metadata after issueVirtualCard", async () => {
    const manager = makeMockManager();
    const handle = await manager.issueVirtualCard({
      providerId: "mock",
      fundingSourceId: "mock-fs-card-001",
      amount: BASE_AMOUNT,
      merchant: BASE_MERCHANT,
      purchaseIntent: VALID_PURCHASE_INTENT,
    });

    // The mock populates handleMap directly after issueVirtualCard.
    // This is the U3 choice: mock owns handleMap population; manager will
    // take over in U5 when audit records are wired end-to-end.
    const meta = handleMap.get(handle.id);
    expect(meta).toBeDefined();
    expect(meta?.spendRequestId).toBe(handle.providerRequestId);
    expect(meta?.last4).toBe("4242");
  });

  it("manager.getStatus resolves via handleMap lookup", async () => {
    const manager = makeMockManager();
    const handle = await manager.issueVirtualCard({
      providerId: "mock",
      fundingSourceId: "mock-fs-card-001",
      amount: BASE_AMOUNT,
      merchant: BASE_MERCHANT,
      purchaseIntent: VALID_PURCHASE_INTENT,
    });

    const status = await manager.getStatus(handle.id);
    expect(status.id).toBe(handle.id);
    expect(status.status).toBe("approved");
  });

  it("manager.getStatus throws CardUnavailableError for unknown handle", async () => {
    const manager = makeMockManager();
    await expect(manager.getStatus("completely-unknown-handle")).rejects.toThrow(
      CardUnavailableError,
    );
  });
});

// ---------------------------------------------------------------------------
// 4. UnsupportedRailError includes provider id, rail, action; adapter not called
// ---------------------------------------------------------------------------

describe("UnsupportedRailError thrown by manager before adapter dispatch", () => {
  it("error fields: providerId, rail, action are correct", async () => {
    const vcOnlyAdapter: PaymentProviderAdapter = {
      id: "mock",
      rails: ["virtual_card"],
      getSetupStatus: vi.fn(),
      listFundingSources: vi.fn(),
      issueVirtualCard: vi.fn(),
      retrieveCardSecrets: vi.fn(),
      executeMachinePayment: vi.fn(),
      getStatus: vi.fn(),
    };

    const manager = createPaymentManager({ adapters: [vcOnlyAdapter], config: MOCK_CONFIG });

    let caught: UnsupportedRailError | undefined;
    try {
      await manager.executeMachinePayment({
        providerId: "mock",
        fundingSourceId: "any",
        targetUrl: "https://example.com",
        method: "GET",
      });
    } catch (err) {
      caught = err as UnsupportedRailError;
    }

    expect(caught).toBeInstanceOf(UnsupportedRailError);
    expect(caught?.providerId).toBe("mock");
    expect(caught?.rail).toBe("machine_payment");
    expect(caught?.action).toBe("executeMachinePayment");
  });

  it("adapter.executeMachinePayment is NEVER called when rail not supported", async () => {
    const vcOnlyAdapter: PaymentProviderAdapter = {
      id: "mock",
      rails: ["virtual_card"],
      getSetupStatus: vi.fn(),
      listFundingSources: vi.fn(),
      issueVirtualCard: vi.fn(),
      retrieveCardSecrets: vi.fn(),
      executeMachinePayment: vi.fn(),
      getStatus: vi.fn(),
    };

    const manager = createPaymentManager({ adapters: [vcOnlyAdapter], config: MOCK_CONFIG });

    try {
      await manager.executeMachinePayment({
        providerId: "mock",
        fundingSourceId: "any",
        targetUrl: "https://example.com",
        method: "GET",
      });
    } catch {
      // Expected
    }

    // Critical assertion: adapter method was never invoked
    expect(vcOnlyAdapter.executeMachinePayment).not.toHaveBeenCalled();
  });

  it("issueVirtualCard UnsupportedRailError has correct fields", async () => {
    const mpOnlyAdapter: PaymentProviderAdapter = {
      id: "mock",
      rails: ["machine_payment"],
      getSetupStatus: vi.fn(),
      listFundingSources: vi.fn(),
      issueVirtualCard: vi.fn(),
      retrieveCardSecrets: vi.fn(),
      executeMachinePayment: vi.fn(),
      getStatus: vi.fn(),
    };

    const manager = createPaymentManager({ adapters: [mpOnlyAdapter], config: MOCK_CONFIG });

    let caught: UnsupportedRailError | undefined;
    try {
      await manager.issueVirtualCard({
        providerId: "mock",
        fundingSourceId: "any",
        amount: BASE_AMOUNT,
        merchant: BASE_MERCHANT,
        purchaseIntent: VALID_PURCHASE_INTENT,
      });
    } catch (err) {
      caught = err as UnsupportedRailError;
    }

    expect(caught).toBeInstanceOf(UnsupportedRailError);
    expect(caught?.providerId).toBe("mock");
    expect(caught?.rail).toBe("virtual_card");
    expect(caught?.action).toBe("issueVirtualCard");
    expect(mpOnlyAdapter.issueVirtualCard).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 5. Mock retrieveCardSecrets — deterministic test values
// ---------------------------------------------------------------------------

describe("retrieveCardSecretsForHook", () => {
  it("returns deterministic test values matching issued card", async () => {
    const manager = makeMockManager();
    const handle = await manager.issueVirtualCard({
      providerId: "mock",
      fundingSourceId: "mock-fs-card-001",
      amount: BASE_AMOUNT,
      merchant: BASE_MERCHANT,
      purchaseIntent: VALID_PURCHASE_INTENT,
    });

    const secrets = await manager.retrieveCardSecretsForHook("mock", handle.providerRequestId!);

    // Assert individual fields with literals — avoid stringifying the object
    expect(secrets.pan).toBe("4242 4242 4242 4242");
    expect(secrets.cvv).toBe("123");
    expect(secrets.expMonth).toBe("12");
    expect(secrets.expYear).toBe("2030");
    expect(secrets.holderName).toBe("Mock Holder");
  });

  it("throws CardUnavailableError for nonexistent spend request id", async () => {
    const manager = makeMockManager();
    await expect(manager.retrieveCardSecretsForHook("mock", "nonexistent")).rejects.toThrow(
      CardUnavailableError,
    );
  });
});

// ---------------------------------------------------------------------------
// Adapter registry — construction-time validation
// ---------------------------------------------------------------------------

describe("createPaymentManager — adapter registry", () => {
  it("throws at construction if two adapters share an id", () => {
    expect(() => {
      createPaymentManager({
        adapters: [mockPaymentAdapter, mockPaymentAdapter],
        config: MOCK_CONFIG,
      });
    }).toThrow(/duplicate adapter id/i);
  });

  it("throws if requested providerId is not registered", async () => {
    const manager = createPaymentManager({ adapters: [mockPaymentAdapter], config: MOCK_CONFIG });
    await expect(
      manager.issueVirtualCard({
        // @ts-expect-error — testing runtime guard for unregistered provider
        providerId: "stripe-link",
        fundingSourceId: "any",
        amount: BASE_AMOUNT,
        merchant: BASE_MERCHANT,
        purchaseIntent: VALID_PURCHASE_INTENT,
      }),
    ).rejects.toThrow(/no adapter registered/i);
  });
});
