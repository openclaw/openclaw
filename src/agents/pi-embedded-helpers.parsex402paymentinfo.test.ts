import { describe, expect, it } from "vitest";
import { parseX402PaymentInfo, formatBillingErrorMessage } from "./pi-embedded-helpers.js";

describe("parseX402PaymentInfo", () => {
  it("returns null for empty or non-JSON input", () => {
    expect(parseX402PaymentInfo("")).toBeNull();
    expect(parseX402PaymentInfo("some plain error")).toBeNull();
    expect(parseX402PaymentInfo("402 Payment Required")).toBeNull();
  });

  it("extracts topup URL from error body", () => {
    const raw = '402 {"error": "Credits exhausted", "topup": "https://example.com/billing"}';
    const info = parseX402PaymentInfo(raw);
    expect(info).not.toBeNull();
    expect(info?.topupUrl).toBe("https://example.com/billing");
  });

  it("extracts top_up URL (underscore variant)", () => {
    const raw = '{"error": "Budget exceeded", "top_up": "https://example.com/billing"}';
    const info = parseX402PaymentInfo(raw);
    expect(info?.topupUrl).toBe("https://example.com/billing");
  });

  it("extracts balance from error body", () => {
    const raw = JSON.stringify({
      error: "Credits exhausted",
      balance: { budgetLimit: 20, budgetUsed: 20, remaining: 0 },
      topup: "https://example.com/billing",
    });
    const info = parseX402PaymentInfo(raw);
    expect(info?.balance?.budgetLimit).toBe(20);
    expect(info?.balance?.budgetUsed).toBe(20);
    expect(info?.balance?.remaining).toBe(0);
    expect(info?.topupUrl).toBe("https://example.com/billing");
  });

  it("extracts from x402 accepts array", () => {
    const raw = JSON.stringify({
      error: "Payment required",
      accepts: [
        {
          scheme: "fiat-redirect",
          network: "stripe",
          amount: "500",
          payTo: "https://example.com/billing",
          extra: { topupUrl: "https://example.com/billing" },
        },
      ],
    });
    const info = parseX402PaymentInfo(raw);
    expect(info?.scheme).toBe("fiat-redirect");
    expect(info?.minAmountCents).toBe(500);
    expect(info?.topupUrl).toBe("https://example.com/billing");
  });

  it("handles HTTP status code prefix", () => {
    const raw = `402 ${JSON.stringify({
      error: "Insufficient balance",
      topup: "https://example.com/topup",
      balance: { remaining: 0.5 },
    })}`;
    const info = parseX402PaymentInfo(raw);
    expect(info?.topupUrl).toBe("https://example.com/topup");
    expect(info?.balance?.remaining).toBe(0.5);
  });

  it("returns null when JSON has no payment-related fields", () => {
    const raw = '{"error": "something else", "code": "invalid_request"}';
    expect(parseX402PaymentInfo(raw)).toBeNull();
  });

  it("ignores non-URL topup values", () => {
    const raw = '{"topup": "not-a-url"}';
    expect(parseX402PaymentInfo(raw)).toBeNull();
  });
});

describe("formatBillingErrorMessage", () => {
  it("returns generic message when no payment info", () => {
    const msg = formatBillingErrorMessage(null);
    expect(msg).toContain("API provider returned a billing error");
  });

  it("includes balance and topup URL when available", () => {
    const msg = formatBillingErrorMessage({
      topupUrl: "https://example.com/billing",
      balance: { remaining: 0, budgetLimit: 20 },
    });
    expect(msg).toContain("$0.00 of $20.00");
    expect(msg).toContain("https://example.com/billing");
  });

  it("includes only remaining when budgetLimit is absent", () => {
    const msg = formatBillingErrorMessage({
      balance: { remaining: 1.5 },
    });
    expect(msg).toContain("$1.50 remaining");
    expect(msg).not.toContain("of $");
  });

  it("includes topup URL without balance", () => {
    const msg = formatBillingErrorMessage({
      topupUrl: "https://example.com/billing",
    });
    expect(msg).toContain("https://example.com/billing");
    expect(msg).toContain("Credits exhausted");
  });
});
