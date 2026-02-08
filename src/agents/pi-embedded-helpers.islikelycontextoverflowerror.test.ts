import { describe, expect, it } from "vitest";
import { isLikelyContextOverflowError } from "./pi-embedded-helpers.js";
import { DEFAULT_AGENTS_FILENAME } from "./workspace.js";

const _makeFile = (overrides: Partial<WorkspaceBootstrapFile>): WorkspaceBootstrapFile => ({
  name: DEFAULT_AGENTS_FILENAME,
  path: "/tmp/AGENTS.md",
  content: "",
  missing: false,
  ...overrides,
});

describe("isLikelyContextOverflowError", () => {
  it("matches context overflow hints", () => {
    const samples = [
      "Model context window is 128k tokens, you requested 256k tokens",
      "Context window exceeded: requested 12000 tokens",
      "Prompt too large for this model",
    ];
    for (const sample of samples) {
      expect(isLikelyContextOverflowError(sample)).toBe(true);
    }
  });

  it("excludes context window too small errors", () => {
    const samples = [
      "Model context window too small (minimum is 128k tokens)",
      "Context window too small: minimum is 1000 tokens",
    ];
    for (const sample of samples) {
      expect(isLikelyContextOverflowError(sample)).toBe(false);
    }
  });

  it("excludes incidental 'context' phrases (fix for #8847)", () => {
    // These should NOT trigger context overflow detection
    const falsePositives = [
      "Processing in context of search results",
      "For context, here's the error message",
      "In the context of this operation",
      "Additional context: memory allocation failed",
      "Providing context for the request",
    ];
    for (const sample of falsePositives) {
      expect(isLikelyContextOverflowError(sample)).toBe(false);
    }
  });
});
