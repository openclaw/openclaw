import { describe, expect, it } from "vitest";
import { isBillingErrorMessage } from "./pi-embedded-helpers.js";
import { DEFAULT_AGENTS_FILENAME } from "./workspace.js";

const _makeFile = (overrides: Partial<WorkspaceBootstrapFile>): WorkspaceBootstrapFile => ({
  name: DEFAULT_AGENTS_FILENAME,
  path: "/tmp/AGENTS.md",
  content: "",
  missing: false,
  ...overrides,
});
describe("isBillingErrorMessage", () => {
  it("matches credit / payment failures", () => {
    const samples = [
      "Your credit balance is too low to access the Anthropic API.",
      "insufficient credits",
      "Payment Required",
      "HTTP 402 Payment Required",
      "plans & billing",
      "billing: please upgrade your plan",
    ];
    for (const sample of samples) {
      expect(isBillingErrorMessage(sample)).toBe(true);
    }
  });
  it("ignores unrelated errors", () => {
    expect(isBillingErrorMessage("rate limit exceeded")).toBe(false);
    expect(isBillingErrorMessage("invalid api key")).toBe(false);
    expect(isBillingErrorMessage("context length exceeded")).toBe(false);
  });

  it("does not match 402 in dollar amounts", () => {
    expect(isBillingErrorMessage("Your total spend is $402.55 this month.")).toBe(false);
  });

  it("does not false-positive on multi-sentence assistant prose about billing", () => {
    const longBillingProse =
      "Here's how to set up Stripe billing for your SaaS application. " +
      "First, create a product and pricing plan in the Stripe dashboard. " +
      "Then integrate the checkout session to collect payment from your customers.";
    expect(isBillingErrorMessage(longBillingProse)).toBe(false);
  });
});
