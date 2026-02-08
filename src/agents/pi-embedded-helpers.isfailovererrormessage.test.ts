import { describe, expect, it } from "vitest";
import { isFailoverErrorMessage } from "./pi-embedded-helpers.js";
import { DEFAULT_AGENTS_FILENAME } from "./workspace.js";

const _makeFile = (overrides: Partial<WorkspaceBootstrapFile>): WorkspaceBootstrapFile => ({
  name: DEFAULT_AGENTS_FILENAME,
  path: "/tmp/AGENTS.md",
  content: "",
  missing: false,
  ...overrides,
});
describe("isFailoverErrorMessage", () => {
  it("matches auth/rate/billing/timeout", () => {
    const samples = [
      "invalid api key",
      "429 rate limit exceeded",
      "Your credit balance is too low",
      "request timed out",
      "invalid request format",
    ];
    for (const sample of samples) {
      expect(isFailoverErrorMessage(sample)).toBe(true);
    }
  });

  it("matches not_found messages", () => {
    const samples = [
      "Requested entity was not found.",
      "Cloud Code Assist API error (404): Requested entity was not found.",
      "model not found",
      "resource not found",
    ];
    for (const sample of samples) {
      expect(isFailoverErrorMessage(sample)).toBe(true);
    }
  });

  it("does not match false-positive not found messages", () => {
    const falsePositives = ["file not found: /etc/config.json", "module not found: @some/package"];
    for (const sample of falsePositives) {
      expect(isFailoverErrorMessage(sample)).toBe(false);
    }
  });
});
