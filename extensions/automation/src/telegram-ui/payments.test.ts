import { afterEach, describe, expect, it, vi } from "vitest";
import { createSubscriptionInvoice, getProFeatures } from "./payments.js";

describe("telegram-ui payments", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns invoice link when telegram API responds successfully", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, result: "https://t.me/invoice/abc" }),
    } as Response);
    await expect(createSubscriptionInvoice("bot-token")).resolves.toBe("https://t.me/invoice/abc");
  });

  it("throws when bot token is empty", async () => {
    await expect(createSubscriptionInvoice("  ")).rejects.toThrow("telegram bot token is required");
  });

  it("throws when http response is not ok", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({}),
    } as Response);
    await expect(createSubscriptionInvoice("bot-token")).rejects.toThrow(
      "telegram invoice request failed: 500",
    );
  });

  it("throws when telegram API returns failure payload", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({ ok: false, description: "bad request" }),
    } as Response);
    await expect(createSubscriptionInvoice("bot-token")).rejects.toThrow(
      "telegram invoice creation failed: bad request",
    );
  });

  it("throws when telegram API returns invalid json", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => {
        throw new Error("bad json");
      },
    } as Response);
    await expect(createSubscriptionInvoice("bot-token")).rejects.toThrow(
      "telegram invoice response is not valid json",
    );
  });

  it("throws unknown reason when result payload is not a valid link", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, result: 123 }),
    } as Response);
    await expect(createSubscriptionInvoice("bot-token")).rejects.toThrow(
      "telegram invoice creation failed: unknown",
    );
  });

  it("enables all features for pro users", () => {
    expect(getProFeatures(true)).toEqual({
      multiAgent: true,
      workflowEditor: true,
      devOpsIntegration: true,
      priorityExecution: true,
      customWorkflows: true,
      unlimitedCron: true,
    });
  });

  it("disables all features for non-pro users", () => {
    expect(getProFeatures(false)).toEqual({
      multiAgent: false,
      workflowEditor: false,
      devOpsIntegration: false,
      priorityExecution: false,
      customWorkflows: false,
      unlimitedCron: false,
    });
  });
});
