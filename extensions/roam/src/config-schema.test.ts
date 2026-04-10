import { describe, expect, it } from "vitest";
import { RoamConfigSchema } from "./config-schema.js";

describe("RoamConfigSchema", () => {
  it("accepts apiBaseUrl", () => {
    const result = RoamConfigSchema.safeParse({ apiBaseUrl: "https://api.roam.dev" });
    expect(result.success).toBe(true);
  });

  it("accepts webhookUrl", () => {
    const result = RoamConfigSchema.safeParse({
      webhookUrl: "https://example.com/roam-webhook",
    });
    expect(result.success).toBe(true);
  });

  it("accepts both apiBaseUrl and webhookUrl together", () => {
    const result = RoamConfigSchema.safeParse({
      apiBaseUrl: "https://api.roam.dev",
      webhookUrl: "https://example.com/roam-webhook",
    });
    expect(result.success).toBe(true);
  });

  it("rejects unknown fields", () => {
    const result = RoamConfigSchema.safeParse({ bogusField: "nope" });
    expect(result.success).toBe(false);
  });
});
