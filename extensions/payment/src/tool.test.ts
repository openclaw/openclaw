/**
 * tool.test.ts — Schema validation and handler dispatch tests for the payment tool.
 *
 * Security invariants tested:
 *   - issue_virtual_card result never includes a Luhn-valid PAN string.
 *   - execute_machine_payment result never includes an MPP token.
 *   - fillSentinels included in issue_virtual_card result.
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { Value } from "typebox/value";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PaymentManager } from "./payments.js";
import { PaymentToolInput, registerPaymentTool } from "./tool.js";
import type { CredentialHandle, FundingSource, MachinePaymentResult } from "./types.js";

// ---------------------------------------------------------------------------
// Schema validation helpers
// ---------------------------------------------------------------------------

function isValid(input: unknown): boolean {
  return Value.Check(PaymentToolInput, input);
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const VALID_PURCHASE_INTENT =
  "Purchasing a developer subscription from Acme Corp for the monthly plan. " +
  "This charge is authorized by the account holder and approved for processing. " +
  "Reference: INV-2026-001234.";

const MOCK_HANDLE: CredentialHandle = {
  id: "handle-001",
  provider: "mock",
  rail: "virtual_card",
  status: "approved",
  providerRequestId: "sr-001",
  validUntil: "2026-05-01T00:00:00Z",
  display: {
    brand: "visa",
    last4: "4242",
    expMonth: "12",
    expYear: "2027",
  },
  fillSentinels: {
    pan: { $paymentHandle: "handle-001", field: "pan" },
    cvv: { $paymentHandle: "handle-001", field: "cvv" },
    exp_month: { $paymentHandle: "handle-001", field: "exp_month" },
    exp_year: { $paymentHandle: "handle-001", field: "exp_year" },
    holder_name: { $paymentHandle: "handle-001", field: "holder_name" },
  },
};

const MOCK_FUNDING_SOURCES: FundingSource[] = [
  {
    id: "mock-fs-001",
    provider: "mock",
    rails: ["virtual_card"],
    settlementAssets: ["usd_card"],
    displayName: "Mock Card",
    currency: "usd",
  },
];

const MOCK_MACHINE_RESULT: MachinePaymentResult = {
  handleId: "handle-mp-001",
  targetUrl: "https://example.com/pay",
  outcome: "settled",
  receipt: { receiptId: "rcpt-001", statusCode: 200 },
};

// ---------------------------------------------------------------------------
// Fake manager
// ---------------------------------------------------------------------------

function makeFakeManager(): PaymentManager {
  return {
    getSetupStatus: vi.fn().mockResolvedValue({
      available: true,
      authState: "authenticated",
      providerVersion: "1.0.0",
    }),
    listFundingSources: vi.fn().mockResolvedValue(MOCK_FUNDING_SOURCES),
    issueVirtualCard: vi.fn().mockResolvedValue(MOCK_HANDLE),
    executeMachinePayment: vi.fn().mockResolvedValue(MOCK_MACHINE_RESULT),
    getStatus: vi.fn().mockResolvedValue(MOCK_HANDLE),
    retrieveCardSecretsForHook: vi.fn().mockRejectedValue(new Error("not in test")),
  };
}

// ---------------------------------------------------------------------------
// Fake API
// ---------------------------------------------------------------------------

function makeFakeApi(manager: PaymentManager): {
  api: OpenClawPluginApi;
  registeredTool: () => ReturnType<typeof extractTool>;
} {
  let _tool: any = null;
  const api = {
    registerTool: vi.fn((tool: any) => {
      _tool = tool;
    }),
    on: vi.fn(),
    registerCli: vi.fn(),
  } as unknown as OpenClawPluginApi;

  registerPaymentTool(api as unknown as OpenClawPluginApi, manager);

  return {
    api,
    registeredTool: () => _tool,
  };
}

function extractTool(manager: PaymentManager) {
  let _tool: any = null;
  const fakeApi = {
    registerTool: (tool: any) => {
      _tool = tool;
    },
  } as unknown as OpenClawPluginApi;
  registerPaymentTool(fakeApi, manager);
  return _tool as {
    name: string;
    label: string;
    description: string;
    parameters: unknown;
    execute: (toolCallId: string, params: unknown, signal?: AbortSignal) => Promise<unknown>;
  };
}

// ---------------------------------------------------------------------------
// Schema validation tests
// ---------------------------------------------------------------------------

describe("PaymentToolInput schema validation", () => {
  it("rejects unknown action", () => {
    expect(isValid({ action: "wrong" })).toBe(false);
  });

  it("rejects empty object (no action)", () => {
    expect(isValid({})).toBe(false);
  });

  it("accepts setup_status without providerId", () => {
    expect(isValid({ action: "setup_status" })).toBe(true);
  });

  it("accepts setup_status with valid providerId", () => {
    expect(isValid({ action: "setup_status", providerId: "mock" })).toBe(true);
    expect(isValid({ action: "setup_status", providerId: "stripe-link" })).toBe(true);
  });

  it("rejects setup_status with invalid providerId", () => {
    expect(isValid({ action: "setup_status", providerId: "bad-provider" })).toBe(false);
  });

  it("accepts list_funding_sources", () => {
    expect(isValid({ action: "list_funding_sources" })).toBe(true);
    expect(isValid({ action: "list_funding_sources", providerId: "mock" })).toBe(true);
  });

  it("accepts valid issue_virtual_card", () => {
    expect(
      isValid({
        action: "issue_virtual_card",
        providerId: "mock",
        fundingSourceId: "fs-001",
        amount: { amountCents: 500, currency: "usd" },
        merchant: { name: "Acme Corp", url: "https://acme.example" },
        purchaseIntent: VALID_PURCHASE_INTENT,
      }),
    ).toBe(true);
  });

  it("rejects issue_virtual_card with purchaseIntent shorter than 100 chars", () => {
    expect(
      isValid({
        action: "issue_virtual_card",
        providerId: "mock",
        fundingSourceId: "fs-001",
        amount: { amountCents: 500, currency: "usd" },
        merchant: { name: "Acme" },
        purchaseIntent: "too short",
      }),
    ).toBe(false);
  });

  it("rejects issue_virtual_card with amountCents = 0", () => {
    expect(
      isValid({
        action: "issue_virtual_card",
        providerId: "mock",
        fundingSourceId: "fs-001",
        amount: { amountCents: 0, currency: "usd" },
        merchant: { name: "Acme" },
        purchaseIntent: VALID_PURCHASE_INTENT,
      }),
    ).toBe(false);
  });

  it("rejects issue_virtual_card with negative amountCents", () => {
    expect(
      isValid({
        action: "issue_virtual_card",
        providerId: "mock",
        fundingSourceId: "fs-001",
        amount: { amountCents: -100, currency: "usd" },
        merchant: { name: "Acme" },
        purchaseIntent: VALID_PURCHASE_INTENT,
      }),
    ).toBe(false);
  });

  it("rejects issue_virtual_card missing required providerId", () => {
    expect(
      isValid({
        action: "issue_virtual_card",
        fundingSourceId: "fs-001",
        amount: { amountCents: 500, currency: "usd" },
        merchant: { name: "Acme" },
        purchaseIntent: VALID_PURCHASE_INTENT,
      }),
    ).toBe(false);
  });

  it("accepts valid execute_machine_payment", () => {
    expect(
      isValid({
        action: "execute_machine_payment",
        providerId: "mock",
        fundingSourceId: "fs-001",
        targetUrl: "https://example.com/pay",
        method: "POST",
      }),
    ).toBe(true);
  });

  it("rejects execute_machine_payment with invalid method", () => {
    expect(
      isValid({
        action: "execute_machine_payment",
        providerId: "mock",
        fundingSourceId: "fs-001",
        targetUrl: "https://example.com/pay",
        method: "CONNECT",
      }),
    ).toBe(false);
  });

  it("accepts all valid HTTP methods for execute_machine_payment", () => {
    for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE"]) {
      expect(
        isValid({
          action: "execute_machine_payment",
          providerId: "mock",
          fundingSourceId: "fs-001",
          targetUrl: "https://example.com",
          method,
        }),
      ).toBe(true);
    }
  });

  it("accepts valid get_payment_status", () => {
    expect(isValid({ action: "get_payment_status", handleId: "handle-001" })).toBe(true);
  });

  it("rejects get_payment_status missing handleId", () => {
    expect(isValid({ action: "get_payment_status" })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Handler dispatch tests
// ---------------------------------------------------------------------------

describe("payment tool handler dispatch", () => {
  let manager: PaymentManager;
  let tool: ReturnType<typeof extractTool>;

  beforeEach(() => {
    manager = makeFakeManager();
    tool = extractTool(manager);
  });

  it("registers tool with name 'payment'", () => {
    expect(tool.name).toBe("payment");
  });

  it("dispatches setup_status to manager.getSetupStatus", async () => {
    await tool.execute("tc-1", { action: "setup_status" });
    expect(manager.getSetupStatus).toHaveBeenCalledWith(undefined);
  });

  it("dispatches setup_status with providerId", async () => {
    await tool.execute("tc-1", { action: "setup_status", providerId: "mock" });
    expect(manager.getSetupStatus).toHaveBeenCalledWith("mock");
  });

  it("dispatches list_funding_sources to manager.listFundingSources", async () => {
    await tool.execute("tc-1", { action: "list_funding_sources" });
    expect(manager.listFundingSources).toHaveBeenCalledWith({});
  });

  it("dispatches list_funding_sources with providerId", async () => {
    await tool.execute("tc-1", { action: "list_funding_sources", providerId: "stripe-link" });
    expect(manager.listFundingSources).toHaveBeenCalledWith({ providerId: "stripe-link" });
  });

  it("dispatches issue_virtual_card to manager.issueVirtualCard", async () => {
    await tool.execute("tc-1", {
      action: "issue_virtual_card",
      providerId: "mock",
      fundingSourceId: "fs-001",
      amount: { amountCents: 500, currency: "usd" },
      merchant: { name: "Acme Corp" },
      purchaseIntent: VALID_PURCHASE_INTENT,
    });
    expect(manager.issueVirtualCard).toHaveBeenCalledWith(
      expect.objectContaining({
        providerId: "mock",
        fundingSourceId: "fs-001",
        amount: { amountCents: 500, currency: "usd" },
        merchant: { name: "Acme Corp" },
        purchaseIntent: VALID_PURCHASE_INTENT,
      }),
    );
  });

  it("dispatches execute_machine_payment to manager.executeMachinePayment", async () => {
    await tool.execute("tc-1", {
      action: "execute_machine_payment",
      providerId: "mock",
      fundingSourceId: "fs-001",
      targetUrl: "https://example.com/pay",
      method: "POST",
    });
    expect(manager.executeMachinePayment).toHaveBeenCalledWith(
      expect.objectContaining({
        providerId: "mock",
        fundingSourceId: "fs-001",
        targetUrl: "https://example.com/pay",
        method: "POST",
      }),
    );
  });

  it("dispatches get_payment_status to manager.getStatus", async () => {
    await tool.execute("tc-1", { action: "get_payment_status", handleId: "handle-001" });
    expect(manager.getStatus).toHaveBeenCalledWith("handle-001");
  });
});

// ---------------------------------------------------------------------------
// Result shape tests
// ---------------------------------------------------------------------------

describe("issue_virtual_card result shape", () => {
  let manager: PaymentManager;
  let tool: ReturnType<typeof extractTool>;

  beforeEach(() => {
    manager = makeFakeManager();
    tool = extractTool(manager);
  });

  it("returns fillSentinels with all 5 keys", async () => {
    const result = (await tool.execute("tc-1", {
      action: "issue_virtual_card",
      providerId: "mock",
      fundingSourceId: "fs-001",
      amount: { amountCents: 500, currency: "usd" },
      merchant: { name: "Acme Corp" },
      purchaseIntent: VALID_PURCHASE_INTENT,
    })) as any;

    const { fillSentinels } = result.details;
    expect(fillSentinels).toBeDefined();
    expect(fillSentinels).toHaveProperty("pan");
    expect(fillSentinels).toHaveProperty("cvv");
    expect(fillSentinels).toHaveProperty("exp_month");
    expect(fillSentinels).toHaveProperty("exp_year");
    expect(fillSentinels).toHaveProperty("holder_name");
  });

  it("result content text does not contain a Luhn-valid PAN (4242424242424242)", async () => {
    const result = (await tool.execute("tc-1", {
      action: "issue_virtual_card",
      providerId: "mock",
      fundingSourceId: "fs-001",
      amount: { amountCents: 500, currency: "usd" },
      merchant: { name: "Acme Corp" },
      purchaseIntent: VALID_PURCHASE_INTENT,
    })) as any;

    const text = result.content[0].text;
    // The Stripe test PAN must not appear in the result
    expect(text).not.toContain("4242424242424242");
    // Also check the full 16-digit number with spaces/dashes
    expect(text).not.toMatch(/4242[\s-]?4242[\s-]?4242[\s-]?4242/);
  });

  it("result details do not include a raw PAN string matching 4242424242424242", async () => {
    const result = (await tool.execute("tc-1", {
      action: "issue_virtual_card",
      providerId: "mock",
      fundingSourceId: "fs-001",
      amount: { amountCents: 500, currency: "usd" },
      merchant: { name: "Acme Corp" },
      purchaseIntent: VALID_PURCHASE_INTENT,
    })) as any;

    const detailsStr = JSON.stringify(result.details);
    expect(detailsStr).not.toContain("4242424242424242");
  });

  it("result includes usageHint", async () => {
    const result = (await tool.execute("tc-1", {
      action: "issue_virtual_card",
      providerId: "mock",
      fundingSourceId: "fs-001",
      amount: { amountCents: 500, currency: "usd" },
      merchant: { name: "Acme Corp" },
      purchaseIntent: VALID_PURCHASE_INTENT,
    })) as any;

    expect(result.details.usageHint).toBeDefined();
    expect(typeof result.details.usageHint).toBe("string");
    expect(result.details.usageHint).toContain("browser.act");
  });

  it("result handle does not expose PAN field directly", async () => {
    const result = (await tool.execute("tc-1", {
      action: "issue_virtual_card",
      providerId: "mock",
      fundingSourceId: "fs-001",
      amount: { amountCents: 500, currency: "usd" },
      merchant: { name: "Acme Corp" },
      purchaseIntent: VALID_PURCHASE_INTENT,
    })) as any;

    const handle = result.details.handle;
    // handle should have display.last4 (4 chars only) but no full PAN
    expect(handle.display?.last4).toBe("4242"); // last4 is fine — not a PAN
    // No field called "pan" with a 16-digit value
    expect(handle).not.toHaveProperty("pan");
  });
});

describe("execute_machine_payment result shape", () => {
  let manager: PaymentManager;
  let tool: ReturnType<typeof extractTool>;

  beforeEach(() => {
    manager = makeFakeManager();
    tool = extractTool(manager);
  });

  it("result does not include MPP token in details", async () => {
    // Modify mock to include a token field in the result (simulate what an adapter might return)
    const withToken = { ...MOCK_MACHINE_RESULT, mppToken: "secret-mpp-token-abc123" };
    (manager.executeMachinePayment as any).mockResolvedValue(withToken);

    const result = (await tool.execute("tc-1", {
      action: "execute_machine_payment",
      providerId: "mock",
      fundingSourceId: "fs-001",
      targetUrl: "https://example.com/pay",
      method: "POST",
    })) as any;

    const detailsStr = JSON.stringify(result.details);
    expect(detailsStr).not.toContain("secret-mpp-token-abc123");
    expect(detailsStr).not.toContain("mppToken");
  });

  it("result includes outcome, handleId, targetUrl", async () => {
    const result = (await tool.execute("tc-1", {
      action: "execute_machine_payment",
      providerId: "mock",
      fundingSourceId: "fs-001",
      targetUrl: "https://example.com/pay",
      method: "POST",
    })) as any;

    const { result: redacted } = result.details;
    expect(redacted.outcome).toBe("settled");
    expect(redacted.handleId).toBe("handle-mp-001");
    expect(redacted.targetUrl).toBe("https://example.com/pay");
  });
});

// ---------------------------------------------------------------------------
// registerPaymentTool integration
// ---------------------------------------------------------------------------

describe("registerPaymentTool integration", () => {
  it("calls api.registerTool exactly once", () => {
    const manager = makeFakeManager();
    const registerTool = vi.fn();
    const api = { registerTool } as unknown as OpenClawPluginApi;
    registerPaymentTool(api, manager);
    expect(registerTool).toHaveBeenCalledTimes(1);
  });

  it("registered tool has name 'payment'", () => {
    const manager = makeFakeManager();
    let capturedTool: any = null;
    const api = {
      registerTool: (t: any) => {
        capturedTool = t;
      },
    } as unknown as OpenClawPluginApi;
    registerPaymentTool(api, manager);
    expect(capturedTool?.name).toBe("payment");
  });
});
