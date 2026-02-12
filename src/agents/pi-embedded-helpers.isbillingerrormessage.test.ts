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
  it("does not false-positive on chat content mentioning '402'", () => {
    expect(isBillingErrorMessage("the x402 protocol uses HTTP 402 status codes")).toBe(false);
    expect(isBillingErrorMessage("error code 402 returned from the endpoint")).toBe(false);
    expect(isBillingErrorMessage("402 results found")).toBe(false);
  });
});
