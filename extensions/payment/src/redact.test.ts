/**
 * redact.test.ts — Adversarial tests for shared redactor functions.
 *
 * These tests verify that the field-by-field allowlist approach prevents
 * leaking sensitive fields even when they are smuggled via type coercion
 * (e.g., a future CredentialHandle.display gains a cardToken field).
 */

import { describe, it, expect } from "vitest";
import { redactHandle, redactMachinePaymentResult } from "./redact.js";

// ---------------------------------------------------------------------------
// redactHandle
// ---------------------------------------------------------------------------

describe("redactHandle", () => {
  it("strips a smuggled cardToken on display (defense-in-depth)", () => {
    const handle = {
      id: "h1",
      provider: "stripe-link" as const,
      rail: "virtual_card" as const,
      status: "approved" as const,
      providerRequestId: "spreq_x",
      validUntil: "2026-01-01T00:00:00Z",
      display: {
        brand: "Visa",
        last4: "4242",
        expMonth: "12",
        expYear: "2030",
        // @ts-expect-error — intentionally smuggling a sensitive field not in the type
        cardToken: "tok_secret_xyz",
        // @ts-expect-error — and a literal PAN
        pan: "4242424242424242",
      },
    };
    const redacted = JSON.stringify(redactHandle(handle as never));
    expect(redacted).not.toContain("tok_secret_xyz");
    expect(redacted).not.toContain("4242424242424242");
    expect(redacted).toContain("4242"); // last4 is fine
  });

  it("strips a smuggled holder_name and extra fields on fillSentinels", () => {
    const handle = {
      id: "h2",
      provider: "mock" as const,
      rail: "virtual_card" as const,
      status: "approved" as const,
      fillSentinels: {
        pan: { $paymentHandle: "h2", field: "pan" as const },
        cvv: { $paymentHandle: "h2", field: "cvv" as const },
        exp_month: { $paymentHandle: "h2", field: "exp_month" as const },
        exp_year: { $paymentHandle: "h2", field: "exp_year" as const },
        holder_name: { $paymentHandle: "h2", field: "holder_name" as const },
        // @ts-expect-error — smuggled extra field
        secretRoutingNumber: "111000025",
      },
    };
    const redacted = JSON.stringify(redactHandle(handle as never));
    expect(redacted).not.toContain("secretRoutingNumber");
    expect(redacted).not.toContain("111000025");
    // The five known sentinel keys should still be present
    expect(redacted).toContain('"pan"');
    expect(redacted).toContain('"cvv"');
    expect(redacted).toContain('"exp_month"');
    expect(redacted).toContain('"exp_year"');
    expect(redacted).toContain('"holder_name"');
  });

  it("returns undefined display when input has no display", () => {
    const handle = {
      id: "h3",
      provider: "mock" as const,
      rail: "virtual_card" as const,
      status: "pending_approval" as const,
    };
    const redacted = redactHandle(handle as never) as Record<string, unknown>;
    expect(redacted["display"]).toBeUndefined();
  });

  it("returns undefined fillSentinels when input has no fillSentinels", () => {
    const handle = {
      id: "h4",
      provider: "mock" as const,
      rail: "virtual_card" as const,
      status: "denied" as const,
    };
    const redacted = redactHandle(handle as never) as Record<string, unknown>;
    expect(redacted["fillSentinels"]).toBeUndefined();
  });

  it("preserves all expected safe fields", () => {
    const handle = {
      id: "h5",
      provider: "stripe-link" as const,
      rail: "virtual_card" as const,
      status: "approved" as const,
      providerRequestId: "req_abc",
      validUntil: "2026-12-31T23:59:59Z",
      display: { brand: "Mastercard", last4: "1234", expMonth: "06", expYear: "2028" },
    };
    const redacted = redactHandle(handle as never) as Record<string, unknown>;
    expect(redacted["id"]).toBe("h5");
    expect(redacted["provider"]).toBe("stripe-link");
    expect(redacted["rail"]).toBe("virtual_card");
    expect(redacted["status"]).toBe("approved");
    expect(redacted["providerRequestId"]).toBe("req_abc");
    expect(redacted["validUntil"]).toBe("2026-12-31T23:59:59Z");
    const display = redacted["display"] as Record<string, unknown>;
    expect(display["brand"]).toBe("Mastercard");
    expect(display["last4"]).toBe("1234");
    expect(display["expMonth"]).toBe("06");
    expect(display["expYear"]).toBe("2028");
  });

  it("strips a smuggled providerSessionToken at the top level", () => {
    const handle = {
      id: "h6",
      provider: "stripe-link" as const,
      rail: "virtual_card" as const,
      status: "approved" as const,
      // @ts-expect-error — smuggled top-level secret
      providerSessionToken: "sess_secret_abc",
    };
    const redacted = JSON.stringify(redactHandle(handle as never));
    expect(redacted).not.toContain("sess_secret_abc");
    expect(redacted).not.toContain("providerSessionToken");
  });
});

