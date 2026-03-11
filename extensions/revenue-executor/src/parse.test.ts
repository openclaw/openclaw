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

  it("extracts trailing email without polluting the contact name", () => {
    const result = parseRevenueCommand({
      command: "Create $97 AI automation course for John Smith john@test.com",
    });

    expect(result.contactName).toBe("John Smith");
    expect(result.email).toBe("john@test.com");
    expect(result.productType).toBe("Ai Automation Course");
    expect(result.price).toBe(97);
  });

  it("falls back to zero when price is missing", () => {
    const result = parseRevenueCommand({ command: "sell coaching to john smith" });

    expect(result.price).toBe(0);
    expect(result.contactName).toBe("John Smith");
  });
});
