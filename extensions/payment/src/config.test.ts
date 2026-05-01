import { describe, expect, it } from "vitest";
import { defaultPaymentConfig, parsePaymentConfig } from "./config.js";

describe("parsePaymentConfig — defaults and round-trip", () => {
  it("parses the default config and round-trips it", () => {
    const defaults = defaultPaymentConfig();
    const parsed = parsePaymentConfig(defaults);
    expect(parsed).toEqual(defaults);
  });

  it("defaults enabled to false, provider to mock, currency to usd", () => {
    const parsed = parsePaymentConfig({ provider: "mock" });
    expect(parsed.enabled).toBe(false);
    expect(parsed.provider).toBe("mock");
    expect(parsed.defaultCurrency).toBe("usd");
    expect(parsed.store).toBe("~/.openclaw/payments");
  });

  it("parses stripe-link provider with explicit values", () => {
    const parsed = parsePaymentConfig({
      provider: "stripe-link",
      enabled: true,
      providers: {
        "stripe-link": {
          command: "link-cli",
          clientName: "OpenClaw",
          testMode: true,
          maxAmountCents: 10000,
        },
        mock: {},
      },
    });
    expect(parsed.provider).toBe("stripe-link");
    expect(parsed.enabled).toBe(true);
    expect(parsed.providers["stripe-link"].maxAmountCents).toBe(10000);
    expect(parsed.providers["stripe-link"].testMode).toBe(true);
  });

  it("throws ZodError on invalid config — message mentions offending field", () => {
    expect(() => parsePaymentConfig({ provider: "mock", enabled: "not-a-bool" })).toThrowError(
      /enabled/,
    );
  });
});

describe("parsePaymentConfig — strict rejection of unknown providers", () => {
  it('rejects provider "ramp" with an error mentioning the field', () => {
    let errorMessage = "";
    try {
      parsePaymentConfig({ provider: "ramp" });
    } catch (err: unknown) {
      errorMessage = String(err);
    }
    expect(errorMessage).not.toBe("");
    // Should mention provider or the invalid option
    expect(errorMessage.toLowerCase()).toMatch(/provider|ramp|invalid/);
  });

  it('rejects provider "mercury" with an error mentioning the field', () => {
    let errorMessage = "";
    try {
      parsePaymentConfig({ provider: "mercury" });
    } catch (err: unknown) {
      errorMessage = String(err);
    }
    expect(errorMessage).not.toBe("");
    expect(errorMessage.toLowerCase()).toMatch(/provider|mercury|invalid/);
  });
});

describe("parsePaymentConfig — maxAmountCents enforcement", () => {
  function buildConfig(maxAmountCents: unknown) {
    return {
      provider: "stripe-link",
      providers: {
        "stripe-link": { maxAmountCents },
        mock: {},
      },
    };
  }

  it("rejects maxAmountCents = 0", () => {
    expect(() => parsePaymentConfig(buildConfig(0))).toThrow();
  });

  it("rejects maxAmountCents = -1", () => {
    expect(() => parsePaymentConfig(buildConfig(-1))).toThrow();
  });

  it("rejects non-integer maxAmountCents (e.g. 99.99)", () => {
    expect(() => parsePaymentConfig(buildConfig(99.99))).toThrow();
  });

  it("accepts maxAmountCents = 50000 (Stripe cap default)", () => {
    expect(() => parsePaymentConfig({ provider: "stripe-link" })).not.toThrow();
    const parsed = parsePaymentConfig({ provider: "stripe-link" });
    expect(parsed.providers["stripe-link"].maxAmountCents).toBe(50000);
  });

  it("accepts maxAmountCents = 1", () => {
    const parsed = parsePaymentConfig(buildConfig(1));
    expect(parsed.providers["stripe-link"].maxAmountCents).toBe(1);
  });

  it("rejects unknown top-level keys (.strict() semantics)", () => {
    expect(() => parsePaymentConfig({ provider: "mock", unknownKey: true })).toThrow();
  });
});
