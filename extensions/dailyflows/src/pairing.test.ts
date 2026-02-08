import { describe, expect, it } from "vitest";
import {
  consumeDailyflowsPairing,
  createDailyflowsPairing,
  normalizeGatewayUrl,
} from "./pairing.js";

describe("dailyflows pairing", () => {
  it("normalizes https gateway urls", () => {
    expect(normalizeGatewayUrl("https://example.com/")).toBe("https://example.com");
  });

  it("rejects non-https public urls", () => {
    expect(normalizeGatewayUrl("http://example.com")).toBeNull();
  });

  it("creates and consumes pairing entries", () => {
    const pairing = createDailyflowsPairing({
      gatewayUrl: "https://example.com",
      accountId: "default",
    });
    const consumed = consumeDailyflowsPairing(pairing.pairCode);
    expect(consumed?.pairCode).toBe(pairing.pairCode);
    expect(consumed?.payload).toContain("openclaw.dailyflows.pair");
  });
});