// ---------------------------------------------------------------------------
// redactMachinePaymentResult
// ---------------------------------------------------------------------------

describe("redactMachinePaymentResult", () => {
  it("strips a smuggled providerToken on receipt", () => {
    const result = {
      handleId: "slm_x",
      targetUrl: "https://x.example",
      outcome: "settled" as const,
      receipt: {
        receiptId: "rcpt_x",
        issuedAt: "2026-01-01T00:00:00Z",
        statusCode: 200,
        // @ts-expect-error — smuggled
        providerToken: "spt_secret_xyz",
      },
    };
    const redacted = JSON.stringify(redactMachinePaymentResult(result as never));
    expect(redacted).not.toContain("spt_secret_xyz");
    expect(redacted).toContain("rcpt_x");
  });

  it("strips MPP token if accidentally placed at top level", () => {
    const result = {
      handleId: "slm_x",
      targetUrl: "https://x.example",
      outcome: "settled" as const,
      receipt: { receiptId: "rcpt_x", issuedAt: "2026-01-01T00:00:00Z", statusCode: 200 },
      // @ts-expect-error — smuggled at top level
      mppToken: "spt_secret_xyz",
    };
    const redacted = JSON.stringify(redactMachinePaymentResult(result as never));
    expect(redacted).not.toContain("spt_secret_xyz");
    expect(redacted).not.toContain("mppToken");
  });

  it("returns undefined receipt when input has no receipt", () => {
    const result = {
      handleId: "slm_y",
      targetUrl: "https://y.example",
      outcome: "pending" as const,
    };
    const redacted = redactMachinePaymentResult(result as never) as Record<string, unknown>;
    expect(redacted["receipt"]).toBeUndefined();
  });

  it("preserves all expected safe fields in receipt", () => {
    const result = {
      handleId: "slm_z",
      targetUrl: "https://z.example",
      outcome: "failed" as const,
      receipt: { receiptId: "rcpt_z", issuedAt: "2026-06-01T12:00:00Z", statusCode: 402 },
    };
    const redacted = redactMachinePaymentResult(result as never) as Record<string, unknown>;
    expect(redacted["handleId"]).toBe("slm_z");
    expect(redacted["targetUrl"]).toBe("https://z.example");
    expect(redacted["outcome"]).toBe("failed");
    const receipt = redacted["receipt"] as Record<string, unknown>;
    expect(receipt["receiptId"]).toBe("rcpt_z");
    expect(receipt["issuedAt"]).toBe("2026-06-01T12:00:00Z");
    expect(receipt["statusCode"]).toBe(402);
  });

  it("strips a smuggled extra field on receipt", () => {
    const result = {
      handleId: "slm_w",
      targetUrl: "https://w.example",
      outcome: "settled" as const,
      receipt: {
        receiptId: "rcpt_w",
        statusCode: 200,
        // @ts-expect-error — smuggled
        internalLedgerId: "ledger_secret_999",
      },
    };
    const redacted = JSON.stringify(redactMachinePaymentResult(result as never));
    expect(redacted).not.toContain("internalLedgerId");
    expect(redacted).not.toContain("ledger_secret_999");
  });
});
