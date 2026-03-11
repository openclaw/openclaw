import { describe, expect, it } from "vitest";
import { parseRevenueCommand } from "./parse.js";

describe("parseRevenueCommand", () => {
  it("parses contact, product, and price from command", () => {
    const result = parseRevenueCommand({
      command: "sell coaching program $47 for john smith",
    });

    expect(result.contactName).toBe("John Smith");
    expect(result.productType).toBe("Coaching Program");
    expect(result.price).toBe(47);
    expect(result.opportunityName).toBe("Coaching Program - $47");
  });

  it("uses explicit overrides", () => {
    const result = parseRevenueCommand({
      command: "charge $120",
      contactName: "Jane Doe",
      productType: "VIP Session",
      price: 99,
    });

    expect(result.contactName).toBe("Jane Doe");
    expect(result.productType).toBe("VIP Session");
    expect(result.price).toBe(99);
  });

  it("throws when price is missing", () => {
    expect(() =>
      parseRevenueCommand({ command: "sell coaching to john smith" }),
    ).toThrow(/parse price/i);
  });
});
