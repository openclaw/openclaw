import { describe, expect, it, vi } from "vitest";
import { executeRevenueCommand } from "./executor.js";
import type { GhlClient, StripeClient } from "./types.js";

function mockGhl(overrides?: Partial<GhlClient>): GhlClient {
  return {
    checkContact: vi.fn(async () => null),
    createContact: vi.fn(async () => ({ id: "contact-new" })),
    createOpportunity: vi.fn(async () => ({ id: "opp-123" })),
    ...overrides,
  };
}

function mockStripe(overrides?: Partial<StripeClient>): StripeClient {
  return {
    createPaymentLink: vi.fn(async () => ({ url: "https://buy.stripe.com/test" })),
    ...overrides,
  };
}

const env = {
  OPENCLAW_REVENUE_GHL_LOCATION_ID: "loc-1",
  OPENCLAW_REVENUE_DEFAULT_CURRENCY: "usd",
};

describe("executeRevenueCommand", () => {
  it("creates contact when missing and creates payment link", async () => {
    const ghl = mockGhl();
    const stripe = mockStripe();

    const result = await executeRevenueCommand(
      { command: "sell coaching program $47 for john smith" },
      {
        ghl,
        stripe,
        env,
        runId: "run-1",
      },
    );

    expect(result.ok).toBe(true);
    expect(result.runId).toBe("run-1");
    expect(result.result.contact.exists).toBe(false);
    expect(result.result.contact.contactId).toBe("contact-new");
    expect(result.result.payment.url).toContain("stripe.com");
  });

  it("reuses existing contact and skips payment when price is zero", async () => {
    const ghl = mockGhl({
      checkContact: vi.fn(async () => ({ id: "contact-existing" })),
    });
    const stripe = mockStripe();

    const result = await executeRevenueCommand(
      {
        command: "offer free strategy call $0 for jane doe",
      },
      {
        ghl,
        stripe,
        env,
        runId: "run-2",
      },
    );

    expect(result.result.contact.exists).toBe(true);
    expect(result.result.contact.contactId).toBe("contact-existing");
    expect(result.result.payment.success).toBe(true);
    expect(result.result.payment.url).toBeUndefined();
    expect((stripe.createPaymentLink as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);
  });
});
